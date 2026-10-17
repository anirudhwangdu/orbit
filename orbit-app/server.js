// Orbit server: serves the console and customer app, plus AI, web search and a multi-agent debate.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Load keys from .env (works on Windows too; no need for `set` commands).
try {
  for (const l of fs.readFileSync(path.join(dir, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file: fall back to real environment variables */ }

const key = n => (process.env[n] || '').trim();
const LLM = process.env.LLM_PROVIDER || 'gemini';
let PROVIDER = process.env.SEARCH_PROVIDER || 'tavily';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
if (LLM !== 'claude' && PROVIDER === 'claude') { console.warn('SEARCH_PROVIDER=claude needs LLM_PROVIDER=claude. Using tavily.'); PROVIDER = 'tavily'; }

const app = express();
app.use(express.json());
const wait = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- Model: Gemini (free tier) or Claude ---------------------------------
const GEMINI_MODELS = [GEMINI_MODEL, ...(process.env.GEMINI_FALLBACKS || 'gemini-3.5-flash-lite').split(',').map(x => x.trim()).filter(Boolean)];
async function gemini(prompt) {
  if (!key('GEMINI_API_KEY')) throw new Error('GEMINI_API_KEY is missing (put it in .env)');
  let lastErr;
  for (const model of GEMINI_MODELS) {                       // main model first, then fallbacks
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key('GEMINI_API_KEY') },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } }),
      });
      if (r.status === 404) { lastErr = new Error(`Gemini model "${model}" not found`); break; }   // skip to next model
      if (r.status === 429 || r.status >= 500) {                                                    // busy or rate limited: retry
        lastErr = new Error(`Gemini ${r.status} on ${model}`);
        log(`Gemini ${r.status} on ${model}, attempt ${attempt + 1} of 3`);
        if (attempt < 2) await wait(2500 * (attempt + 1));
        continue;
      }
      if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = await r.json(), c = j.candidates?.[0];
      const text = (c?.content?.parts || []).map(p => p.text || '').join('');
      if (!text) throw new Error('Gemini returned no text (reason: ' + (c?.finishReason || j.promptFeedback?.blockReason || 'unknown') + ')');
      if (model !== GEMINI_MODEL) log(`Answered by fallback model ${model}`);
      return text;
    }
  }
  throw new Error((lastErr?.message || 'Gemini failed') + '. Google is busy or the free limit is hit. Try again in a minute.');
}

