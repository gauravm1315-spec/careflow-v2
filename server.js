// CareFlow server — zero dependencies (Node >= 20).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, ROOT } from './lib/env.js';
import { data, save, audit, verifyAudit, resetAll, readFile, deleteCaseFiles, uid } from './lib/db.js';
import { makeToken, readToken, patientId, pinOk } from './lib/auth.js';
import { publicRules } from './lib/safety.js';
import * as slm from './lib/slm.js';
import * as stt from './lib/stt.js';
import { extractPdfText } from './lib/pdftext.js';
import { parseLabLines } from './lib/fallback.js';
import { normalizeReportExtraction } from './lib/normalize.js';
import { PII_LIMITATIONS, initPii, nerAvailable } from './lib/pii.js';
import { getRules, sortQueue } from './lib/priority.js';
import { createCase, submitAnswers, forPatient, forStaff, listItem, buildNote, LABEL } from './lib/pipeline.js';
import { seedIfEmpty, seedDemo } from './lib/seed.js';

const PUB = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_BODY = 40 * 1024 * 1024;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const STAFF = ['clinician', 'admin'];

// uploads waiting to be attached to a case (kept in memory, 30 min TTL)
const pending = new Map();
const sweep = () => { for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60e3) pending.delete(k); };
const takePending = (token, owner, kind) => {
  const p = pending.get(token);
  if (!p || p.owner !== owner || p.kind !== kind) throw new HttpError(400, 'Upload expired — please add it again.');
  return p;
};

const AUDIO_OK = /^audio\/(wav|x-wav|wave|mp3|mpeg|aac|ogg|flac|webm|mp4|x-m4a|aiff)/i;
const REPORT_OK = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const normMime = (m) => String(m || '').split(';')[0].trim().toLowerCase().replace('audio/x-wav', 'audio/wav').replace('audio/wave', 'audio/wav').replace('audio/x-m4a', 'audio/aac');

function getCase(id, user) {
  const c = data().cases.find((x) => x.id === id);
  if (!c) throw new HttpError(404, 'Case not found');
  if (user.role === 'patient' && c.ownerId !== user.id) throw new HttpError(404, 'Case not found'); // do not reveal existence
  return c;
}
const aiMessage = (e) => e?.message || 'The service could not process this right now.';

// ---------------------------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, roles, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, fn });

route('GET', '/api/health', null, async ({ url }) => ({ ok: true, slm: await slm.status({ fresh: url.searchParams.get('fresh') === '1' }), stt: stt.sttStatus(), demo: cfg.demoMode, staffPinHint: cfg.demoMode ? cfg.staffPin : null,
  privacy: { ner: nerAvailable(), limitations: PII_LIMITATIONS, remoteRawAllowed: cfg.allowRemoteRaw } }));
route('GET', '/api/priority-rules', null, () => getRules());
route('GET', '/api/rules', null, () => publicRules());

