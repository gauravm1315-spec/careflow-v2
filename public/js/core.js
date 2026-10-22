// Shell, event registry and tiny hash router shared by every view.
import { S, $, esc, t } from './ui.js';
import { api } from './api.js';

export const ACTS = {};     // click handlers   (data-act)
export const INPUTS = {};   // input handlers   (data-in)
export const CHANGES = {};  // change handlers  (data-ch)
export const leave = { fn: null }; // cleanup of the current view (timers etc.)

export const go = (h) => { if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h; };
export const mount = (html) => { $('#app').innerHTML = html; };

const NAV = {
  patient: () => [['#/intake', t('intake')], ['#/cases', t('mycases')]],
  clinician: () => [['#/queue', 'Review queue'], ['#/audit', 'Audit log']],
  admin: () => [['#/queue', 'Review queue'], ['#/audit', 'Audit log'], ['#/system', 'System']],
};

export function shell(inner, head = '') {
  const me = S.me, cur = location.hash.split('/')[1];
  const links = NAV[me.role]().map(([h, l]) => `<a href="${h}" ${h.split('/')[1] === cur || (cur === 'review' && h === '#/queue') || (cur === 'case' && h === '#/cases') ? 'aria-current="page"' : ''}>${esc(l)}</a>`).join('');
  return `<div class="shell">
    <aside class="rail">
      <a class="brand" href="#/">care<i>flow</i><small>triage · decision support</small></a>
      <nav aria-label="Main">${links}</nav>
      <div class="who">
        <div class="langsw" role="group" aria-label="Language"><button data-act="lang" data-l="en" aria-pressed="${S.lang === 'en'}">EN</button><button data-act="lang" data-l="hi" aria-pressed="${S.lang === 'hi'}">हिं</button></div>
        <p style="margin:10px 0 2px"><b>${esc(me.name)}</b><span class="faint" style="text-transform:capitalize">${me.role}</span></p>
        <button class="btn link small" data-act="logout">${esc(t('signout'))}</button>
      </div>
    </aside>
    <main class="main">${head}${inner}</main></div>`;
}

export const pageHead = (title, sub = '', right = '') => `<header class="page-head"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div><div class="row">${right}</div></header>`;

// ---- login ----
let L = { role: 'patient', name: 'Asha Verma' };
const ROLES = [['patient', 'Patient', 'Give consent, describe symptoms, answer follow-up questions.', 'Asha Verma'],
  ['clinician', 'Clinician', 'Prioritised queue, evidence review, edit and approve notes.', 'Dr. A. Rao'],
  ['admin', 'Administrator', 'Audit trail, system status, read-only case access.', 'K. Iyer']];

export function viewLogin() {
  const hint = S.health?.staffPinHint;
  mount(`<div class="login">
    <section class="hero"><a class="brand" href="#/">care<i>flow</i><small>triage · decision support</small></a>
      <div><h1>Every patient heard. Every decision <em>human.</em></h1>
      <p style="max-width:46ch;opacity:.85;margin-top:18px">Voice, text and reports in Indian languages, organised with the evidence attached — by a small language model on your own machine when it is available, by plain rules when it is not — so clinicians see who needs attention first.</p></div>
      <p class="tiny mono" style="opacity:.65">PROTOTYPE · NOT A DIAGNOSTIC DEVICE · SYNTHETIC DATA ONLY</p></section>
    <section class="form"><form data-act="login-submit" autocomplete="off" style="max-width:430px">
      <h2 style="font-size:28px">Sign in</h2><p class="muted" style="margin:4px 0 0">Choose how you are using CareFlow.</p>
      <fieldset class="roles">${ROLES.map(([r, n, d]) => `<button type="button" data-act="pick-role" data-r="${r}" aria-pressed="${L.role === r}"><b>${n}</b><span>${d}</span></button>`).join('')}</fieldset>
      <label class="field"><span>Name</span><input type="text" id="lname" value="${esc(L.name)}" required></label>
      ${L.role !== 'patient' ? `<label class="field"><span>Staff PIN</span><input type="password" id="lpin" inputmode="numeric" required>${hint ? `<small class="faint">Demo PIN: <b class="mono">${esc(hint)}</b></small>` : ''}</label>` : ''}
      <p id="lerr" class="small" style="color:var(--urgent);min-height:20px" role="alert"></p>
      <button class="btn lg" type="submit">Continue →</button></form></section></div>`);
}
ACTS['pick-role'] = (el) => { L.role = el.dataset.r; L.name = ROLES.find((r) => r[0] === L.role)[3]; viewLogin(); };
ACTS['login-submit'] = async (form, e) => {
  e.preventDefault();
  try {
    const { user } = await api('POST', '/login', { role: L.role, name: $('#lname').value, pin: $('#lpin')?.value });
    S.me = user; go(user.role === 'patient' ? '#/intake' : '#/queue');
  } catch (err) { $('#lerr').textContent = err.message; }
};
ACTS.logout = async () => { await api('POST', '/logout', {}); S.me = null; go('#/login'); };
ACTS.lang = (el) => { S.lang = el.dataset.l; localStorage.setItem('cf_lang', S.lang); document.documentElement.lang = S.lang; window.dispatchEvent(new HashChangeEvent('hashchange')); };
