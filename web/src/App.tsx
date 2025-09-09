import React, { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Route, Routes, Link, useNavigate } from 'react-router-dom';
import { useSession, useUser, useDescope, Descope } from '@descope/react-sdk';

const DESCOPE_ENABLED = String((import.meta as any).env.VITE_DESCOPE_ENABLED ?? 'false') === 'true' && Boolean((import.meta as any).env.VITE_DESCOPE_PROJECT_ID);

function useAppSession(): { isAuthenticated: boolean; user?: any } {
  if (DESCOPE_ENABLED) {
    const { isAuthenticated } = useSession();
    const { user } = useUser();
    return { isAuthenticated, user } as { isAuthenticated: boolean; user?: any };
  }
  return { isAuthenticated: true, user: { email: 'mock-user@example.com' } };
}

function useBackendSession() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    fetch('/api/auth/session', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => setData(null));
  }, []);
  return data;
}

function OwnerDashboard() {
  const session = useBackendSession();
  const [cfg, setCfg] = useState<any>(null);

  useEffect(() => {
    fetch('/api/config', { credentials: 'include' })
      .then(r => r.json()).then(setCfg)
      .catch(() => {});
  }, []);

  const save = async () => {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(cfg)
    });
    setCfg(await r.json());
  };
  const connectGoogle = async () => {
    const r = await fetch('/api/calendar/oauth/initiate', { credentials: 'include' });
    const j = await r.json();
    window.location.href = j.url;
  };

  if (!session) return <div>Loading...</div>;
  if (!(session.roles || []).includes('owner')) return <div>Forbidden</div>;

  return (
    <div>
      <h2>Owner Dashboard</h2>
      <p>User: {session.user?.email}</p>
      {cfg ? (
        <div>
          <h3>Decision Policy</h3>
          <select value={cfg.decisionPolicy} onChange={e => setCfg({ ...cfg, decisionPolicy: e.target.value })}>
            <option value="conservative">conservative</option>
            <option value="balanced">balanced</option>
            <option value="generous">generous</option>
          </select>
          <h3>Due Diligence</h3>
          <textarea
            rows={4}
            style={{ width: 400 }}
            value={(cfg.dueDiligenceChecklist || []).join('\n')}
            onChange={e => setCfg({ ...cfg, dueDiligenceChecklist: e.target.value.split('\n') })}
          />
          <div>
            <button onClick={save}>Save</button>
          </div>
        </div>
      ) : <div>Loading config...</div>}

      <hr />
      <h3>Google Calendar</h3>
      <button onClick={connectGoogle}>Connect Google</button>
      <div style={{ marginTop: 8 }}>
        <button onClick={async () => {
          const r = await fetch('/api/calendar/availability', { credentials: 'include' });
          const j = await r.json();
          alert(`Events next 7 days: ${j.count ?? 'n/a'}`);
        }}>Test Availability</button>
      </div>
    </div>
  );
}

