import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { OwnerConsole } from './OwnerConsole';
import './styles.css';

// Public read-only demo and protected owner controls are mounted separately on purpose.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <OwnerConsole />
  </React.StrictMode>,
);
