import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../lib/env.js';
import * as slm from '../lib/slm.js';
import { startFakeOllama } from './fake-ollama.js';

let fake;
before(async () => { fake = await startFakeOllama(); });
after(() => fake.close());
beforeEach(() => {
  Object.assign(cfg, { slmEnabled: true, ollamaUrl: fake.url, ollamaModel: 'gemma3:4b', ollamaTimeoutMs: 5000, allowRemoteRaw: false });
  Object.assign(fake.st, { tags: ['gemma3:4b'], chatMode: 'ok', badOnceDone: false, calls: [] });
  slm.resetStatusCache();
});
const input = { message: 'I have fever for 3 days. Pain is 5/10.', reports: [], inputMode: 'text', uiLang: 'en' };

test('status: verified only when reachable, model installed AND endpoint is loopback', async () => {
  const s = await slm.status({ fresh: true });
  assert.deepEqual([s.reachable, s.modelPresent, s.endpointKind, s.verifiedLocal], [true, true, 'loopback', true]);
});

test('status: model not installed → not verified, tells the user how to fix it', async () => {
  fake.st.tags = ['llama3:8b'];
  const s = await slm.status({ fresh: true });
  assert.equal(s.reachable, true); assert.equal(s.modelPresent, false); assert.equal(s.verifiedLocal, false);
  assert.match(s.reason, /ollama pull gemma3:4b/);
});

test('status: Ollama not running → reachable=false (nothing claimed)', async () => {
  cfg.ollamaUrl = 'http://127.0.0.1:1';
  const s = await slm.status({ fresh: true });
  assert.equal(s.reachable, false); assert.equal(s.verifiedLocal, false); assert.match(s.reason, /not reachable/i);
});

test('status: a remote endpoint is never reported as local', async () => {
  cfg.ollamaUrl = 'http://ollama.example.invalid:11434';
  assert.equal(slm.endpointKind(), 'remote');
  const s = await slm.status({ fresh: true });
  assert.equal(s.verifiedLocal, false);
  for (const u of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://[::1]:11434']) assert.equal(slm.endpointKind(u), 'loopback', u);
  for (const u of ['http://192.168.1.5:11434', 'https://ollama.example.com']) assert.equal(slm.endpointKind(u), 'remote', u);
});

test('status: disabled by configuration', async () => {
  cfg.slmEnabled = false;
  const s = await slm.status({ fresh: true });
  assert.equal(s.enabled, false); assert.equal(s.verifiedLocal, false);
  await assert.rejects(slm.analyzeIntake(input), { code: 'disabled' });
});

test('success: structured JSON request (format=json, configured model) and parsed result', async () => {
  const r = await slm.analyzeIntake(input);
  assert.equal(r.model, 'gemma3:4b'); assert.equal(r.json.chief_complaint, 'Symptoms described');
  const call = fake.st.calls[0];
  assert.equal(call.format, 'json'); assert.equal(call.model, 'gemma3:4b'); assert.equal(call.task, 'analyze_intake');
  assert.match(call.user, /<patient_message>/);
});

test('malformed JSON once → one repair retry succeeds', async () => {
  fake.st.chatMode = 'bad-json-once';
  const r = await slm.analyzeIntake(input);
  assert.ok(r.json.symptoms); assert.equal(fake.st.calls.length, 2);
  assert.match(fake.st.calls[1].user, /not valid JSON/);
});

test('malformed JSON always → bad_json error after exactly one retry (no infinite loop)', async () => {
  fake.st.chatMode = 'bad-json-always';
  await assert.rejects(slm.analyzeIntake(input), { code: 'bad_json' });
  assert.equal(fake.st.calls.length, 2);
});

test('timeout → timeout error', async () => {
  fake.st.chatMode = 'hang'; cfg.ollamaTimeoutMs = 300;
  await assert.rejects(slm.analyzeIntake(input), { code: 'timeout' });
});

test('model missing (HTTP 404) → model_missing with the pull command', async () => {
  fake.st.chatMode = 'model-missing';
  await assert.rejects(slm.analyzeIntake(input), (e) => e.code === 'model_missing' && /ollama pull gemma3:4b/.test(e.message));
});

test('HTTP 500 → http error; unreachable endpoint → unreachable', async () => {
  fake.st.chatMode = 'http500';
  await assert.rejects(slm.analyzeIntake(input), { code: 'http' });
  fake.st.chatMode = 'ok'; cfg.ollamaUrl = 'http://127.0.0.1:1';
  await assert.rejects(slm.analyzeIntake(input), { code: 'unreachable' });
});

test('PRIVACY: unmasked identifiers are refused before anything is sent', async () => {
  for (const msg of ['Call me on 9876543210 please', 'My name is Ravi Kumar and I have fever', 'mail me at a.b@example.com']) {
    await assert.rejects(slm.analyzeIntake({ ...input, message: msg }), { code: 'privacy_blocked' }, msg);
  }
  assert.equal(fake.st.calls.length, 0, 'nothing may reach the model');
});

test('PRIVACY: masked text is accepted (placeholders are not identifiers)', async () => {
  const r = await slm.analyzeIntake({ ...input, message: 'My name is [PERSON_1]. Call [PHONE_1]. Fever for 3 days.' });
  assert.ok(r.json); assert.equal(fake.st.calls.length, 1);
});

test('PRIVACY: raw images are never sent to a non-loopback endpoint', async () => {
  cfg.ollamaUrl = 'http://ollama.example.invalid:11434';
  const realFetch = globalThis.fetch; let fetched = 0; globalThis.fetch = (...a) => { fetched++; return realFetch(...a); };
  try { await assert.rejects(slm.extractReportImage({ buf: Buffer.from('x'.repeat(300)), fileName: 'r.png' }), { code: 'privacy_blocked' }); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, 0);
});

test('vision: image bytes go to the loopback model as base64 and the file name is not put in the prompt', async () => {
  const r = await slm.extractReportImage({ buf: Buffer.from('fake-image-bytes'), fileName: 'ravi_kumar_9876543210.png' });
  assert.equal(r.json.is_medical_document, true);
  const c = fake.st.calls[0]; assert.equal(c.images, 1); assert.ok(!/ravi|9876543210/i.test(c.user + c.system));
});
