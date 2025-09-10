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
      field('topic', 'Meeting title', 'text'),
      field('attendees', 'Attendees (comma-separated emails)', 'email_list'),
      field('background', 'Background', 'textarea')
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

// Descope token fetching for Google Calendar access
async function fetchGoogleTokensFromDescope(userId, userEmail) {
  if (!DESCOPE_ENABLED || !descope) {
    console.log('Descope not enabled, using fallback token mechanism');
    return null;
  }

  try {
    // Use Descope's outbound app functionality to fetch Google tokens
    // This assumes you have configured a Google Calendar outbound app in Descope
    const outboundApps = await descope.management.outboundApp.list();
    
    // Find the Google Calendar outbound app
    const googleApp = outboundApps.outboundApps?.find(app => 
      app.type === 'google' && app.name?.toLowerCase().includes('calendar')
    );
    
    if (!googleApp) {
      console.log('No Google Calendar outbound app found in Descope');
      return null;
    }

    // Fetch tokens for the specific user
    const tokens = await descope.management.outboundApp.getTokens(googleApp.id, userId);
    
    if (tokens && tokens.accessToken) {
      console.log(`Successfully fetched Google tokens for user ${userEmail} via Descope`);
      return {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expiry_date: tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : undefined,
        token_type: 'Bearer'
      };
    }
    
    console.log(`No valid tokens found for user ${userEmail} in Descope`);
    return null;
  } catch (error) {
    console.error('Error fetching Google tokens from Descope:', error.message);
    return null;
  }
}