// ---- Backup model: any OpenAI-compatible provider (Cerebras, Mistral, OpenRouter, Groq...) ----
const BK = (() => {
  if (key('BACKUP_API_KEY')) return { name: 'backup', url: (process.env.BACKUP_BASE_URL || '').trim().replace(/\/$/, ''), key: key('BACKUP_API_KEY'), model: (process.env.BACKUP_MODEL || '').trim() };
  if (key('GROQ_API_KEY')) return { name: 'groq', url: 'https://api.groq.com/openai/v1', key: key('GROQ_API_KEY'), model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b' };
  return null;
})();
async function backup(prompt) {
  if (!BK) throw new Error('No backup configured (set BACKUP_BASE_URL, BACKUP_API_KEY and BACKUP_MODEL in .env)');
  if (!BK.url || !BK.model) throw new Error('BACKUP_BASE_URL and BACKUP_MODEL are required in .env');
  const send = extras => fetch(BK.url + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BK.key },
    body: JSON.stringify({
      model: BK.model, messages: [{ role: 'user', content: prompt }],
      ...(extras ? { response_format: { type: 'json_object' }, ...(/gpt-oss/.test(BK.model) ? { reasoning_effort: 'low' } : {}) } : {}),
    }),
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    let r = await send(true);
    if (r.status === 400 || r.status === 422) r = await send(false);      // some models reject JSON mode: retry plain
    if (r.status === 429 || r.status >= 500) {
      log(`Backup ${r.status}, attempt ${attempt + 1} of 3`);
      if (attempt < 2) { await wait(2500 * (attempt + 1)); continue; }
      throw new Error(`Backup ${r.status}: busy or rate limited`);
    }
    if (!r.ok) throw new Error(`Backup ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Backup returned no text');
    return text;
  }
}

let claude;
async function callClaude(prompt, search) {
  claude ??= new (await import('@anthropic-ai/sdk')).default();
  const messages = [{ role: 'user', content: prompt }];
  const tools = search ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] : undefined;
  let r;
  for (let i = 0; i < 4; i++) {
    r = await claude.messages.create({ model: 'claude-sonnet-5-5', max_tokens: 2000, messages, tools });
    if (r.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: r.content });
  }
  return r.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// Try providers in order; if the first is busy or down, the next one answers.
const ORDER = LLM === 'backup' ? ['backup', 'gemini'] : ['gemini', 'backup'];
let lastProvider = '';
const hasKey = p => (p === 'gemini' ? !!key('GEMINI_API_KEY') : !!BK);
const cool = {};                                              // provider -> time until we skip it after a failure
const cooling = p => (cool[p] || 0) > Date.now();
async function callFree(prompt) {
  const errs = [];
  for (const p of ORDER) {
    if (!hasKey(p)) continue;
    // Skip a provider that just failed, as long as another one is available (saves waiting on retries).
    if (cooling(p) && ORDER.some(q => q !== p && hasKey(q) && !cooling(q))) continue;
    try {
      const text = await (p === 'gemini' ? gemini : backup)(prompt);
      cool[p] = 0;
      if (p !== ORDER[0]) log('Answered by backup provider: ' + p);
      lastProvider = p === 'backup' ? BK.name : p;
      return text;
    } catch (e) { cool[p] = Date.now() + 120000; errs.push(`${p}: ${e.message}`); log(`${p} failed, skipping it for 2 minutes`); }
  }
  throw new Error(errs.join(' | ') || 'No AI key set (add GEMINI_API_KEY and/or a backup to .env)');
}
const call = (prompt, search = false) => (LLM === 'claude' ? callClaude(prompt, search) : callFree(prompt));
const J = t => {
  const m = String(t).replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Model did not return JSON: ' + String(t).slice(0, 120));
  return JSON.parse(m[0]);
};

// ---- Search: Tavily --------------------------------------------------------
async function tavily(query) {
  if (!key('TAVILY_API_KEY')) throw new Error('TAVILY_API_KEY is missing (put it in .env)');
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key('TAVILY_API_KEY') },
    body: JSON.stringify({ query: query.slice(0, 350), search_depth: 'basic', max_results: 5 }),
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const out = (j.results || []).map(x => ({ title: x.title, url: x.url, content: (x.content || '').slice(0, 700) }));
  log(`Tavily: ${out.length} results for "${query.slice(0, 50)}"`);
  return out;
}

// ---- Routes ------------------------------------------------------------------
app.get('/', (_, res) => res.sendFile(path.join(dir, 'public', 'ops.html')));
app.get('/client', (_, res) => res.sendFile(path.join(dir, 'public', 'client.html')));

app.get('/api/health', (_, res) => res.json({
  llm: LLM, order: LLM === 'claude' ? ['claude'] : ORDER, models: { gemini: GEMINI_MODEL, backup: BK ? BK.model : null }, search: PROVIDER,
  geminiKey: !!key('GEMINI_API_KEY'), backupConfigured: !!BK, tavilyKey: !!key('TAVILY_API_KEY'), anthropicKey: !!key('ANTHROPIC_API_KEY'),
}));

// Test each piece on its own, in the browser:
app.get('/api/search-test', async (req, res) => {
  try { res.json(await tavily(req.query.q || 'pediatric dentist San Mateo')); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
app.get('/api/llm-test', async (_, res) => {
  try { const out = J(await call('Return ONLY JSON {"ok":true,"say":"hello"}')); res.json({ ...out, provider: lastProvider }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/ai', async (req, res) => {
  try { res.json({ text: await call(req.body.prompt, false) }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ---- Debate: scouts propose in parallel -> critic attacks -> judge scores and decides ----
const LENSES = ['lowest total cost', 'best quality and reviews', 'best fit for every stated constraint (timing, location, preferences)'];
const SCHEMA = ['Price', 'Timing / availability', 'Key detail', 'Distance or rating'];

async function runDebate(raw, asks = []) {
  const need = asks.join('; ');
  log('Debate started:', String(raw).slice(0, 70));
  const settled = await Promise.allSettled(LENSES.map(async (lens, i) => {
    await wait(i * 800);                                    // stagger scouts so they do not hit the model at once
    const task = `You are a research agent optimizing for: ${lens}. Request: ${raw}. Must satisfy: ${need}.
Return ONLY JSON {"pick":{"name":string,"fields":[4 short strings: price, timing or availability, key detail, distance or rating; write "unknown" if the evidence does not say],"why":max 25 words},"sources":[urls]}`;
    if (PROVIDER === 'claude') return { ...J(await call(task + '\nUse web search.', true)), lens };
    const evidence = await tavily(`${raw} (${lens})`);
    return { ...J(await call(task + `\nUse ONLY this search evidence. Never invent prices or facts; sources must be URLs from it.\nEvidence: ${JSON.stringify(evidence)}`)), lens };
  }));
  const ok = settled.filter(x => x.status === 'fulfilled').map(x => x.value);
  const failed = settled.filter(x => x.status === 'rejected');
  failed.forEach(x => console.error('Scout failed:', x.reason));
  if (!ok.length) throw failed[0].reason;
  const seen = new Set(), scouts = [];
  ok.forEach(x => { const k = String(x.pick.name).toLowerCase().trim(); if (!seen.has(k)) { seen.add(k); scouts.push(x); } });
  const transcript = ok.map(x => ({ role: 'Scout: ' + x.lens, text: `${x.pick.name}. ${x.pick.why}` }));
  if (failed.length) transcript.push({ role: 'Note', text: `${failed.length} scout(s) failed: ${failed[0].reason.message}` });
  const picks = scouts.map(x => x.pick);

  const critic = J(await call(
    `You are a critic. Challenge these picks against the request. Flag any that break a hard constraint or rest on unverified claims.
Request: ${raw}. Constraints: ${need}. Picks: ${JSON.stringify(picks)}
Return ONLY JSON {"objections":[{"pick":string,"issue":max 20 words}]}`));
  transcript.push({ role: 'Critic', text: (critic.objections || []).map(o => `${o.pick}: ${o.issue}`).join(' | ') || 'No objections.' });

  const v = J(await call(
    `You are the judge. Score each pick 0-100 on cost, quality and fit to this customer, then choose the single best. Weigh the critic's objections; a broken hard constraint disqualifies a pick.
Request: ${raw}. Constraints: ${need}. Picks (index order): ${JSON.stringify(picks)}. Objections: ${JSON.stringify(critic.objections || [])}
Return ONLY JSON {"winner":index of the best pick (number),"scores":[[cost,quality,fit] for each pick in the same order],"confidence":number 0-100,"answer":max 45 words, crisp, no greeting,"reason":max 25 words}`));
  const win = Math.min(Math.max(+v.winner || 0, 0), picks.length - 1);
  const scores = picks.map((_, i) => (v.scores && v.scores[i] && v.scores[i].length === 3 ? v.scores[i].map(n => Math.round(+n || 0)) : [70, 70, 70]));
  transcript.push({ role: 'Judge', text: `${picks[win].name}. ${v.reason} (${Math.round(+v.confidence || 0)}% confidence)` });
  log('Debate done:', picks[win].name);
  return {
    options: picks.map(p => ({ name: p.name, fields: p.fields, why: p.why })), scores, winner: win,
    confidence: Math.round(+v.confidence || 70), reason: v.reason, answer: v.answer, transcript,
    sources: [...new Set(scouts.flatMap(x => x.sources || []))],
  };
}

app.post('/api/debate', async (req, res) => {
  try { res.json({ ...(await runDebate(req.body.raw, req.body.asks || [])), search: PROVIDER }); }
  catch (e) { console.error('Debate failed:', e); res.status(500).json({ error: e.message }); }
});

// ---- Shared task store (saved to data/tasks.json) so the customer app and manager console see the same tasks ----
const DATA = path.join(dir, 'data'), FILE = path.join(DATA, 'tasks.json');
let db = { tasks: [], nextId: 1, profile: { area: 'San Mateo, CA', kids: 'Maya 7, Leo 4', prefs: 'Weekday mornings', insurance: 'Delta Dental' } };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* first run */ }
db.tasks.forEach(t => { if (t.status === 'working' || t.status === 'research') { t.status = 'error'; t.draft = 'Interrupted by a restart. Please send it again.'; t.busy = false; } });
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(db)); } catch (e) { console.error('Save failed:', e.message); } }, 300); };
const getT = id => db.tasks.find(t => t.id === +id);
const tr = (t, tag, text) => t.trace.push([tag, text]);
const say = (t, from, text) => t.thread.push({ from, text });
const prof = () => Object.entries(db.profile).filter(e => e[1]).map(e => e[0] + ': ' + e[1]).join('; ') || 'none';
const CAT_NAMES = ['Bookings', 'Calendar', 'Camps', 'Checklists', 'Classes', 'Family Activities', 'Follow-ups', 'Forms/Applications', 'Hotels', 'Itinerary', 'Meal Planning', 'Parent', 'Postings', 'Products', 'Purchases', 'Reminder', 'Restaurants', 'SP - Auto', 'SP - Health', 'SP - Home', 'SP - Inquiry', 'SP - Other', 'SP - Pets', 'Team Task', 'Tracker', 'Travel Transportation', 'SP - Events'];
const SAFETY = 'If the request hints at a medical emergency (heavy or non-stopping bleeding, chest pain, trouble breathing, severe injury), the answer must begin with: If this is an emergency, call your local emergency number now. Then continue normally.';

function fail(t, e) {
  console.error('Task ' + t.id + ' failed:', e);
  t.status = 'error'; t.busy = false; t.draft = 'I hit a problem: ' + e.message; t.hand = 'There was a problem. Please try again.';
  say(t, 'ai', 'There was a problem on my side. Please send that again.'); tr(t, 'R', 'Failed: ' + e.message);
}

async function intake(t) {
  try {
    const r = J(await call(`You are the first responder for a family concierge service. AI does all research; people only make calls and book appointments. Known family profile (never ask for it): ${prof()}.
Return ONLY JSON with keys: title (max 7 words), category (exactly one of: ${CAT_NAMES.join(', ')}), asks (2-4 short strings), missing (essential details NOT stated and not in the profile; empty array if none), mode ("answer" if you can fully answer from general knowledge, "ask" if an essential detail is missing, "research" if it needs live web data such as prices, availability or local providers), answer (max 45 words, crisp, no greeting, no filler. mode answer: the actual answer. mode ask: one question covering all missing details. mode research: one line saying what you will compare and what the customer gets), delivery ("inline" unless a comparison table or multi-task project is needed, then "doc"), human_step (null, or {type:"Call"|"Appointment", desc:short string}), reason (one sentence on the category). ${SAFETY}

Request: ${t.raw}`));
    const m = r.missing || [], mode = m.length && r.mode !== 'answer' ? 'ask' : r.mode;
    Object.assign(t, { title: r.title || t.title, cat: CAT_NAMES.includes(r.category) ? r.category : 'SP - Other', asks: r.asks || [], missing: mode === 'ask' ? (m.length ? m : ['detail']) : [], question: mode === 'ask' ? r.answer : '', draft: r.answer || '', delivery: r.delivery || 'inline', notes: ['Category: ' + r.category + '. ' + (r.reason || '')] });
    if (!t.tta) t.tta = Math.max(1, Math.round((Date.now() - t.created) / 1000));
    if (r.human_step && !t.human) t.human = { type: r.human_step.type, desc: r.human_step.desc, state: 'locked', who: '' };
    say(t, 'ai', r.answer || 'Got it.'); tr(t, 'L', `Claude chose "${t.cat}" and split the request into ${t.asks.length} asks`); tr(t, 'L', 'Mode: ' + mode);
    if (mode === 'ask') { t.status = 'asked'; tr(t, 'R', 'Customer asked immediately'); }
    else if (mode === 'answer') { t.status = 'answered'; t.hand = 'Answered. Reply here if you need more.'; tr(t, 'R', 'Answer sent to customer'); }
    else { t.status = 'research'; save(); await research(t); }
  } catch (e) { fail(t, e); }
  save();
}

async function research(t) {
  t.status = 'research'; save();
  try {
    const d = await runDebate(t.raw, t.asks);
    Object.assign(t, { options: d.options, schema: SCHEMA, scores: d.scores, win: d.winner, conf: d.confidence, reason: d.reason, sources: d.sources, transcript: d.transcript, draft: d.answer, status: 'answered', runs: (t.runs || 0) + 1, pick: null });
    t.hand = t.human ? 'A team member will ' + String(t.human.desc || 'follow up').toLowerCase() + '.' : 'Handled. No call needed.';
    say(t, 'ai', d.answer); tr(t, 'L', `Agent debate: ${d.options.length} options, critic, judge (${d.confidence}% confidence)`); tr(t, 'R', 'Answer sent to customer');
  } catch (e) { fail(t, e); }
}

app.get('/api/profile', (_, res) => res.json(db.profile));
app.put('/api/profile', (req, res) => { for (const k of ['area', 'kids', 'prefs', 'insurance']) if (typeof req.body[k] === 'string') db.profile[k] = req.body[k].slice(0, 120); save(); res.json(db.profile); });
app.get('/api/tasks', (_, res) => res.json([...db.tasks].reverse()));

app.post('/api/tasks', (req, res) => {
  const text = String(req.body.text || '').trim().slice(0, 1500);
  if (!text) return res.status(400).json({ error: 'Empty request' });
  const t = { id: db.nextId++, title: text.slice(0, 48), cat: 'Other', raw: text, status: 'working', created: Date.now(), tta: 0, asks: [], missing: [], question: '', draft: '', delivery: 'inline', options: null, schema: SCHEMA, scores: null, win: null, conf: null, reason: '', sources: [], transcript: [], thread: [{ from: 'me', text }], trace: [['R', 'Request arrived, AI started automatically']], notes: [], hist: [], human: null, pick: null, runs: 0, turns: 1, alert: '', busy: false, hand: '' };
  db.tasks.push(t); save(); intake(t); res.json(t);
});

app.post('/api/tasks/:id/message', async (req, res) => {
  const t = getT(req.params.id); if (!t) return res.status(404).json({ error: 'No such task' });
  const text = String(req.body.text || '').trim().slice(0, 1000); if (!text) return res.status(400).json({ error: 'Empty message' });
  say(t, 'me', text); t.turns = (t.turns || 1) + 1; tr(t, 'R', 'Customer replied: ' + text.slice(0, 80));
  if (t.status === 'asked' || t.status === 'error') { t.raw += ' Customer added: ' + text; t.missing = []; t.status = 'working'; save(); intake(t); return res.json(t); }
  t.busy = true; save(); res.json(t);
  try {
    const cur = t.options && t.pick != null ? t.options[t.pick].name : (t.options && t.win != null ? t.options[t.win].name : 'none');
    const r = J(await call(`You are a concierge assistant. Asks: ${t.asks.join('; ')}. Current pick: ${cur}. Recent chat:\n${t.thread.slice(-6).map(m => (m.from === 'me' ? 'Customer: ' : 'Assistant: ') + m.text).join('\n')}\nReturn ONLY JSON {"answer": max 40 words, crisp, no greeting, "changes_request": true only if the customer changed or added facts that need new research}. ${SAFETY}`));
    say(t, 'ai', r.answer || 'Noted.');
    if (r.changes_request) {
      if (t.status === 'approved' || t.status === 'changed') { t.alert = 'Customer changed facts after approval: ' + text.slice(0, 80); tr(t, 'R', 'ALERT: ' + t.alert); }
      else { t.raw += ' Update: ' + text; tr(t, 'L', 'Customer changed the facts, re-researching'); t.busy = false; await research(t); }
    }
  } catch (e) { say(t, 'ai', 'Sorry, I could not process that. Please try again.'); tr(t, 'R', 'Chat failed: ' + e.message); }
  t.busy = false; save();
});

const pickOpt = (req, res) => {
  const t = getT(req.params.id); if (!t || !t.options) { res.status(404).json({ error: 'No options for this task' }); return null; }
  const j = +req.body.option; if (!t.options[j]) { res.status(400).json({ error: 'Bad option' }); return null; }
  return [t, j];
};

app.post('/api/tasks/:id/approve', (req, res) => {
  const p = pickOpt(req, res); if (!p) return; const [t, j] = p, name = t.options[j].name;
  t.pick = j; t.win = j; t.status = 'approved'; (t.hist ||= []).push({ o: name, k: 'approved' });
  say(t, 'me', 'I will take ' + name + '.'); say(t, 'ai', 'Approved. ' + (t.human ? 'A team member will ' + String(t.human.desc || 'follow up').toLowerCase() + '.' : 'No call needed.'));
  if (t.human) t.human.state = 'ready'; tr(t, 'R', 'Customer approved ' + name); save(); res.json(t);
});

app.post('/api/tasks/:id/switch', (req, res) => {
  const p = pickOpt(req, res); if (!p) return; const [t, j] = p, name = t.options[j].name;
  const was = t.status === 'approved' || t.status === 'changed', old = t.options[t.pick ?? t.win]?.name || 'earlier choice';
  t.win = j; (t.hist ||= []).push({ o: name, k: was ? 'changed from ' + old : 'new pick, not yet approved' });
  if (was) {
    t.pick = j; t.status = 'changed'; t.alert = `Customer switched from ${old} to ${name}`;
    t.human = { type: 'Call', desc: `Cancel or change the earlier booking (${old}) and book ${name}; confirm any fees`, state: 'ready', who: t.human?.who || '' };
    t.hand = 'A team member will cancel or change the earlier booking and confirm any fees with you.';
    say(t, 'me', 'I would like to switch to ' + name + '.'); say(t, 'ai', `Done. You had already approved ${old}, so a team member will cancel or change it with the provider and check any fees before confirming.`);
    tr(t, 'R', 'DECISION CHANGED after approval: ' + old + ' to ' + name);
  } else { say(t, 'me', 'Switch my pick to ' + name + '.'); say(t, 'ai', 'Updated. Approve when you are ready.'); }
  save(); res.json(t);
});

app.post('/api/tasks/:id/human', (req, res) => {
  const t = getT(req.params.id); if (!t || !t.human) return res.status(404).json({ error: 'No human step' });
  if (typeof req.body.who === 'string') t.human.who = req.body.who.slice(0, 40);
  if (req.body.unlock) t.human.state = 'ready';
  if (req.body.done) { t.human.state = 'done'; t.alert = ''; tr(t, 'R', 'Human step done: ' + t.human.desc); }
  save(); res.json(t);
});

app.listen(3000, () => log(`Orbit running on http://localhost:3000  (ai: ${LLM === 'claude' ? 'claude' : ORDER.join(' then ')}, search: ${PROVIDER})`));
