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
  const token = getBearer(req) || req.cookies['DS'] || req.cookies['DSR'];
  if (!token) return res.status(401).json({ error: 'No session' });
  if (!descope) return res.status(500).json({ error: 'Auth not available' });
  try {
    const { session } = await descope.validateSession(token);
    req.user = session?.user;
    req.session = session;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid session' });
  }
}
function requireRole(role) {
  return (req, res, next) => {
    const roles = req.session?.grant?.roles || [];
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
  const tokens = readJSON(TOKENS_PATH, null);
  if (tokens) oAuth2Client.setCredentials(tokens);
  return oAuth2Client;
}
function ensureOwnerGoogle(res) {
  const tokens = readJSON(TOKENS_PATH, null);
  if (!tokens) {
    res.status(400).json({ error: 'Owner Google not connected' });
    return false;
  }
  return true;
}

// agent logic
const openaiApiKey = process.env.OPENAI_API_KEY;
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function loadConfig() {
  return readJSON(CONFIG_PATH, {
    dueDiligenceChecklist: [
      'Have you searched our docs / website?',
      'Do you have a clear agenda and desired outcome?',
      'Is email/async insufficient?'
    ],
    decisionPolicy: 'conservative',
    requiredFieldsOnApprove: ['topic', 'attendees', 'urgency', 'desiredTimeframe']
  });
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
app.get('/api/calendar/oauth/initiate', requireAuth, requireRole('owner'), (req, res) => {
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
app.get('/api/calendar/availability', requireAuth, requireRole('owner'), async (req, res) => {
  if (!ensureOwnerGoogle(res)) return;
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
    messages: [
      { role: 'user', content: req.body.initialMessage || '', at: Date.now() }
    ]
  });
  res.json({ jobId });
});
app.get('/api/agent/stream/:jobId', requireAuth, async (req, res) => {
  const { jobId } = req.params;
  startSSE(res);
  streams.set(jobId, res);

  const emit = (event, data) => sseSend(res, event, data);

  emit('log', { msg: 'Agent starting...' });
  emit('chat', { role: 'assistant', content: 'Thanks for the details — I\'m evaluating your request now.' });
  const rec = readJSON(path.join(REQUESTS_DIR, `${jobId}.json`), null);
  if (!rec) {
    emit('error', { error: 'Unknown jobId' });
    return closeStream(jobId);
  }

  try {
    const decision = await agentDecideAndGather(
      {
        initialMessage: rec.initialMessage,
        userContext: { email: req.user?.email }
      },
      emit
    );

    if (decision.decision === 'APPROVE') {
      emit('log', { msg: 'Waiting for user details form...' });
      const ask = (decision.missing && decision.missing.length > 0) ? decision.missing : (loadConfig().requiredFieldsOnApprove || []);
      emit('gather', { ask });
      emit('chat', { role: 'assistant', content: `Thanks! To proceed, please provide: ${ask.join(', ')}.` });
      // keep stream open for details
    } else {
      const ask = (decision.missing && decision.missing.length > 0) ? decision.missing : ['topic', 'desiredTimeframe', 'agenda'];
      emit('gather', { ask });
      emit('chat', { role: 'assistant', content: `I need a bit more info before I can help: ${ask.join(', ')}.` });
      // do not close; allow user to send more context via chat
    }
  } catch (e) {
    emit('error', { error: e.message || 'Agent error' });
    closeStream(jobId);
  }
});

// append a chat message from the user and echo to stream
app.post('/api/agent/message', requireAuth, async (req, res) => {
  const { jobId, content } = req.body || {};
  if (!jobId || !content) return res.status(400).json({ error: 'jobId and content required' });
  const recordPath = path.join(REQUESTS_DIR, `${jobId}.json`);
  const rec = readJSON(recordPath, null);
  if (!rec) return res.status(404).json({ error: 'Unknown jobId' });
  const next = { ...rec, messages: [ ...(rec.messages || []), { role: 'user', content, at: Date.now() } ] };
  writeJSON(recordPath, next);
  const stream = streams.get(jobId);
  if (stream) sseSend(stream, 'chat', { role: 'user', content });
  return res.json({ ok: true });
});

app.post('/api/agent/complete', requireAuth, async (req, res) => {
  const { jobId, form } = req.body;
  const stream = streams.get(jobId);
  const emit = stream ? (e, d) => sseSend(stream, e, d) : () => {};
  const recordPath = path.join(REQUESTS_DIR, `${jobId}.json`);
  const rec = readJSON(recordPath, null);
  if (!rec) return res.status(404).json({ error: 'Unknown jobId' });

  writeJSON(recordPath, { ...rec, form });

  emit('log', { msg: 'Compiling briefing...' });
  const briefing = buildBriefing(req.user, form);
  emit('briefing', { briefing });
  const stream2 = streams.get(jobId);
  if (stream2) sseSend(stream2, 'chat', { role: 'assistant', content: 'I prepared a briefing draft based on your details. Scheduling now...' });

  if (!ensureOwnerGoogle(res)) {
    emit('error', { error: 'Owner Google not connected' });
    return;
  }
  try {
    const auth = googleClient();
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
    emit('done', { status: 'SCHEDULED' });
    res.json({ ok: true, event: event.data });
    closeStream(jobId);
  } catch (e) {
    emit('error', { error: e.message || 'Calendar error' });
    res.status(500).json({ error: 'Calendar error' });
    closeStream(jobId);
  }
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});


