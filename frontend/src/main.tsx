import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app.tsx';
import './index.css';
import './print.css';
import { initSentry } from './lib/sentry.ts';
import { registerServiceWorker } from './sw-register.ts';

// Init Sentry before React renders so error boundaries and unhandled
// rejections surface from the very first frame. No-op without a DSN.
initSentry();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root is missing from index.html');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerServiceWorker();
