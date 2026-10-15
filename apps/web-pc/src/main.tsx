import './account-link';
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AdminApp from "./AdminApp";
import CreatorApp from './CreatorApp';
import { TeamGate } from './TeamAccess';
import { teamPreview } from './team-preview';
import "./index.css";
import "./mobile-prototype/prototype.css";

if (!new URLSearchParams(window.location.search).has("__legacy_migration")) ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {window.location.pathname.replace(/\/+$/,'') === '/admin' ? <AdminApp /> : window.location.pathname.replace(/\/+$/,'') === '/creator' ? <CreatorApp/> : teamPreview ? <TeamGate>{() => <App />}</TeamGate> : <App />}
  </React.StrictMode>
);
