import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { OwnerConsole } from './OwnerConsole';
import './styles.css';
// Public read-only demo and protected owner controls are mounted separately on purpose.
ReactDOM.createRoot(document.getElementById('root')).render(_jsxs(React.StrictMode, { children: [_jsx(App, {}), _jsx(OwnerConsole, {})] }));
