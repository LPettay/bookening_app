require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const DESCOPE_ENABLED = String(process.env.DESCOPE_ENABLED || 'false') === 'true';
const MOCK_USER_EMAIL = process.env.MOCK_USER_EMAIL || 'owner@example.com';
const MOCK_ROLES = (process.env.MOCK_ROLES || 'owner').split(',').map((r) => r.trim()).filter(Boolean);

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// storage (tmp files)
const TMP_DIR = path.join(__dirname, 'tmp');
const CONFIG_PATH = path.join(TMP_DIR, 'owner_config.json');
const TOKENS_PATH = path.join(TMP_DIR, 'owner_google_tokens.json');
const REQUESTS_DIR = path.join(TMP_DIR, 'requests');
[TMP_DIR, REQUESTS_DIR].forEach((p) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
const USER_TOKENS_DIR = path.join(TMP_DIR, 'user_google_tokens');
[TMP_DIR, REQUESTS_DIR, USER_TOKENS_DIR].forEach((p) => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

// transcript helpers
function appendMessage(jobId, msg) {
  const recordPath = path.join(REQUESTS_DIR, `${jobId}.json`);
  const rec = readJSON(recordPath, { messages: [] });
  const next = { ...rec, messages: [ ...(rec.messages || []), { at: Date.now(), ...msg } ] };
  writeJSON(recordPath, next);
  return next;
}

// state helpers
function updateState(jobId, newState) {
  const recordPath = path.join(REQUESTS_DIR, `${jobId}.json`);
  const rec = readJSON(recordPath, {});
  const next = { ...rec, state: newState, updatedAt: Date.now() };
  writeJSON(recordPath, next);
  const stream = streams.get(jobId);
  if (stream) sseSend(stream, 'state', { state: newState });
  return next;
}

// form schema helper
function buildFormSchema(ask) {
  const requiredSet = new Set((ask || []).map((s) => String(s)));
  const field = (key, label, input, extra = {}) => ({ key, label, input, required: requiredSet.has(key), ...extra });
  return {
    id: 'details',
    title: 'Meeting details',
    fields: [
      field('topic', 'Topic', 'text'),
      field('attendees', 'Attendees (emails)', 'email_list'),
      field('urgency', 'Urgency', 'select', { options: ['low', 'medium', 'high'] }),
      field('desiredTimeframe', 'Desired timeframe', 'text'),
      field('background', 'Background', 'textarea'),
      field('links', 'Links', 'text_list')
    ]
  };
}

// descope auth helpers (feature-toggle)
let descope = null;
if (DESCOPE_ENABLED) {
  try {
    const sdk = require('@descope/node-sdk');
    const DescopeCtor = sdk?.default || sdk;
    descope = DescopeCtor({ projectId: process.env.DESCOPE_PROJECT_ID });
  } catch (e) {
    console.error('Descope initialization failed. Set DESCOPE_ENABLED=false to bypass during local dev.', e?.message || e);
  }
}

function getBearer(req) {
  const h = req.headers['authorization'];
  if (h && h.startsWith('Bearer ')) return h.slice('Bearer '.length);
  return null;
}
async function requireAuth(req, res, next) {
  if (!DESCOPE_ENABLED) {
    req.user = { email: MOCK_USER_EMAIL, userId: 'mock-user' };
    req.session = { grant: { roles: MOCK_ROLES } };
    return next();
  }
  if (!descope) return res.status(500).json({ error: 'Auth not available' });
  try {
    // Prefer cookie-aware request validation (works with DS/DSR cookies)
    const { session, user } = await descope.validateRequest(req);
    if (session && user) {
      req.user = user;
      req.session = session;
      return next();
    }
  } catch (_) { /* fallthrough to token-based */ }
  try {
    const token = getBearer(req) || req.cookies['DS'] || req.cookies['DSR'];
    if (!token) return res.status(401).json({ error: 'No session' });
    const { session, user } = await descope.validateSession(token);
    req.user = user || session?.user;
    req.session = session;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid session' });
  }
}
function requireRole(role) {
  return (req, res, next) => {
    const roles = req.session?.grant?.roles || [];
    const primaryLogin = Array.isArray(req.user?.loginIds) && req.user.loginIds.length > 0 ? String(req.user.loginIds[0]) : '';
    const email = (req.user?.email || primaryLogin || '').toLowerCase();
    const ownerEmails = String(process.env.OWNER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    // Allow owner access by email override as a convenience
    if (role === 'owner' && (email === 'lancepettay@gmail.com' || (ownerEmails.length && ownerEmails.includes(email)))) return next();
    if (!roles.includes(role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// sse hub
const streams = new Map(); // jobId -> res
function startSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function closeStream(jobId) {
  const res = streams.get(jobId);
  if (res) {
    res.end();
    streams.delete(jobId);
  }
}

// google calendar helpers
function googleClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  // Prefer environment-provided credentials (e.g., from Descope Outbound Apps)
  const envAccess = process.env.GOOGLE_ACCESS_TOKEN;
  const envRefresh = process.env.GOOGLE_REFRESH_TOKEN;
  if (envAccess || envRefresh) {
    const expiry = process.env.GOOGLE_TOKEN_EXPIRY ? Number(process.env.GOOGLE_TOKEN_EXPIRY) : undefined;
    oAuth2Client.setCredentials({ access_token: envAccess, refresh_token: envRefresh, expiry_date: expiry });
    return oAuth2Client;
  }
  // Fallback to locally stored tokens
  const tokens = readJSON(TOKENS_PATH, null);
  if (tokens) oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}
function ensureOwnerGoogle(res) {
  // If tokens are supplied via environment, treat as connected
  if (process.env.GOOGLE_ACCESS_TOKEN || process.env.GOOGLE_REFRESH_TOKEN) return true;
  const tokens = readJSON(TOKENS_PATH, null);
  if (!tokens) {
    res.status(400).json({ error: 'Owner Google not connected' });
    return false;
  }
  return true;
}

// per-user tokens helpers
function userTokensPath(userId) {
  return path.join(USER_TOKENS_DIR, `${userId}.json`);
}
function hasUserGoogle(userId) {
  if (!userId) return false;
  try { fs.accessSync(userTokensPath(userId)); return true; } catch { return false; }
}
function googleClientForUser(userId) {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const tokens = readJSON(userTokensPath(userId), null);
  if (tokens) oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}

// internal helper: suggest slots (owner-only or mutual if user connected)
async function suggestSlotsCore(userId, { days = 7, durationMins = 30, windowStart = '09:00', windowEnd = '17:00', ownerOnly = true } = {}) {
  if (!ensureOwnerGoogle({ status: () => ({ json: () => {} }) })) return { suggestions: [] }; // no-op when not connected
  const ownerAuth = googleClient();
  const userHasTokens = hasUserGoogle(userId);
  const useOwnerOnly = ownerOnly || !userHasTokens;
  const userAuth = !useOwnerOnly ? googleClientForUser(userId) : null;

  const calendarOwner = google.calendar({ version: 'v3', auth: ownerAuth });
  const calendarUser = !useOwnerOnly && userAuth ? google.calendar({ version: 'v3', auth: userAuth }) : null;
  const now = new Date();
  const until = new Date(Date.now() + days * 24 * 3600 * 1000);
  const listEvents = async (calendar, calendarId) => {
    const r = await calendar.events.list({
      calendarId,
      timeMin: now.toISOString(),
      timeMax: until.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    return (r.data.items || []).map(e => ({
      start: new Date(e.start?.dateTime || e.start?.date),
      end: new Date(e.end?.dateTime || e.end?.date)
    }));
  };
  const ownerEvents = await listEvents(calendarOwner, process.env.GOOGLE_CALENDAR_ID || 'primary');
  const userEvents = calendarUser ? await listEvents(calendarUser, 'primary') : [];
  const parseHM = (s) => { const [h, m] = String(s).split(':').map(Number); return { h: h || 0, m: m || 0 }; };
  const { h: wsH, m: wsM } = parseHM(windowStart);
  const { h: weH, m: weM } = parseHM(windowEnd);
  const slotMs = durationMins * 60 * 1000;
  const suggestions = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const dayStart = new Date(day); dayStart.setHours(wsH, wsM, 0, 0);
    const dayEnd = new Date(day); dayEnd.setHours(weH, weM, 0, 0);
    for (let t = dayStart.getTime(); t + slotMs <= dayEnd.getTime(); t += slotMs) {
      const s = new Date(t); const e = new Date(t + slotMs);
      const busyOwner = ownerEvents.some(ev => !(e <= ev.start || s >= ev.end));
      const busyUser = useOwnerOnly ? false : userEvents.some(ev => !(e <= ev.start || s >= ev.end));
      if (!busyOwner && !busyUser && s > now) suggestions.push({ start: s.toISOString(), end: e.toISOString() });
      if (suggestions.length >= 10) break;
    }
    if (suggestions.length >= 10) break;
  }
  return { suggestions, ownerOnly: useOwnerOnly };
}

// agent logic
const openaiApiKey = process.env.OPENAI_API_KEY;
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function loadConfig() {
  // Allow hardcoded configuration via environment variables
  const listFromEnv = (val, fallback) => {
    if (!val) return fallback;
    return String(val).split(',').map((s) => s.trim()).filter(Boolean);
  };
  const defaultCfg = {
    dueDiligenceChecklist: [
      'Have you searched our docs / website?',
      'Do you have a clear agenda and desired outcome?',
      'Is email/async insufficient?'
    ],
    decisionPolicy: 'conservative',
    requiredFieldsOnApprove: ['topic', 'attendees', 'urgency', 'desiredTimeframe']
  };
  if (String(process.env.CONFIG_HARDCODED || 'true') === 'true') {
    return {
      dueDiligenceChecklist: listFromEnv(process.env.DUE_DILIGENCE_CHECKLIST, defaultCfg.dueDiligenceChecklist),
      decisionPolicy: process.env.DECISION_POLICY || defaultCfg.decisionPolicy,
      requiredFieldsOnApprove: listFromEnv(process.env.REQUIRED_FIELDS_ON_APPROVE, defaultCfg.requiredFieldsOnApprove)
    };
  }
  // Fallback to file-based config
  return readJSON(CONFIG_PATH, defaultCfg);
}

async function agentDecideAndGather({ initialMessage, userContext }, emit) {
  const cfg = loadConfig();
  emit('log', { msg: 'Evaluating due diligence...' });

  const sys = `You are a calendar gatekeeper. Consider the due diligence checklist and policy=${cfg.decisionPolicy}.
If insufficient diligence or unclear value, decline with rationale and ask for missing info.
If warranted, approve and gather: topic, attendees (emails), urgency (low/med/high), desiredTimeframe, background context, links.`;

  const prompt = `
Checklist: ${cfg.dueDiligenceChecklist.join(' | ')}
User: ${initialMessage}
Known context: ${JSON.stringify(userContext || {})}
Decide: APPROVE or DECLINE with brief rationale. Then list missing fields if any.
Respond in JSON with: { "decision": "APPROVE|DECLINE", "rationale": string, "missing": string[] }
`;

  if (!openai) {
    emit('log', { msg: 'LLM disabled (no OPENAI_API_KEY). Defaulting to conservative DECLINE.' });
    return { decision: 'DECLINE', rationale: 'LLM disabled' };
  }
  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  });
  const text = resp.choices[0].message.content || '{}';
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { decision: 'DECLINE', rationale: 'Parsing error' };
  }

  emit('decision', parsed);

  if (parsed.decision === 'APPROVE') {
    const missing = parsed.missing || cfg.requiredFieldsOnApprove;
    if (missing.length > 0) {
      emit('gather', { ask: missing });
    }
  }
  return parsed;
}

// chat agent (user-facing) – generates natural, friendly prompts without exposing the decision agent
async function chatAgentGenerate({ ask, userMessages, decision, transcript }) {
  // Fallback wording if LLM is disabled
  const fallback = () => {
    const list = (ask && ask.length) ? ask.join(', ') : 'any relevant details';
    if (decision?.decision === 'APPROVE') {
      return `Sounds good! To move forward, could you share: ${list}?`;
    }
    return `Happy to help. To better understand, could you share: ${list}?`;
  };

  if (!openai) return fallback();

  const system = `You are a warm, concise mentor (like a helpful professor).
You have access to the conversation transcript and should retain context.
Always briefly acknowledge salient details the user already provided (1 short clause), then only ask for information that is still missing.
Never ask for the same thing twice; do not repeat questions the user has answered.
Speak naturally in 1-3 short sentences. Avoid mentioning internal decision processes.`;

  const userSummary = `Conversation transcript (most recent first):\n${(transcript || []).join('\n')}`;
  const need = (ask && ask.length) ? ask.join(', ') : '';
  const hint = decision?.decision ? `Current internal stance: ${decision.decision}. Do NOT reveal this; simply guide the user.` : '';

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.5,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${userSummary}\nMissing fields to collect (do not expose source): ${need || 'none'}\n${hint}` }
    ]
  });
  const text = resp.choices?.[0]?.message?.content?.trim();
  return text || fallback();
}

function buildBriefing(ownerUser, form) {
  return [
    `Requester: ${ownerUser?.name || ownerUser?.email || 'unknown'}`,
    `Topic: ${form.topic || ''}`,
    `Attendees: ${(form.attendees || []).join(', ')}`,
    `Urgency: ${form.urgency || ''}`,
    `Desired timeframe: ${form.desiredTimeframe || ''}`,
    `Background: ${form.background || ''}`,
    `Links: ${(form.links || []).join(', ')}`
  ].join('\n');
}

// routes
app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('/api/auth/session', requireAuth, (req, res) => {
  res.json({ user: req.user, roles: req.session?.grant?.roles || [] });
});

// owner config
app.get('/api/config', requireAuth, requireRole('owner'), (req, res) => {
  res.json(loadConfig());
});
app.post('/api/config', requireAuth, requireRole('owner'), (req, res) => {
  const current = loadConfig();
  const next = { ...current, ...req.body };
  writeJSON(CONFIG_PATH, next);
  res.json(next);
});

// google oauth for owner
app.get('/api/calendar/oauth/initiate', requireAuth, (req, res) => {
  const o = googleClient();
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const url = o.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
  res.json({ url });
});
app.get('/api/calendar/oauth/callback', async (req, res) => {
  const code = req.query.code;
  const o = googleClient();
  const { tokens } = await o.getToken(code);
  writeJSON(TOKENS_PATH, tokens);
  res.send('Google connected. You can close this tab.');
});

// availability (optional)
app.get('/api/calendar/availability', requireAuth, async (req, res) => {
  if (!ensureOwnerGoogle(res)) return;
  try {
    const auth = googleClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const in7 = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const events = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: now.toISOString(),
      timeMax: in7.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    res.json({ count: events.data.items?.length || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message || 'availability_error' });
  }
});

// suggest mutual times between owner and requester
app.get('/api/calendar/suggest', requireAuth, async (req, res) => {
  // Parameters (optional): days=7, durationMins=30, windowStart=09:00, windowEnd=17:00, ownerOnly=false
  const days = Number(req.query.days || 7);
  const durationMins = Number(req.query.durationMins || 30);
  const windowStart = String(req.query.windowStart || '09:00');
  const windowEnd = String(req.query.windowEnd || '17:00');
  const ownerOnly = String(req.query.ownerOnly || 'false') === 'true';

  // Build clients
  if (!ensureOwnerGoogle(res)) return; // owner must be connected
  const ownerAuth = googleClient();
  const userHasTokens = hasUserGoogle(req.user?.userId);
  const useOwnerOnly = ownerOnly || !userHasTokens;
  const userAuth = !useOwnerOnly ? googleClientForUser(req.user?.userId) : null;

  const calendarOwner = google.calendar({ version: 'v3', auth: ownerAuth });
  const calendarUser = !useOwnerOnly && userAuth ? google.calendar({ version: 'v3', auth: userAuth }) : null;

  const now = new Date();
  const until = new Date(Date.now() + days * 24 * 3600 * 1000);

  const listEvents = async (calendar, calendarId) => {
    const r = await calendar.events.list({
      calendarId,
      timeMin: now.toISOString(),
      timeMax: until.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    return (r.data.items || []).map(e => ({
      start: new Date(e.start?.dateTime || e.start?.date),
      end: new Date(e.end?.dateTime || e.end?.date)
    }));
  };

  const ownerEvents = await listEvents(calendarOwner, process.env.GOOGLE_CALENDAR_ID || 'primary');
  const userEvents = calendarUser ? await listEvents(calendarUser, 'primary') : [];

  const parseHM = (s) => { const [h, m] = s.split(':').map(Number); return { h: h || 0, m: m || 0 }; };
  const { h: wsH, m: wsM } = parseHM(windowStart);
  const { h: weH, m: weM } = parseHM(windowEnd);

  const slotMs = durationMins * 60 * 1000;
  const suggestions = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    const dayStart = new Date(day); dayStart.setHours(wsH, wsM, 0, 0);
    const dayEnd = new Date(day); dayEnd.setHours(weH, weM, 0, 0);
    for (let t = dayStart.getTime(); t + slotMs <= dayEnd.getTime(); t += slotMs) {
      const s = new Date(t); const e = new Date(t + slotMs);
      const busyOwner = ownerEvents.some(ev => !(e <= ev.start || s >= ev.end));
      const busyUser = useOwnerOnly ? false : userEvents.some(ev => !(e <= ev.start || s >= ev.end));
      if (!busyOwner && !busyUser && s > now) suggestions.push({ start: s.toISOString(), end: e.toISOString() });
      if (suggestions.length >= 10) break;
    }
    if (suggestions.length >= 10) break;
  }

  res.json({ suggestions, ownerOnly: useOwnerOnly });
});

// per-user google oauth (local demo storage)
app.get('/api/user/calendar/status', requireAuth, (req, res) => {
  const connected = hasUserGoogle(req.user?.userId);
  res.json({ connected });
});
app.get('/api/user/calendar/oauth/initiate', requireAuth, (req, res) => {
  const o = googleClient();
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  const url = o.generateAuthUrl({ access_type: 'offline', scope: scopes, prompt: 'consent' });
  res.json({ url });
});
app.get('/api/user/calendar/oauth/callback', requireAuth, async (req, res) => {
  const code = req.query.code;
  const o = googleClient();
  const { tokens } = await o.getToken(code);
  writeJSON(userTokensPath(req.user?.userId), tokens);
  res.send('Your Google account is connected. You can close this tab.');
});

// agent start + sse
app.post('/api/agent/start', requireAuth, async (req, res) => {
  const jobId = uuidv4();
  const dataPath = path.join(REQUESTS_DIR, `${jobId}.json`);
  writeJSON(dataPath, {
    jobId,
    ownerUserId: req.user?.userId,
    initialMessage: req.body.initialMessage || '',
    createdAt: Date.now(),
    messages: (req.body.initialMessage ? [ { role: 'user', agent: 'user', content: req.body.initialMessage, at: Date.now() } ] : []),
    evaluated: false,
    lastDecision: null,
    state: 'awaiting_input'
  });
  res.json({ jobId });
});
app.get('/api/agent/stream/:jobId', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  startSSE(res);
  streams.set(jobId, res);

  const emit = (event, data) => sseSend(res, event, data);

  emit('log', { msg: 'Agent ready.' });
  const rec = readJSON(path.join(REQUESTS_DIR, `${jobId}.json`), null);
  if (!rec) {
    emit('error', { error: 'Unknown jobId' });
    return closeStream(jobId);
  }
  // emit current state
  sseSend(res, 'state', { state: rec.state || 'awaiting_input' });
  // Do not evaluate yet; wait for first user message
});

// append a chat message from the user and echo to stream
app.post('/api/agent/message', requireAuth, async (req, res) => {
  const { jobId, content } = req.body || {};
  if (!jobId || !content) return res.status(400).json({ error: 'jobId and content required' });
  const recordPath = path.join(REQUESTS_DIR, `${jobId}.json`);
  const rec = readJSON(recordPath, null);
  if (!rec) return res.status(404).json({ error: 'Unknown jobId' });
  const next = appendMessage(jobId, { role: 'user', agent: 'user', content });
  updateState(jobId, 'evaluating');
  const stream = streams.get(jobId);
  if (stream) sseSend(stream, 'chat', { role: 'user', agent: 'user', content });

  // Trigger first evaluation (or re-evaluation) when we have user content
  try {
    const emit = (event, data) => stream && sseSend(stream, event, data);
    const combined = (next.messages || [])
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n');
    // MCP-style tool calls: decision agent and calendar agent
    const toolContext = { actor: { email: req.user?.email, userId: req.user?.userId } };
    emit('tool', { name: 'decision.evaluate', status: 'call', args: { message: combined }, ...toolContext });
    const decision = await agentDecideAndGather({ initialMessage: combined, userContext: { email: req.user?.email } }, emit);
    emit('tool', { name: 'decision.evaluate', status: 'result', result: decision, ...toolContext });
    emit('agent', { role: 'assistant', agent: 'decision', decision });
    // calendar tool suggestion (demonstration): only when approved
    if (decision.decision === 'APPROVE') {
      emit('tool', { name: 'calendar.suggest', status: 'call', args: { ownerOnly: true }, ...toolContext });
      const slots = await suggestSlotsCore(req.user?.userId, { ownerOnly: true });
      emit('tool', { name: 'calendar.suggest', status: 'result', result: { count: (slots.suggestions || []).length }, ...toolContext });
      emit('agent', { role: 'assistant', agent: 'calendar', suggestions: slots.suggestions });
    }
    // store decision agent message and stream on 'agent'
    appendMessage(jobId, { role: 'assistant', agent: 'decision', content: JSON.stringify(decision) });

    const ask = (decision.missing && decision.missing.length > 0)
      ? decision.missing
      : (decision.decision === 'APPROVE' ? (loadConfig().requiredFieldsOnApprove || []) : ['topic', 'desiredTimeframe', 'agenda']);
    const transcriptLines = (next.messages || []).map(m => `${m.role}: ${m.content}`).slice(-12); // last 12 exchanges
    const userMsgs = (next.messages || []).filter(m => m.role === 'user').map(m => m.content);
    const chatText = await chatAgentGenerate({ ask, userMessages: userMsgs, decision, transcript: transcriptLines });
    emit('gather', { ask });
    // Only show an inline form if the meeting is approved and we need details
    if (decision.decision === 'APPROVE' && ask.length > 0) {
      const formSchema = buildFormSchema(ask);
      const streamForm = streams.get(jobId);
      if (streamForm) sseSend(streamForm, 'form', { schema: formSchema });
    }
    appendMessage(jobId, { role: 'assistant', agent: 'chat', content: chatText });
    emit('chat', { role: 'assistant', agent: 'chat', content: chatText });
    if (decision.decision === 'APPROVE' && ask.length === 0) {
      updateState(jobId, 'ready_to_schedule');
    } else if (decision.decision === 'APPROVE') {
      updateState(jobId, 'approved_needs_details');
    } else {
      updateState(jobId, 'awaiting_input');
    }
    writeJSON(recordPath, { ...next, evaluated: true, lastDecision: decision });
  } catch (e) {
    // Already streamed error in agentDecideAndGather
  }
  return res.json({ ok: true });
});

app.post('/api/agent/complete', requireAuth, async (req, res) => {
  const { jobId, form, slot } = req.body || {};
  const stream = streams.get(jobId);
  const emit = stream ? (e, d) => sseSend(stream, e, d) : () => {};
  const recordPath = path.join(REQUESTS_DIR, `${jobId}.json`);
  const rec = readJSON(recordPath, null);
  if (!rec) return res.status(404).json({ error: 'Unknown jobId' });

  writeJSON(recordPath, { ...rec, form });
  updateState(jobId, 'ready_to_schedule');

  emit('log', { msg: 'Compiling briefing...' });
  const briefing = buildBriefing(req.user, form);
  emit('briefing', { briefing });
  const stream2 = streams.get(jobId);
  appendMessage(jobId, { role: 'assistant', agent: 'chat', content: 'I prepared a briefing draft based on your details. Scheduling now...' });
  if (stream2) sseSend(stream2, 'chat', { role: 'assistant', agent: 'chat', content: 'I prepared a briefing draft based on your details. Scheduling now...' });

  // prefer requester tokens; fallback to owner
  const useUser = hasUserGoogle(req.user?.userId);
  if (!useUser && !ensureOwnerGoogle(res)) { emit('error', { error: 'Owner Google not connected' }); return; }
  try {
    updateState(jobId, 'scheduling');
    const auth = useUser ? googleClientForUser(req.user?.userId) : googleClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const start = slot?.start ? new Date(slot.start) : new Date();
    const end = slot?.end ? new Date(slot.end) : new Date(start.getTime() + 30 * 60 * 1000);
    const attendees = (form.attendees || []).map((e) => ({ email: e }));
    emit('tool', { name: 'calendar.schedule', status: 'call', args: { start: start.toISOString(), end: end.toISOString(), attendees: attendees.map(a => a.email) }, actor: { email: req.user?.email, userId: req.user?.userId } });
    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      sendUpdates: 'all',
      requestBody: {
        summary: form.topic || 'Meeting',
        description: briefing,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees
      }
    });
    emit('tool', { name: 'calendar.schedule', status: 'result', result: { id: event.data.id, link: event.data.htmlLink } });
    emit('scheduled', { eventId: event.data.id, htmlLink: event.data.htmlLink });
    updateState(jobId, 'notified');
    emit('done', { status: 'SCHEDULED' });
    res.json({ ok: true, event: event.data });
    closeStream(jobId);
  } catch (e) {
    emit('error', { error: e.message || 'Calendar error' });
    updateState(jobId, 'error');
    res.status(500).json({ error: 'Calendar error' });
    closeStream(jobId);
  }
});

// submit inline form values (same fields as /complete, but values is a flat object)
app.post('/api/agent/form/submit', requireAuth, async (req, res) => {
  const { jobId, formId, values } = req.body || {};
  if (!jobId || !values) return res.status(400).json({ error: 'jobId and values required' });
  const stream = streams.get(jobId);
  const emit = stream ? (e, d) => sseSend(stream, e, d) : () => {};
  const recordPath = path.join(REQUESTS_DIR, `${jobId}.json`);
  const rec = readJSON(recordPath, null);
  if (!rec) return res.status(404).json({ error: 'Unknown jobId' });

  // normalize values to the expected form shape
  const toList = (v) => Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : []);
  const form = {
    topic: values.topic || '',
    attendees: toList(values.attendees),
    urgency: values.urgency || 'medium',
    desiredTimeframe: values.desiredTimeframe || '',
    background: values.background || '',
    links: toList(values.links)
  };

  writeJSON(recordPath, { ...rec, form });
  updateState(jobId, 'ready_to_schedule');

  emit('log', { msg: 'Compiling briefing...' });
  const briefing = buildBriefing(req.user, form);
  emit('briefing', { briefing });
  appendMessage(jobId, { role: 'assistant', agent: 'chat', content: 'Thanks! I have what I need. Scheduling now...' });
  emit('chat', { role: 'assistant', agent: 'chat', content: 'Thanks! I have what I need. Scheduling now...' });

  // prefer requester tokens; fallback to owner
  const useUser = hasUserGoogle(req.user?.userId);
  if (!useUser && !ensureOwnerGoogle(res)) { emit('error', { error: 'Owner Google not connected' }); updateState(jobId, 'error'); return; }
  try {
    updateState(jobId, 'scheduling');
    const auth = useUser ? googleClientForUser(req.user?.userId) : googleClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const start = new Date();
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const attendees = (form.attendees || []).map((e) => ({ email: e }));
    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      sendUpdates: 'all',
      requestBody: {
        summary: form.topic || 'Meeting',
        description: briefing,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees
      }
    });
    emit('scheduled', { eventId: event.data.id, htmlLink: event.data.htmlLink });
    updateState(jobId, 'notified');
    emit('done', { status: 'SCHEDULED' });
    return res.json({ ok: true, event: event.data });
  } catch (e) {
    emit('error', { error: e.message || 'Calendar error' });
    updateState(jobId, 'error');
    return res.status(500).json({ error: 'Calendar error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});


