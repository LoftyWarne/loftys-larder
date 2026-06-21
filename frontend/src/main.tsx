import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app.tsx';
import './index.css';
import './print.css';
import { registerServiceWorker } from './sw-register.ts';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root is missing from index.html');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

registerServiceWorker();
