## Calendar Gatekeeper – Agentic Scheduling Demo

An authentic, down‑to‑earth demo app that gatekeeps an owner's calendar. It runs a small team of agents that work together:

- Conversation agent: the friendly face. Talks with the user, keeps short‑term memory, and presents results humanly.
- Decision agent: evaluates whether a meeting is warranted based on due‑diligence policy and conversation context.
- Calendar agent: suggests mutually open times and schedules the event.

The agents coordinate via tool calls surfaced in the UI’s debug mode. Auth is handled by Descope, and Google Calendar access is either via a one‑time local OAuth flow or Descope Outbound Apps.

### Why this exists

Everyone wants fewer back‑and‑forth emails. This demo shows a practical, inspectable setup where you can see the agents making moves, not just opaque “AI magic.”

---

## High‑level capabilities

- Multi‑agent orchestration with clear scopes
  - Conversation agent never exposes internal tools; it presents helpful, short responses.
  - Decision agent returns APPROVE/DECLINE with rationale and “what’s missing.”
  - Calendar agent lists suggested slots and schedules exactly at the chosen time.
- MCP‑style tool calls (observable)
  - SSE events include `tool` records like `decision.evaluate`, `calendar.suggest`, `calendar.schedule` with args/results.
  - Flip the Debug checkbox in the chat to see the agent comms.
- Chat‑first UX with inline forms and prefilled context
  - Topic/background draft auto‑filled from recent chat messages (editable before sending).
  - Suggested times appear as chips; pick one and it books precisely that window.
- Authn/Authz with Descope
  - Cookie‑based request validation (`validateRequest`) and fallback to session tokens.
  - Optional owner overrides via env; or use the `owner` role for stricter RBAC.
- Google Calendar integration
  - One‑time local OAuth (stores refresh token), or use Descope Outbound Apps to map tokens into env.
  - Owner‑only suggestions by default; optional mutual availability if users connect their Google.

---

## Architecture

### Components

- Web (Vite + React)
  - Chat page with SSE stream, message history, debug toggle, inline form, and slot chips.
  - Owner page for policy edits and a Google connect button (optional in prod if you use env tokens).

- Server (Node.js + Express)
  - SSE hub (`/api/agent/stream/:jobId`)
  - Agent routes: start, message, complete, inline form submit
  - Google Calendar routes: OAuth initiate/callback, availability, suggest
  - Descope session validation (feature‑toggled)

### Agents and tools

- Conversation agent (LLM): keeps a short rolling transcript, acknowledges prior facts, only asks for missing info, and never reveals tools.
- Decision agent (LLM): evaluates due‑diligence checklist + policy → APPROVE/DECLINE + missing fields.
- Calendar agent (code): suggests slots and schedules events.

MCP‑style visibility via SSE:

```json
{ "event": "tool", "name": "decision.evaluate", "status": "call|result", "args|result": { ... } }
{ "event": "agent", "agent": "decision|calendar", ... }
```

---

## Getting started

### Prereqs

- Node 18+
- A Descope project (optional for local dev)
- Google Cloud project with Calendar API enabled

### Install

```bash
cd server && npm install
cd ../web && npm install
```

### Environment

Create `server/.env`:

```env
# App
PORT=4000
FRONTEND_ORIGIN=http://localhost:5173

# Descope (toggle on when ready)
DESCOPE_ENABLED=false
DESCOPE_PROJECT_ID=

# Local dev mock (used when DESCOPE_ENABLED=false)
MOCK_USER_EMAIL=owner@example.com
MOCK_ROLES=owner

# Google OAuth
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:4000/api/calendar/oauth/callback

# Prefer env tokens (e.g., from Descope Outbound Apps)
GOOGLE_REFRESH_TOKEN=...
# Optional
GOOGLE_ACCESS_TOKEN=
GOOGLE_TOKEN_EXPIRY=
GOOGLE_CALENDAR_ID=primary

# Owner access by email (convenience override)
OWNER_EMAILS=lancepettay@gmail.com

# LLM
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini

# Policy (set CONFIG_HARDCODED=false to use Owner page)
CONFIG_HARDCODED=true
DECISION_POLICY=balanced
DUE_DILIGENCE_CHECKLIST=searched docs,clear agenda,not email
REQUIRED_FIELDS_ON_APPROVE=topic,attendees,urgency,desiredTimeframe
```

Create `web/.env`:

```env
VITE_DESCOPE_ENABLED=false
VITE_DESCOPE_PROJECT_ID=
# Optional if using Descope Outbound Apps in-app flow
VITE_DESCOPE_OUTBOUND_FLOW_ID=
```

### Run

```bash
# Terminal A
cd server
npm run dev

# Terminal B
cd web
npm run dev
```

Open `http://localhost:5173`.

---

## How to connect Google

You have two reliable options:

- Env tokens (recommended for demos/prod): Put `GOOGLE_REFRESH_TOKEN` (and client id/secret) in `server/.env`. The server refreshes access tokens automatically; no “Connect” button needed.
- One‑time local OAuth: Visit `/owner` and click “Connect Google” to obtain and store tokens. Copy the refresh token into `.env` for durability.

If you see Google’s “access blocked” screen, add your account as a test user on the OAuth consent screen or use Descope’s verified Outbound App.

---

## Flow walkthrough

1) User opens chat → server creates a job and opens an SSE stream.
2) When the user sends a message:
   - Tool call: `decision.evaluate` → APPROVE/DECLINE + missing fields.
   - Conversation agent responds naturally with context memory.
   - On APPROVE, tool call: `calendar.suggest` → list of slots.
3) User picks a slot → tool call: `calendar.schedule` → event created with the exact start/end.
4) Debug toggle shows `tool` and `agent` SSE events so you can narrate what happened.

---

## Key files

- `server/index.js`
  - SSE, auth, agents, MCP‑style tool events, Google Calendar helpers
  - Owner config and due‑diligence policy
- `web/src/App.tsx`
  - Chat UI, debug toggle, inline details, suggested time chips
  - Owner page (optional in prod)
- `web/src/styles.css`
  - Dark, modern theme with readable defaults

---

## Presenting this project (slide outline)

1) Problem → endless back‑and‑forth + opaque AI.
2) Approach → small team of scoped agents + visible tools.
3) Architecture → UI, SSE, Agents, Tools, Descope, Google.
4) Live demo → conversation → decision → slots → schedule. Flip Debug.
5) Security → Descope auth, token handling, .gitignore and env, revocation plan.
6) Extensibility → add CRM tool, notes tool, post‑meeting follow‑ups.
7) Takeaways → practical, transparent, and easy to evolve.

---

## Troubleshooting

- “Forbidden” on connect or owner routes
  - Ensure you’re signed in; set `DESCOPE_ENABLED=false` for local mock or assign the `owner` role / `OWNER_EMAILS`.

- No slots / availability returns 401
  - Refresh token missing/revoked. Reconnect or update `GOOGLE_REFRESH_TOKEN`.

- Chat repeats earlier questions
  - We pass a rolling transcript; if you still see repeats, bump the window or adjust due‑diligence prompts.

---

## Notes on security & ops

- Keep secrets out of git. `.env` files and `server/tmp/` are ignored. If you accidentally committed them, rewrite history with `git filter-repo` or BFG and rotate keys.
- Consider Descope Outbound Apps for centrally managed consent/tokens.
- Add a periodic health check to call `/api/calendar/availability` and alert/re‑consent as needed.

---

## License

MIT for the demo code. Attribution appreciated if you reuse pieces.