route('POST', '/api/login', null, ({ body, res }) => {
  const role = ['patient', 'clinician', 'admin'].includes(body.role) ? body.role : null;
  const name = String(body.name || '').trim().slice(0, 60);
  if (!role || !name) throw new HttpError(400, 'Choose a role and enter your name.');
  if (role !== 'patient' && !pinOk(body.pin)) { audit({ name, role }, 'Failed staff sign-in'); throw new HttpError(401, 'Incorrect staff PIN.'); }
  const user = { id: role === 'patient' ? patientId(name) : `s_${name.toLowerCase().replace(/\W+/g, '')}`, name, role };
  res.setHeader('Set-Cookie', `cf_session=${makeToken(user)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
  audit(user, 'Signed in');
  return { user };
});
route('POST', '/api/logout', null, ({ res, user }) => {
  res.setHeader('Set-Cookie', 'cf_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  if (user) audit(user, 'Signed out');
  return { ok: true };
});
route('GET', '/api/me', null, ({ user }) => ({ user }));

// ---- AI helpers used during intake ----
route('POST', '/api/transcribe', ['patient', 'clinician'], async ({ body, user }) => {
  sweep();
  const mime = normMime(body.mime);
  if (!AUDIO_OK.test(mime)) throw new HttpError(400, 'Unsupported audio format.');
  const buf = Buffer.from(String(body.data || ''), 'base64');
  if (buf.length < 800) throw new HttpError(400, 'Recording is empty.');
  if (buf.length > 12 * 1024 * 1024) throw new HttpError(413, 'Recording too long (max ~3 minutes).');
  let t;
  try { t = await stt.transcribe({ buf, mime, lang: body.lang }); } catch (e) { audit(user, 'Local transcription unavailable', null, e.code); throw new HttpError(e.code === 'not_configured' ? 503 : 502, aiMessage(e)); }
  if (!t.text) throw new HttpError(422, 'No clear speech was detected. Please try again or type your symptoms.');
  const token = uid('aud');
  pending.set(token, { kind: 'audio', owner: user.id, buf, mime, at: Date.now(), uncertain: t.uncertain, confidence: t.confidence, language: t.language });
  audit(user, 'Voice transcribed locally', null, 'whisper-compatible service on this machine');
  return { token, text: t.text, language: t.language, confidence: t.confidence, uncertain: t.uncertain, note: 'No per-word confidence is available from the local speech service. Please read and correct the text.' };
});

route('POST', '/api/extract-report', ['patient', 'clinician'], async ({ body, user }) => {
  sweep();
  const mime = normMime(body.mime);
  if (!REPORT_OK.includes(mime)) throw new HttpError(400, 'Only PDF, JPG, PNG or WEBP reports are accepted.');
  const buf = Buffer.from(String(body.data || ''), 'base64');
  if (buf.length < 200 || buf.length > 12 * 1024 * 1024) throw new HttpError(413, 'File must be under 12 MB.');
  const fileName = String(body.fileName || 'report').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  let x;
  if (mime === 'application/pdf') { // local, rule-based: read the PDF text layer
    const t = extractPdfText(buf);
    if (!t.ok) throw new HttpError(422, `${t.reason} Please upload a clear photo of the report instead, or type the key values in your message.`);
    x = { mode: 'rule-based', isMedical: true, docType: 'PDF report (text layer)', date: (/\b(20\d{2}-\d{2}-\d{2})\b/.exec(t.text) || [])[1] || null, rawText: t.text, values: parseLabLines(t.text), unreadable: [], confidence: null };
  } else { // photo: local vision model if verified available, otherwise attach unread (clinician opens the original)
    const st = await slm.status();
    if (st.enabled && st.reachable && st.modelPresent) {
      try {
  x = normalizeReportExtraction(
    (await slm.extractReportImage({ buf, fileName })).json
  );
} catch (e) {
  console.error(
    '[CareFlow vision error]',
    e?.code || 'unknown',
    e?.message || 'No error message'
  );
  audit(user, 'Local report reading failed', null, e?.code || 'unknown');
}
    }
    x ||= { mode: 'unread', isMedical: true, docType: 'Photo (not machine-read)', date: null, rawText: '', values: [], unreadable: ['This photo was not machine-read (the local vision model is unavailable). The clinician can open the original.'], confidence: null };
  }
  const token = uid('rpt');
  pending.set(token, { kind: 'report', owner: user.id, buf, mime, fileName, extraction: x, at: Date.now() });
  audit(user, x.mode === 'model' ? 'Report read by local model' : x.mode === 'rule-based' ? 'Report text read (rule-based)' : 'Report attached unread', null, `${x.values.length} values`);
  return { token, fileName, ...x };
});

// ---- cases ----
route('POST', '/api/cases', ['patient'], async ({ body, user }) => {
  if (body.consent !== true) throw new HttpError(400, 'Explicit consent is required.');
  const p = { audio: null, reports: [] };
  if (body.audioToken) p.audio = takePending(body.audioToken, user.id, 'audio');
  for (const t of (body.reportTokens || []).slice(0, 5)) p.reports.push(takePending(t, user.id, 'report'));
  const c = await createCase({ user, body, pending: p });
  for (const t of [body.audioToken, ...(body.reportTokens || [])]) pending.delete(t);
  data().cases.unshift(c); save();
  audit(user, 'Consent given', c.id);
  audit(user, 'Case created', c.id, `mode=${c.inputMode}`);
  audit({ name: 'CareFlow', role: 'system' }, c.ai.mode === 'model' ? 'Language-model intake analysis (masked input)' : 'Rule-based fallback used — language model not used', c.id, c.ai.mode === 'model' ? `${c.ai.model}; masked: ${Object.entries(c.privacy.counts).map(([k, v]) => k + '×' + v).join(',') || 'none found'}` : (c.ai.errors[0] || ''));
  audit({ name: 'CareFlow', role: 'system' }, 'Preliminary priority suggested', c.id, `${c.priority.category} (rules v${c.priority.ruleVersion})`);
  if (c.flags.length) audit({ name: 'CareFlow', role: 'system' }, 'Warning-sign alert raised', c.id, c.flags.map((f) => f.label).join('; '));
  return forPatient(c);
});

route('GET', '/api/cases', null, ({ user }) => {
  need(user);
  if (STAFF.includes(user.role)) return sortQueue(data().cases).map(listItem); // server-side order: category, then longest waiting
  return data().cases.filter((c) => c.ownerId === user.id).map((c) => ({ id: c.id, createdAt: c.createdAt, stage: c.stage, chief: c.summary.chiefComplaint }));
});

route('GET', '/api/cases/:id', null, ({ user, params }) => {
  need(user);
  const c = getCase(params.id, user);
  if (user.role === 'patient') return forPatient(c);
  audit(user, 'Case accessed', c.id);
  return forStaff(c); // full record for staff — never includes the PII vault
});

route('POST', '/api/cases/:id/answers', ['patient'], async ({ user, params, body }) => {
  const c = getCase(params.id, user);
  if (c.stage !== 'needs_answers') throw new HttpError(409, 'This case is no longer accepting answers.');
  if (!Array.isArray(body.answers)) throw new HttpError(400, 'No answers supplied.');
  await submitAnswers({ c, answers: body.answers });
  save();
  audit(user, 'Follow-up answers submitted', c.id, `${c.answers.filter((a) => !a.skipped).length}/${c.answers.length} answered`);
  audit({ name: 'CareFlow', role: 'system' }, c.ai.final === 'ok' ? 'Language-model final summary (masked input)' : 'Rule-based final summary (model not used)', c.id, c.ai.final === 'ok' ? (c.ai.model || '') : (c.ai.errors.at(-1) || ''));
  audit({ name: 'CareFlow', role: 'system' }, 'Preliminary priority re-computed', c.id, `${c.priority.category}`);
  return forPatient(c);
});

route('POST', '/api/cases/:id/withdraw', ['patient', 'admin'], ({ user, params }) => {
  const c = getCase(params.id, user);
  deleteCaseFiles(c.id);
  data().cases = data().cases.filter((x) => x.id !== c.id);
  save();
  audit(user, 'Consent withdrawn', c.id);
  audit(user, 'Case data deleted', c.id, 'Message, recordings, reports, summaries removed');
  return { ok: true };
});

route('GET', '/api/cases/:id/files/:fid', null, ({ user, params, res }) => {
  need(user);
  const c = getCase(params.id, user);
  const f = c.files.find((x) => x.id === params.fid);
  const buf = f && readFile(c.id, f.id);
  if (!buf) throw new HttpError(404, 'File not found');
  audit(user, 'File opened', c.id, f.kind);
  res.writeHead(200, { 'content-type': f.mime, 'content-length': buf.length, 'content-disposition': `inline; filename="${f.fileName}"`, 'cache-control': 'private, no-store' });
  res.end(buf);
  return undefined;
});

// ---- clinician review actions ----
route('POST', '/api/cases/:id/review', STAFF, ({ user, params, body }) => {
  const c = getCase(params.id, user);
  if (user.role !== 'clinician') throw new HttpError(403, 'Administrators have read-only access to cases. Only clinicians can review, override or approve.');
  const rv = c.review;
  const locked = c.stage === 'approved';
  const guard = () => { if (locked) throw new HttpError(409, 'Case is approved and locked.'); };
  switch (body.action) {
    case 'open':
      if (c.stage === 'ready_for_review') c.stage = 'in_review';
      audit(user, 'Case opened for review', c.id);
      break;
    case 'decide': {
      guard();
      if (!['accepted', 'rejected', null].includes(body.value)) throw new HttpError(400, 'Bad decision');
      if (body.value === null) delete rv.decisions[body.key]; else rv.decisions[String(body.key).slice(0, 120)] = body.value;
      audit(user, `Model suggestion ${body.value || 'cleared'}`, c.id, String(body.label || '').slice(0, 120));
      break;
    }
    case 'confirm': { // clinician agrees with the current suggested priority
      guard();
      const cat = rv.finalCategory || c.priority.category;
      rv.confirmed = { by: user.name, at: new Date().toISOString(), category: cat };
      audit(user, 'Priority confirmed by clinician', c.id, cat);
      break;
    }
    case 'override': {
      guard();
      const reason = String(body.reason || '').trim();
      if (!(body.to in LABEL) || !reason) throw new HttpError(400, 'A category and a reason are required.');
      const from = rv.finalCategory || c.priority.category;
      if (body.to === from) throw new HttpError(400, 'That is already the current priority. Use “Confirm” instead.');
      rv.finalCategory = body.to;
      rv.confirmed = null;
      rv.override = { by: user.name, at: new Date().toISOString(), reason: reason.slice(0, 300), from, to: body.to, suggested: c.priority.category };
      audit(user, 'Priority overridden', c.id, `${from} → ${body.to}; reason recorded (${reason.length} chars)`);
      break;
    }
    case 'save':
      guard();
      if (typeof body.summary === 'string') rv.editedSummary = body.summary.slice(0, 8000);
      if (typeof body.notes === 'string') rv.notes = body.notes.slice(0, 4000);
      if (typeof body.note === 'string') rv.note = body.note.slice(0, 12000);
      audit(user, 'Review edits saved', c.id);
      break;
    case 'regenerate':
      guard();
      rv.note = buildNote(c);
      audit(user, 'Note draft regenerated', c.id);
      break;
    case 'approve': {
      guard();
      const at = new Date().toISOString();
      if (!rv.confirmed && !rv.override) rv.confirmed = { by: user.name, at, category: rv.finalCategory || c.priority.category }; // approving a note confirms the priority shown
      const base = (typeof body.note === 'string' && body.note.trim() ? body.note : rv.note || buildNote(c)).slice(0, 12000);
      const final = /^Approval status:.*$/m.test(base) ? base.replace(/^Approval status:.*$/m, `Approval status: APPROVED by ${user.name} at ${at}`) : `${base}\nApproval status: APPROVED by ${user.name} at ${at}`;
      rv.note = final; rv.approval = { by: user.name, at, note: final };
      if (typeof body.notes === 'string') rv.notes = body.notes.slice(0, 4000);
      c.stage = 'approved';
      audit(user, 'Final note approved', c.id, `category=${rv.finalCategory || c.priority.category}`);
      break;
    }
    default: throw new HttpError(400, 'Unknown action');
  }
  if (!rv.note) rv.note = c.noteDraft;
  c.updatedAt = new Date().toISOString();
  save();
  return forStaff(c);
});

// ---- audit / admin ----
route('GET', '/api/audit', STAFF, () => data().audit.slice(-400).reverse());
route('GET', '/api/audit/verify', STAFF, () => verifyAudit());
route('POST', '/api/admin/reset-demo', ['admin'], async ({ user }) => { resetAll(); await seedDemo(); audit(user, 'Demo data reset'); return { ok: true }; });

function need(user) { if (!user) throw new HttpError(401, 'Please sign in.'); }

// ---------------------------------------------------------------------------------------------
async function readBody(req) {
  const chunks = []; let n = 0;
  for await (const ch of req) { n += ch.length; if (n > MAX_BODY) throw new HttpError(413, 'Upload too large'); chunks.push(ch); }
  if (!n) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUB, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUB, 'index.html'); // SPA fallback
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  fs.createReadStream(file).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    const user = readToken(req.headers.cookie);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      if (r.roles && (!user || !r.roles.includes(user.role))) throw new HttpError(user ? 403 : 401, user ? 'Your role cannot do this.' : 'Please sign in.');
      if (req.method === 'POST' && Number(req.headers['content-length'] || 0) > 0 && !/application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'JSON only');
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.fn({ req, res, user, params: m.groups || {}, body, url });
      if (out === undefined) return undefined; // handler wrote the response
      const json = JSON.stringify(out);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(json);
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(`[server] ${e?.name || 'Error'}: ${String(e?.message || '').slice(0, 160)}`); // no stacks / payloads in logs
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong on the server.' : e.message }));
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initPii();
  await seedIfEmpty();
  server.listen(cfg.port, async () => {
    console.log(`\n  CareFlow running → http://localhost:${cfg.port}`);
    const st = await slm.status({ fresh: true });
    console.log(`  Language model: ${st.verifiedLocal ? `VERIFIED local — ${st.model} at ${st.endpoint}` : `not active — ${st.reason} (rule-based fallback in use)`}`);
    console.log(`  Speech-to-text: ${cfg.whisperUrl ? `configured (${stt.sttStatus().endpoint})` : 'not configured (type your symptoms, or use the optional browser speech-to-text)'}`);
    console.log(`  PII masking: built-in detectors${nerAvailable() ? ' + compromise NER' : ' (optional NER library not installed)'}`);
    console.log(`  Staff PIN: ${cfg.demoMode ? cfg.staffPin : '(hidden)'}\n`);
  });
}