// Enhanced Google client that can fetch tokens from Descope
function googleClientWithDescope(userId = null, userEmail = null) {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  // Try Descope first if user info is provided
  if (userId && userEmail && DESCOPE_ENABLED) {
    // This will be called asynchronously, so we'll handle it in the calling functions
    return { oAuth2Client, userId, userEmail, useDescope: true };
  }

  // Fallback to existing token mechanisms
  const envAccess = process.env.GOOGLE_ACCESS_TOKEN;
  const envRefresh = process.env.GOOGLE_REFRESH_TOKEN;
  if (envAccess || envRefresh) {
    const expiry = process.env.GOOGLE_TOKEN_EXPIRY ? Number(process.env.GOOGLE_TOKEN_EXPIRY) : undefined;
    oAuth2Client.setCredentials({ access_token: envAccess, refresh_token: envRefresh, expiry_date: expiry });
    return { oAuth2Client, useDescope: false };
  }

  // Fallback to locally stored tokens
  const tokens = readJSON(TOKENS_PATH, null);
  if (tokens) oAuth2Client.setCredentials(tokens);
  return { oAuth2Client, useDescope: false };
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
async function suggestSlotsCore(userId, { days = 7, durationMins = 30, windowStart = '09:00', windowEnd = '17:00', ownerOnly = true, userEmail = null } = {}) {
  if (!ensureOwnerGoogle({ status: () => ({ json: () => {} }) })) return { suggestions: [] }; // no-op when not connected
  
  let ownerAuth = googleClient();
  let userAuth = null;
  let useOwnerOnly = ownerOnly;
  
  // Try to get user tokens from Descope first
  if (!ownerOnly && userId && userEmail && DESCOPE_ENABLED) {
    try {
      const descopeTokens = await fetchGoogleTokensFromDescope(userId, userEmail);
      if (descopeTokens) {
        const oAuth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI
        );
        oAuth2Client.setCredentials(descopeTokens);
        userAuth = oAuth2Client;
        useOwnerOnly = false;
        console.log(`Using Descope tokens for user ${userEmail} calendar access`);
      }
    } catch (error) {
      console.log(`Failed to fetch Descope tokens for user ${userEmail}, falling back to local tokens:`, error.message);
    }
  }
  
  // Fallback to existing token mechanisms
  if (!userAuth) {
    const userHasTokens = hasUserGoogle(userId);
    useOwnerOnly = ownerOnly || !userHasTokens;
    userAuth = !useOwnerOnly ? googleClientForUser(userId) : null;
  }

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

// Enhanced scheduling function that can use Descope tokens
async function scheduleEventWithDescope(userId, userEmail, form, slot, briefing) {
  let auth = null;
  let useDescope = false;
  
  // Try Descope first if user info is provided
  if (userId && userEmail && DESCOPE_ENABLED) {
    try {
      const descopeTokens = await fetchGoogleTokensFromDescope(userId, userEmail);
      if (descopeTokens) {
        const oAuth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI
        );
        oAuth2Client.setCredentials(descopeTokens);
        auth = oAuth2Client;
        useDescope = true;
        console.log(`Using Descope tokens for user ${userEmail} calendar scheduling`);
      }
    } catch (error) {
      console.log(`Failed to fetch Descope tokens for user ${userEmail}, falling back to local tokens:`, error.message);
    }
  }
  
  // Fallback to existing token mechanisms
  if (!auth) {
    const useUser = hasUserGoogle(userId);
    if (!useUser && !ensureOwnerGoogle({ status: () => ({ json: () => {} }) })) {
      throw new Error('No Google authentication available');
    }
    auth = useUser ? googleClientForUser(userId) : googleClient();
  }

  const calendar = google.calendar({ version: 'v3', auth });
  const start = slot?.start ? new Date(slot.start) : new Date();
  const end = slot?.end ? new Date(slot.end) : new Date(start.getTime() + 30 * 60 * 1000);
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
  
  return { event: event.data, useDescope };
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
    decisionPolicy: 'balanced',
    requiredFieldsOnApprove: ['topic', 'attendees', 'desiredTimeframe']
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

  const sys = `You are a pragmatic meeting triage agent.
Policy=${cfg.decisionPolicy}. Focus on the user's diligence (clear agenda, desired outcome, prior effort) and the expected value of a meeting.

IMPORTANT: Pay attention to the user's CURRENT intent, not just the conversation history. If a user initially asks an informational question but then expresses a desire for a meeting, evaluate the meeting request on its own merits.

Do NOT approve meetings for:
- Simple informational questions that can be answered directly (unless the user then requests a meeting)
- Basic how-to questions or documentation requests (unless the user then requests a meeting)
- Questions about product features that are purely informational (unless the user then requests a meeting)

APPROVE meetings when the user:
- Explicitly requests a meeting AND provides clear justification for why a meeting is needed
- Needs collaborative discussion or brainstorming that can't be done asynchronously
- Requires decision-making with multiple stakeholders
- Has complex problem-solving that benefits from real-time interaction
- Wants project planning or strategy sessions
- Needs technical deep-dives that require back-and-forth discussion
- Has follow-up questions that require interactive discussion

When a user requests a meeting but lacks clear justification, probe for:
- What specific aspect they want to discuss that wasn't already covered
- What additional value a meeting would provide over the information already given
- What specific outcome they're hoping to achieve
- Who needs to be involved and why
- What background context is relevant
- What they've already tried or researched

If the user's question was already fully answered and they just say "Can we have a meeting?" without additional context, ask clarifying questions about what specific value the meeting would provide.

Do not request dates/times at this stage; scheduling happens later after approval.
When APPROVED, you will later gather: topic, attendees (emails), desiredTimeframe, background, links.
In your JSON, the "missing" array should contain diligence-only items (choose from: agenda, outcome, priorResearch, context, links, attendees). Never include date/time.`;

  const prompt = `
Checklist: ${cfg.dueDiligenceChecklist.join(' | ')}
User's latest message: ${initialMessage}
Known context: ${JSON.stringify(userContext || {})}

IMPORTANT: Focus on the user's CURRENT intent. If they initially asked an informational question but then expressed a desire for a meeting, evaluate the meeting request on its own merits. Look for explicit meeting requests like "I would like a meeting", "Can we discuss", "I need to schedule", etc.

Decide: APPROVE or DECLINE with brief rationale. Then list missing diligence fields if any (no dates or times).
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

  const system = `You are a warm, helpful assistant who can answer questions directly and help with meeting requests.
Maintain memory using the provided transcript.
If the user is asking informational questions (like "what is X" or "how does Y work"), provide helpful answers directly.
If the user then expresses a desire for a meeting or discussion, help them clarify what additional value the meeting would provide.
When a user requests a meeting but lacks clear justification, ask clarifying questions to understand:
- What specific aspect they want to discuss that wasn't already covered
- What additional value a meeting would provide over the information already given
- What specific outcome they're hoping to achieve
- Who needs to be involved in the discussion and why
- What background context is relevant
- What they've already tried or researched

If you've already provided a complete answer to their question and they just ask "Can we have a meeting?" without additional context, ask what specific value the meeting would provide or what additional questions they have.
Do not ask for dates or times; scheduling happens later after approval.
Always acknowledge what was already given; ask at most one clarifying question if truly needed.
Speak naturally in 1-3 short sentences. Avoid mentioning internal decision processes.

Basic Descope knowledge:
- Magic Link: A passwordless authentication method where users receive a link via email/SMS that logs them in when clicked. No password required.
- Enchanted Link: A more advanced version of magic link that includes additional features like custom branding, expiration times, and enhanced security measures.
- Both are used for passwordless authentication, but enchanted links offer more customization and security options.`;

  const userSummary = `Conversation transcript (most recent first):\n${(transcript || []).join('\n')}`;
  const need = (ask && ask.length) ? ask.join(', ') : '';
  const hint = decision?.decision ? `Current internal stance: ${decision.decision}. If DECLINED, provide helpful information instead of suggesting a meeting.` : '';

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

// Generate concise meeting title/background from transcript
async function summarizeForForm(transcriptLines) {
  if (!openai) {
    const last = transcriptLines[transcriptLines.length - 1] || '';
    return { title: last.slice(0, 60), background: transcriptLines.join('\n').slice(0, 400) };
  }
  const sys = `You create concise meeting details from chat transcripts.
Return strictly in JSON: {"title": string, "background": string}.
Title: <= 8 words, specific, no punctuation at end. Background: 1-3 short sentences.`;
  const user = `Transcript:\n${transcriptLines.join('\n')}`;
  const r = await openai.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ]
  });
  try { return JSON.parse(r.choices?.[0]?.message?.content || '{}'); } catch { return { title: '', background: '' }; }
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

  // Use the enhanced suggestSlotsCore function that supports Descope tokens
  const result = await suggestSlotsCore(req.user?.userId, {
    days,
    durationMins,
    windowStart,
    windowEnd,
    ownerOnly,
    userEmail: req.user?.email
  });

  res.json(result);
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

// Descope token fetching endpoint for calendar access
app.post('/api/calendar/descope-tokens', requireAuth, async (req, res) => {
  try {
    const { userId, userEmail } = req.body;
    const targetUserId = userId || req.user?.userId;
    const targetUserEmail = userEmail || req.user?.email;
    
    if (!targetUserId || !targetUserEmail) {
      return res.status(400).json({ error: 'User ID and email are required' });
    }

    const tokens = await fetchGoogleTokensFromDescope(targetUserId, targetUserEmail);
    
    if (tokens) {
      res.json({ 
        success: true, 
        tokens: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expiry_date: tokens.expiry_date,
          token_type: tokens.token_type
        }
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'No valid Google tokens found in Descope for this user' 
      });
    }
  } catch (error) {
    console.error('Error fetching Descope tokens:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch tokens from Descope' 
    });
  }
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
      const slots = await suggestSlotsCore(req.user?.userId, { 
        ownerOnly: true, 
        userEmail: req.user?.email 
      });
      emit('tool', { name: 'calendar.suggest', status: 'result', result: { count: (slots.suggestions || []).length }, ...toolContext });
      emit('agent', { role: 'assistant', agent: 'calendar', suggestions: slots.suggestions });
    }
    // store decision agent message and stream on 'agent'
    appendMessage(jobId, { role: 'assistant', agent: 'decision', content: JSON.stringify(decision) });

    const ask = (decision.missing && decision.missing.length > 0)
      ? decision.missing
      : (decision.decision === 'APPROVE' ? (loadConfig().requiredFieldsOnApprove || []) : []);
    const transcriptLines = (next.messages || []).map(m => `${m.role}: ${m.content}`).slice(-12); // last 12 exchanges
    
    // If approved and details are needed, show inline form and skip extra assistant follow-up
    if (decision.decision === 'APPROVE' && ask.length > 0) {
      emit('gather', { ask });
      const formSchema = buildFormSchema(ask);
      const prefill = await summarizeForForm(transcriptLines);
      const streamForm = streams.get(jobId);
      if (streamForm) sseSend(streamForm, 'form', { schema: formSchema, prefill });
    } else {
      // For declined meetings or approved meetings with no missing details, provide helpful response
      const userMsgs = (next.messages || []).filter(m => m.role === 'user').map(m => m.content);
      const chatText = await chatAgentGenerate({ ask, userMessages: userMsgs, decision, transcript: transcriptLines });
      appendMessage(jobId, { role: 'assistant', agent: 'chat', content: chatText });
      emit('chat', { role: 'assistant', agent: 'chat', content: chatText });
    }
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

  try {
    updateState(jobId, 'scheduling');
    emit('tool', { name: 'calendar.schedule', status: 'call', args: { start: slot?.start || new Date().toISOString(), end: slot?.end || new Date(Date.now() + 30 * 60 * 1000).toISOString(), attendees: (form.attendees || []).map(a => a) }, actor: { email: req.user?.email, userId: req.user?.userId } });
    
    const { event, useDescope } = await scheduleEventWithDescope(
      req.user?.userId, 
      req.user?.email, 
      form, 
      slot, 
      briefing
    );
    
    emit('tool', { name: 'calendar.schedule', status: 'result', result: { id: event.id, link: event.htmlLink, useDescope } });
    emit('scheduled', { eventId: event.id, htmlLink: event.htmlLink });
    updateState(jobId, 'notified');
    emit('done', { status: 'SCHEDULED' });
    appendMessage(jobId, { role: 'assistant', agent: 'chat', content: 'Invite sent. You should receive a calendar email shortly.' });
    if (streams.get(jobId)) sseSend(streams.get(jobId), 'chat', { role: 'assistant', agent: 'chat', content: 'Invite sent. You should receive a calendar email shortly.' });
    res.json({ ok: true, event });
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
  const { jobId, formId, values, slot } = req.body || {};
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

  try {
    updateState(jobId, 'scheduling');
    
    const { event, useDescope } = await scheduleEventWithDescope(
      req.user?.userId, 
      req.user?.email, 
      form, 
      slot, 
      briefing
    );
    
    emit('scheduled', { eventId: event.id, htmlLink: event.htmlLink });
    updateState(jobId, 'notified');
    emit('done', { status: 'SCHEDULED' });
    appendMessage(jobId, { role: 'assistant', agent: 'chat', content: 'Invite sent. You should receive a calendar email shortly.' });
    if (streams.get(jobId)) sseSend(streams.get(jobId), 'chat', { role: 'assistant', agent: 'chat', content: 'Invite sent. You should receive a calendar email shortly.' });
    return res.json({ ok: true, event });
  } catch (e) {
    emit('error', { error: e.message || 'Calendar error' });
    updateState(jobId, 'error');
    return res.status(500).json({ error: 'Calendar error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});


