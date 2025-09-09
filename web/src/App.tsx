import React, { useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes, Link, useNavigate } from 'react-router-dom';
import { useSession, Descope } from '@descope/react-sdk';

const DESCOPE_ENABLED = String((import.meta as any).env.VITE_DESCOPE_ENABLED ?? 'false') === 'true' && Boolean((import.meta as any).env.VITE_DESCOPE_PROJECT_ID);

function useAppSession(): { isAuthenticated: boolean; user?: any } {
  if (DESCOPE_ENABLED) {
    return useSession() as unknown as { isAuthenticated: boolean; user?: any };
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
  const { isAuthenticated } = useAppSession();
  const [initialMessage, setInitialMessage] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [decision, setDecision] = useState<any>(null);
  const [form, setForm] = useState<any>({ topic: '', attendees: '', urgency: 'medium', desiredTimeframe: '', background: '', links: '' });
  const [briefing, setBriefing] = useState<string>('');
  const [status, setStatus] = useState<string>('idle');
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');

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

    const es = new EventSource(`/api/agent/stream/${j.jobId}`, { withCredentials: true } as any);
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
        setLog((x) => [ ...x, `Please provide: ${list.join(', ')}` ]);
        setMessages((x) => [ ...x, { role: 'assistant', content: `Please provide: ${list.join(', ')}` } ]);
      } catch { /* ignore */ }
    });
    es.addEventListener('briefing', (e: any) => {
      try { setBriefing(JSON.parse(e.data).briefing); } catch { /* ignore */ }
    });
    es.addEventListener('chat', (e: any) => {
      try { const m = JSON.parse(e.data); if (m?.role && m?.content) setMessages((x) => [ ...x, { role: m.role, content: m.content } ]); } catch { /* ignore */ }
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
      es.close();
    };
  };

  useEffect(() => {
    if (!jobId) {
      start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setMessages((x) => [ ...x, { role: 'user', content } ]);
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
    <div>
      <h2>Chat</h2>
      <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
        <div style={{ flex: 1, minWidth: 300 }}>
          <h3>Conversation</h3>
          <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: 8, height: 300, overflowY: 'auto', background: '#fff' }}>
            {messages.map((m, i) => (
              <div key={i} style={{ marginBottom: 8, display: 'flex' }}>
                <div style={{
                  marginLeft: m.role === 'assistant' ? 0 : 'auto',
                  maxWidth: '80%',
                  background: m.role === 'assistant' ? '#f1f5f9' : '#dbeafe',
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  padding: '6px 8px'
                }}>
                  <div style={{ fontSize: 12, color: '#475569', marginBottom: 2 }}>{m.role}</div>
                  <div>{m.content}</div>
                </div>
              </div>
            ))}
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

        <div style={{ flex: 1, minWidth: 300 }}>
          {decision && (
            <div style={{ marginBottom: 16 }}>
              <strong>Decision:</strong> {decision.decision} — {decision.rationale}
            </div>
          )}

          {decision?.decision === 'APPROVE' && (
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
            <div>Status: {status}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Home() {
  const { isAuthenticated, user } = useAppSession();
  const navigate = useNavigate();
  return (
    <div>
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
  return (
    <BrowserRouter>
      <nav style={{ display: 'flex', gap: 12 }}>
        <Link to="/">Home</Link>
        <Link to="/request">Request</Link>
        <Link to="/owner">Owner</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/request" element={<RequestMeeting />} />
        <Route path="/owner" element={<OwnerDashboard />} />
      </Routes>
    </BrowserRouter>
  );
}


