// HMAC-signed session cookie. Roles are enforced server-side on every route.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './env.js';

const secretFile = path.join(cfg.dataDir, '.secret');
let SECRET;
try { SECRET = fs.readFileSync(secretFile, 'utf8'); } catch {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
}
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');

export function makeToken(user) {
  const p = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + 12 * 3600e3 })).toString('base64url');
  return `${p}.${sign(p)}`;
}
export function readToken(cookieHeader) {
  const m = /(?:^|;\s*)cf_session=([^;]+)/.exec(cookieHeader || '');
  if (!m) return null;
  const [p, s] = m[1].split('.');
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const u = JSON.parse(Buffer.from(p, 'base64url').toString());
    return u.exp > Date.now() ? { id: u.id, name: u.name, role: u.role } : null;
  } catch { return null; }
}
export const patientId = (name) => 'p_' + crypto.createHash('sha1').update('patient:' + name.trim().toLowerCase()).digest('hex').slice(0, 10);
export const pinOk = (pin) => {
  const a = Buffer.from(String(pin || '')), b = Buffer.from(cfg.staffPin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
