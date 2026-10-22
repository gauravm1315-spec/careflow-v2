import { api } from './api.js';
import { S, $, esc } from './ui.js';
import { ACTS, INPUTS, CHANGES, leave, go, mount, shell, pageHead, viewLogin } from './core.js';
import * as P from './patient.js';
import * as ST from './staff.js';

const ROUTES = [
  [/^#\/login$/, null, viewLogin],
  [/^#\/intake$/, ['patient'], P.viewIntake],
  [/^#\/cases$/, ['patient'], P.viewCases],
  [/^#\/case\/([\w-]+)$/, ['patient'], P.viewCase],
  [/^#\/queue$/, ['clinician', 'admin'], ST.viewQueue],
  [/^#\/review\/([\w-]+)$/, ['clinician', 'admin'], ST.viewReview],
  [/^#\/audit$/, ['clinician', 'admin'], ST.viewAudit],
  [/^#\/system$/, ['admin'], ST.viewSystem],
];

async function route() {
  leave.fn?.(); leave.fn = null;
  const h = location.hash || '#/';
  if (!S.me) { if (h !== '#/login') return go('#/login'); return viewLogin(); }
  if (h === '#/' || h === '') return go(S.me.role === 'patient' ? '#/intake' : '#/queue');
  for (const [re, roles, fn] of ROUTES) {
    const m = re.exec(h);
    if (!m) continue;
    if (roles && !roles.includes(S.me.role)) return go('#/');
    window.scrollTo(0, 0);
    try { return await fn(...m.slice(1)); } catch (e) {
      if (e.status === 401) { S.me = null; return go('#/login'); }
      return mount(shell(`<div class="empty">${esc(e.message)}<br><a href="#/">Back</a></div>`));
    }
  }
  mount(shell(`<div class="empty">Page not found. <a href="#/">Home</a></div>`));
}

// delegated events: one listener per type, handlers registered by views
document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el && el.tagName !== 'FORM') ACTS[el.dataset.act]?.(el, e); });
document.addEventListener('submit', (e) => { const el = e.target.closest('[data-act]'); if (el) ACTS[el.dataset.act]?.(el, e); });
document.addEventListener('input', (e) => { const k = e.target.dataset?.in; if (k) INPUTS[k]?.(e.target, e); });
document.addEventListener('change', (e) => { const k = e.target.dataset?.ch; if (k) CHANGES[k]?.(e.target, e); });
window.addEventListener('hashchange', route);

(async function boot() {
  document.documentElement.lang = S.lang;
  try { [S.health, S.rules] = await Promise.all([api('GET', '/health'), api('GET', '/rules')]); } catch { /* server down */ }
  try { S.me = (await api('GET', '/me')).user; } catch { S.me = null; }
  route();
})();