function RequestMeeting() {
  const { isAuthenticated, user } = useAppSession();
  const { logout } = useDescope();
  const [initialMessage, setInitialMessage] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [decision, setDecision] = useState<any>(null);
  const [form, setForm] = useState<any>({ topic: '', attendees: '', urgency: 'medium', desiredTimeframe: '', background: '', links: '' });
  const [briefing, setBriefing] = useState<string>('');
  const [status, setStatus] = useState<string>('idle');
  type ChatMessage = { role: 'user' | 'assistant'; content?: string; agent?: 'user'|'chat'|'decision'; kind?: 'text'|'form'; schema?: any };
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [debug, setDebug] = useState(false);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const start = async () => {
    setLog([]);
    setDecision(null);
    setBriefing('');
    setMessages([{ role: 'assistant', content: 'Hi! I can help decide if a meeting is warranted and gather details. What would you like to discuss?' }]);
    const r = await fetch('/api/agent/start', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialMessage: '' })
    });
    const j = await r.json();
    setJobId(j.jobId);

    // close any existing stream
    if (esRef.current) { try { esRef.current.close(); } catch {} esRef.current = null; }
    const es = new EventSource(`/api/agent/stream/${j.jobId}`, { withCredentials: true } as any);
    esRef.current = es;
    es.addEventListener('log', (e: any) => {
      try { const d = JSON.parse(e.data); setLog((x) => [ ...x, d.msg ]); } catch { /* ignore */ }
    });
    es.addEventListener('decision', (e: any) => {
      try { setDecision(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    es.addEventListener('gather', (e: any) => {
      try {
        const { ask } = JSON.parse(e.data);
        const list = Array.isArray(ask) ? ask : [String(ask)];
        const content = `Please provide: ${list.join(', ')}`;
        setLog((x) => [ ...x, content ]);
        // Do not add a chat bubble here; the server also emits a matching 'chat' event.
      } catch { /* ignore */ }
    });
    es.addEventListener('briefing', (e: any) => {
      try { setBriefing(JSON.parse(e.data).briefing); } catch { /* ignore */ }
    });
    es.addEventListener('chat', (e: any) => {
      try {
        const m = JSON.parse(e.data);
        if (m?.role && m?.content) {
          setMessages((x) => {
            const last = x[x.length - 1];
            if (last && last.role === m.role && last.content === m.content && last.agent === (m.agent || (m.role === 'user' ? 'user' : 'chat'))) return x;
            return [ ...x, { role: m.role, content: m.content, agent: m.agent || (m.role === 'user' ? 'user' : 'chat') } ];
          });
        }
      } catch { /* ignore */ }
    });
    es.addEventListener('agent', (e: any) => {
      try {
        const { decision } = JSON.parse(e.data);
        const content = `[decision] ${decision.decision}: ${decision.rationale || ''}`;
        setMessages((x) => [ ...x, { role: 'assistant', content, agent: 'decision' } ]);
      } catch { /* ignore */ }
    });
    es.addEventListener('form', (e: any) => {
      try {
        const { schema } = JSON.parse(e.data);
        setMessages((x) => [ ...x, { role: 'assistant', kind: 'form', schema } ]);
      } catch { /* ignore */ }
    });
    es.addEventListener('scheduled', () => setStatus('scheduled'));
    es.addEventListener('done', (e: any) => {
      try { setStatus(JSON.parse(e.data).status); } catch { setStatus('done'); }
      es.close();
    });
    es.addEventListener('error', (e: any) => {
      try {
        const data = e?.data ? JSON.parse(e.data) : null;
        setLog((x) => [ ...x, `Error: ${data?.error || 'stream error'}` ]);
      } catch {
        setLog((x) => [ ...x, 'Error: stream error' ]);
      }
    });
    es.onerror = () => {
      setLog((x) => [ ...x, 'Stream closed' ]);
      try { es.close(); } catch {}
      esRef.current = null;
    };
  };

  useEffect(() => {
    // auto-start on first mount or after auth becomes available
    if (!jobId && (!DESCOPE_ENABLED || isAuthenticated)) {
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  useEffect(() => {
    return () => { if (esRef.current) { try { esRef.current.close(); } catch {} } };
  }, []);

  const complete = async () => {
    if (!jobId) return;
    const payload = {
      topic: form.topic,
      attendees: form.attendees.split(',').map((s: string) => s.trim()).filter(Boolean),
      urgency: form.urgency,
      desiredTimeframe: form.desiredTimeframe,
      background: form.background,
      links: form.links.split(',').map((s: string) => s.trim()).filter(Boolean)
    };
    const r = await fetch('/api/agent/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, form: payload })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setLog((x) => [ ...x, `Complete error: ${j.error || 'unknown'}` ]);
    }
  };

  const sendChat = async () => {
    if (!jobId || !chatInput.trim()) return;
    const content = chatInput.trim();
    setChatInput('');
    try {
      await fetch('/api/agent/message', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, content })
      });
    } catch {
      setLog((x) => [ ...x, 'Failed to send message' ]);
    }
  };

  if (DESCOPE_ENABLED && !isAuthenticated) {
    return (
      <div>
        <h2>Log in</h2>
        <Descope
          flowId="sign-up-or-in"
          theme="light"
          tenant=""
        />
      </div>
    );
  }

  return (
    <div className="page">
      <h2>Chat</h2>
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="subtitle">Signed in as {user?.email || 'mock-user@example.com'}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {DESCOPE_ENABLED && <button onClick={() => logout()}>Sign out</button>}
          <label className="subtitle"><input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> Debug</label>
        </div>
      </div>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Conversation</h3>
          <div className="chat-list">
            {(debug ? messages : messages.filter(m => m.agent !== 'decision')).map((m, i) => {
              if (m.kind === 'form' && m.schema) {
                const schema = m.schema as any;
                return (
                  <div key={i} className="bubble assistant">
                      <div className="subtitle">assistant · form</div>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>{schema.title || 'Details'}</div>
                      <FormFields schema={schema} disabled={formSubmitting} onSubmit={async (values) => {
                        if (!jobId) return;
                        setFormSubmitting(true);
                        try {
                          await fetch('/api/agent/form/submit', {
                            method: 'POST',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ jobId, formId: schema.id, values })
                          });
                        } finally {
                          setFormSubmitting(false);
                        }
                      }} />
                  </div>
                );
              }
              return (
                <div key={i} className={`bubble ${m.role}`}>
                  <div className="subtitle">{m.role}{debug && m.agent ? ` · ${m.agent}` : ''}</div>
                  <div>{m.content}</div>
                </div>
              );
            })}
            {messages.length === 0 && <div style={{ color: '#64748b' }}>No messages yet.</div>}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              placeholder="Type a message"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendChat(); }}
              style={{ flex: 1 }}
              disabled={!jobId}
            />
            <button onClick={sendChat} disabled={!jobId || !chatInput.trim()}>Send</button>
          </div>
        </div>

        <div className="card">
          {decision && (
            <div style={{ marginBottom: 16 }}>
              <strong>Decision:</strong> {decision.decision} — {decision.rationale}
            </div>
          )}

          {decision?.decision === 'APPROVE' && !messages.some(m => m.kind === 'form') && (
            <div style={{ marginBottom: 16 }}>
              <h3>Provide Details</h3>
              <input placeholder="Topic" value={form.topic} onChange={e => setForm({ ...form, topic: e.target.value })} />
              <input placeholder="Attendees (comma-separated emails)"
                value={form.attendees} onChange={e => setForm({ ...form, attendees: e.target.value })} />
              <select value={form.urgency} onChange={e => setForm({ ...form, urgency: e.target.value })}>
                <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
              </select>
              <input placeholder="Desired timeframe" value={form.desiredTimeframe}
                onChange={e => setForm({ ...form, desiredTimeframe: e.target.value })} />
              <textarea rows={3} placeholder="Background"
                value={form.background} onChange={e => setForm({ ...form, background: e.target.value })} />
              <input placeholder="Links (comma-separated URLs)"
                value={form.links} onChange={e => setForm({ ...form, links: e.target.value })} />
              <div><button onClick={complete}>Submit Details & Schedule</button></div>
            </div>
          )}

          {briefing && (
            <div style={{ marginTop: 16 }}>
              <h3>Briefing Preview</h3>
              <pre style={{ background: '#f3f3f3', padding: 8 }}>{briefing}</pre>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <h3>Activity</h3>
            <ul>{log.map((l, i) => <li key={i}>{l}</li>)}</ul>
            <div className="subtitle">Status: {status}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Inline form renderer
function FormFields({ schema, onSubmit, disabled }: { schema: any; onSubmit: (vals: any) => void | Promise<void>; disabled?: boolean }) {
  const [vals, setVals] = useState<any>({ urgency: 'medium' });
  const set = (k: string, v: any) => setVals((x: any) => ({ ...x, [k]: v }));
  const fieldEl = (f: any) => {
    const common = { disabled } as any;
    if (f.input === 'textarea') return <textarea {...common} rows={3} placeholder={f.label} value={vals[f.key] || ''} onChange={e => set(f.key, e.target.value)} />;
    if (f.input === 'select') return (
      <select {...common} value={vals[f.key] || (f.options?.[0] || '')} onChange={e => set(f.key, e.target.value)}>
        {(f.options || []).map((o: string) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
    return <input {...common} placeholder={f.label} value={vals[f.key] || ''} onChange={e => set(f.key, e.target.value)} />;
  };
  return (
    <div>
      <div style={{ display: 'grid', gap: 6, gridTemplateColumns: '1fr 1fr 120px 1fr' }}>
        {(schema.fields || []).map((f: any) => (
          <div key={f.key} style={{ gridColumn: f.input === 'textarea' ? '1 / -1' : 'auto' }}>
            {fieldEl(f)}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button disabled={disabled} onClick={() => onSubmit(vals)}>Submit Details & Schedule</button>
      </div>
    </div>
  );
}

function Home() {
  const { isAuthenticated, user } = useAppSession();
  const navigate = useNavigate();
  return (
    <div className="page">
      <h2>Calendar Gatekeeper</h2>
      <div style={{ display: 'flex', gap: 12 }}>
        <button onClick={() => navigate('/request')}>Request a Meeting</button>
        <button onClick={() => navigate('/owner')}>Owner Dashboard</button>
      </div>
      {DESCOPE_ENABLED && !isAuthenticated && (
        <div style={{ marginTop: 12 }}>
          <Descope flowId="sign-up-or-in" theme="light" />
        </div>
      )}
      {(!DESCOPE_ENABLED || isAuthenticated) && <div>Signed in as {user?.email || 'mock-user@example.com'}</div>}
    </div>
  );
}

export default function App() {
  const session = useBackendSession();
  const roles = session?.roles || [];
  const isOwner = roles.includes('owner');
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<RequestMeeting />} />
        <Route path="/request" element={<RequestMeeting />} />
        <Route path="/owner" element={<OwnerDashboard />} />
      </Routes>
    </BrowserRouter>
  );
}


