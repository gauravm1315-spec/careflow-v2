// JSON-file store with atomic writes + a tamper-evident (hash-chained) audit log.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './env.js';

fs.mkdirSync(path.join(cfg.dataDir, 'uploads'), { recursive: true });
const FILE = path.join(cfg.dataDir, 'db.json');

let db;
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { db = { cases: [], audit: [], counter: 1042, seeded: false }; }

export const data = () => db;
export function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, FILE);
}
export function resetAll() {
  db = { cases: [], audit: [], counter: 1042, seeded: false };
  fs.rmSync(path.join(cfg.dataDir, 'uploads'), { recursive: true, force: true });
  fs.mkdirSync(path.join(cfg.dataDir, 'uploads'), { recursive: true });
  save();
}
export const nextCaseId = () => `CF-${++db.counter}`;
export const uid = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`;

// ---- audit chain (never contains patient free text) ----
const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
export function audit(actor, action, caseId, detail, at = new Date().toISOString()) {
  const prev = db.audit.length ? db.audit[db.audit.length - 1].hash : 'GENESIS';
  const e = { id: uid('a'), at, actor: actor?.name || 'System', role: actor?.role || 'system', action, caseId: caseId || null, detail: detail || '' };
  e.prev = prev;
  e.hash = h(prev + JSON.stringify([e.id, e.at, e.actor, e.role, e.action, e.caseId, e.detail]));
  db.audit.push(e);
  save();
  return e;
}
export function verifyAudit() {
  let prev = 'GENESIS';
  for (let i = 0; i < db.audit.length; i++) {
    const e = db.audit[i];
    const ok = e.prev === prev && e.hash === h(prev + JSON.stringify([e.id, e.at, e.actor, e.role, e.action, e.caseId, e.detail]));
    if (!ok) return { ok: false, brokenAt: i, total: db.audit.length };
    prev = e.hash;
  }
  return { ok: true, total: db.audit.length };
}

// ---- uploaded files (audio recordings, report scans) ----
const dirFor = (caseId) => path.join(cfg.dataDir, 'uploads', caseId);
export function saveFile(caseId, fileId, buf) {
  fs.mkdirSync(dirFor(caseId), { recursive: true });
  fs.writeFileSync(path.join(dirFor(caseId), fileId), buf);
}
export const readFile = (caseId, fileId) => {
  try { return fs.readFileSync(path.join(dirFor(caseId), path.basename(fileId))); } catch { return null; }
};
export const deleteCaseFiles = (caseId) => fs.rmSync(dirFor(caseId), { recursive: true, force: true });
