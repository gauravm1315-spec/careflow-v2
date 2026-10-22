export async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) { const e = new Error(j?.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
  return j;
}
