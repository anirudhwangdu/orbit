# Orbit

AI-first concierge prototype. Ops console at `/`, customer app at `/client`.

## Run (Windows cmd)
    copy .env.example .env      (then open .env and paste your keys, no quotes)
    npm install
    npm start

Open http://localhost:3000

## Check each piece
- /api/health       which keys the server can see
- /api/llm-test     model works (expects {"ok":true,"say":"hello"})
- /api/search-test?q=pediatric+dentist+San+Mateo   search works

## Notes
- Keys live only in `.env` (git-ignored). Never commit them.
- Use fake customer data while on free tiers.
