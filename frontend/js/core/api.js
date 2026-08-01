// core/api.js — peticiones REST autenticadas
const TOKEN = () => localStorage.getItem('txpl_token') || '';

export const api = async (method, path, body) => {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN()}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(window.API + '/api' + path, opts);
  if (r.status === 401) { window.doLogout?.(); return; }
  return r.json();
};

export const API = (window.API = window.location.origin);