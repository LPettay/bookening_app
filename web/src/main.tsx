import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthProvider } from '@descope/react-sdk';
import App from './App';

const env = (import.meta as any).env;
const projectId = env.VITE_DESCOPE_PROJECT_ID as string;
const descopeEnabled = String(env.VITE_DESCOPE_ENABLED ?? 'false') === 'true' && Boolean(projectId);

const app = (
  <React.StrictMode>
    {descopeEnabled ? (
      <AuthProvider projectId={projectId}>
        <App />
      </AuthProvider>
    ) : (
      <App />
    )}
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById('root')!).render(app);


