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
if (LLM === 'gemini' && PROVIDER === 'claude') { console.warn('SEARCH_PROVIDER=claude needs LLM_PROVIDER=claude. Using tavily.'); PROVIDER = 'tavily'; }

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

const call = (prompt, search = false) => (LLM === 'claude' ? callClaude(prompt, search) : gemini(prompt));
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
  llm: LLM, model: LLM === 'gemini' ? GEMINI_MODEL : 'claude-sonnet-5-5', search: PROVIDER,
  geminiKey: !!key('GEMINI_API_KEY'), tavilyKey: !!key('TAVILY_API_KEY'), anthropicKey: !!key('ANTHROPIC_API_KEY'),
}));

// Test each piece on its own, in the browser:
app.get('/api/search-test', async (req, res) => {
  try { res.json(await tavily(req.query.q || 'pediatric dentist San Mateo')); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});
app.get('/api/llm-test', async (_, res) => {
  try { res.json(J(await call('Return ONLY JSON {"ok":true,"say":"hello"}'))); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/api/ai', async (req, res) => {
  try { res.json({ text: await call(req.body.prompt, false) }); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// Debate: scouts propose in parallel -> critic attacks -> judge decides.
const LENSES = ['lowest total cost', 'best quality and reviews', 'best fit for every stated constraint (timing, location, preferences)'];

app.post('/api/debate', async (req, res) => {
  try {
    const { raw, asks = [] } = req.body, need = asks.join('; ');
    log('Debate started:', String(raw).slice(0, 70));

    const settled = await Promise.allSettled(LENSES.map(async (lens, i) => {
      await wait(i * 800);                                    // stagger scouts so they do not hit the model at once
      const task = `You are a research agent optimizing for: ${lens}. Request: ${raw}. Must satisfy: ${need}.
Return ONLY JSON {"pick":{"name":string,"fields":[4 short strings: price, timing or availability, key detail, distance or rating; write "unknown" if the evidence does not say],"why":max 25 words},"sources":[urls]}`;
      if (PROVIDER === 'claude') return J(await call(task + '\nUse web search.', true));
      const evidence = await tavily(`${raw} (${lens})`);
      return J(await call(task + `\nUse ONLY this search evidence. Never invent prices or facts; sources must be URLs from it.\nEvidence: ${JSON.stringify(evidence)}`));
    }));
    const scouts = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
    const failed = settled.filter(s => s.status === 'rejected');
    failed.forEach(f => console.error('Scout failed:', f.reason));
    if (!scouts.length) throw failed[0].reason;
    log(`Scouts done: ${scouts.length} ok, ${failed.length} failed`);

    const transcript = scouts.map((s, i) => ({ role: 'Scout: ' + LENSES[i], text: `${s.pick.name}. ${s.pick.why}` }));
    if (failed.length) transcript.push({ role: 'Note', text: `${failed.length} scout(s) failed: ${failed[0].reason.message}` });

    const critic = J(await call(
      `You are a critic. Challenge these picks against the request. Flag any that break a hard constraint or rest on unverified claims.
Request: ${raw}. Constraints: ${need}. Picks: ${JSON.stringify(scouts.map(s => s.pick))}
Return ONLY JSON {"objections":[{"pick":string,"issue":max 20 words}]}`));
    transcript.push({ role: 'Critic', text: (critic.objections || []).map(o => `${o.pick}: ${o.issue}`).join(' | ') || 'No objections.' });

    const v = J(await call(
      `You are the judge. Pick the single best option for this customer. Weigh the critic's objections; any broken hard constraint disqualifies a pick.
Request: ${raw}. Constraints: ${need}. Picks: ${JSON.stringify(scouts.map(s => s.pick))}. Objections: ${JSON.stringify(critic.objections || [])}
Return ONLY JSON {"winner":string,"answer":max 45 words, crisp, no greeting,"confidence":"high|medium|low","reason":max 25 words}`));
    transcript.push({ role: 'Judge', text: `${v.winner}. ${v.reason} (${v.confidence} confidence)` });
    log('Debate done:', v.winner);

    res.json({
      answer: v.answer, confidence: v.confidence, transcript, search: PROVIDER,
      options: scouts.map(s => s.pick),
      sources: [...new Set(scouts.flatMap(s => s.sources || []))],
    });
  } catch (e) { console.error('Debate failed:', e); res.status(500).json({ error: e.message }); }
});

app.listen(3000, () => log(`Orbit running on http://localhost:3000  (model: ${LLM}, search: ${PROVIDER})`));
