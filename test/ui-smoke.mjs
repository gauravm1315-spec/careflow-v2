// OPTIONAL browser smoke test (not part of `npm test`). Needs:  npm i -D playwright ; npx playwright install chromium ; node test/ui-smoke.mjs
// Drives the real UI against the real server with a FAKE Ollama. Screenshots go to your temp folder.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { chromium } from 'playwright';
import { startFakeOllama } from './fake-ollama.js';
const fake = await startFakeOllama();
Object.assign(process.env, { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cfui-')), STAFF_PIN: '2468', DEMO_MODE: '1' });
const { cfg } = await import('../lib/env.js'); cfg.ollamaUrl = fake.url;
const slm = await import('../lib/slm.js');
const { server } = await import('../server.js');
const { seedIfEmpty } = await import('../lib/seed.js'); await seedIfEmpty();
await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(); const errors = [];
const page = async (w = 1360, h = 900) => { const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message)); p.on('console', (m) => m.type() === 'error' && !/fonts\.g|ERR_INTERNET|ERR_NAME|Failed to load resource/.test(m.text()) && errors.push('CONSOLE ' + m.text())); return p; };
const log = (...a) => console.log(...a);

// ---- patient, model available ----
const p = await page();
await p.goto(base + '/#/login'); await p.click('button[type=submit]');
await p.waitForSelector('text=Before we begin'); await p.screenshot({ path: path.join(os.tmpdir(), 'careflow-consent.png') });
log('consent mentions local model + masking:', /masked/.test(await p.innerText('.checklist')));
await p.check('input[data-in=agree]'); await p.click('#goBtn');
await p.waitForSelector('#txt');
log('voice button disabled without local STT:', await p.locator('button[data-act=rec-toggle]').isDisabled());
log('browser STT opt-in shown (Chromium has SpeechRecognition):', await p.locator('input[data-in=bstt]').count() > 0, '| default OFF:', !(await p.locator('input[data-in=bstt]').isChecked().catch(() => false)));
await p.fill('#txt', 'My name is Ravi Kumar. Call me on 98765 43210. I have chest pain since morning and I am sweating. Fever for 3 days.');
await p.waitForSelector('#live .alert'); await p.screenshot({ path: path.join(os.tmpdir(), 'careflow-intake.png'), fullPage: true });
await p.click('button[data-act=submit]'); await p.waitForSelector('.qcard', { timeout: 20000 });
await p.click('button[data-act=q-pick][data-v=Yes]'); await p.click('#qnext'); await p.fill('textarea[data-in=q-text]', 'No allergies'); await p.click('#qnext');
await p.waitForSelector('.recap', { timeout: 20000 }); await p.screenshot({ path: path.join(os.tmpdir(), 'careflow-patient-final.png'), fullPage: true });
const pf = await p.innerText('main'); log('patient final shows model label:', /Local model draft/.test(pf), '| leaks category to patient:', /Preliminary|Urgent review/.test(pf));

// ---- clinician ----
const d = await page(); await d.goto(base + '/#/login'); await d.click('button[data-r=clinician]'); await d.fill('#lpin', '2468'); await d.click('button[type=submit]');
await d.waitForSelector('.qrow'); await d.screenshot({ path: path.join(os.tmpdir(), 'careflow-queue.png'), fullPage: true });
const rows = await d.$$eval('.qrow', (r) => r.map((x) => ({ id: x.dataset.id, cls: x.className.split(' ')[1], txt: x.innerText })));
log('queue rows:', rows.length, '| first 3:', rows.slice(0, 3).map((r) => r.id + ':' + r.cls).join(', '));
log('unreviewed + reviewed chips present:', rows.some((r) => /Unreviewed/.test(r.txt)), rows.some((r) => /Confirmed|Overridden/.test(r.txt)), '| reason text shown:', rows.every((r) => /rule|critical|disagree|Key details|matched|No warning/i.test(r.txt)), '| wait shown:', rows.every((r) => /min|h|d/.test(r.txt)));
// open an unreviewed non-urgent case, override up, verify queue order updates
const target = rows.find((r) => r.cls === 'routine' && /Unreviewed/.test(r.txt));
await d.click(`.qrow[data-id="${target.id}"]`); await d.waitForSelector('.grid3'); await d.screenshot({ path: path.join(os.tmpdir(), 'careflow-review.png'), fullPage: true });
log('why-panel:', await d.locator('text=Why this priority').count() > 0, '| privacy panel:', await d.locator('text=Privacy masking').count() > 0, '| synthetic label:', await d.locator('text=Synthetic demo case').count() > 0);
await d.click('button[data-act=pick-cat][data-k=urgent]'); log('override button disabled until reason typed:', await d.locator('#ovBtn').isDisabled());
await d.fill('input[data-in=reason]', 'Called patient: worse overnight'); await d.click('#ovBtn'); await d.waitForSelector('text=Overridden');
await d.goto(base + '/#/queue'); await d.waitForSelector('.qrow');
const after = await d.$$eval('.qrow', (r) => r.map((x) => ({ id: x.dataset.id, cls: x.className.split(' ')[1] })));
log('after override: case', target.id, 'is now', after.find((x) => x.id === target.id).cls, 'at position', after.findIndex((x) => x.id === target.id) + 1, '(was routine, position', rows.findIndex((r) => r.id === target.id) + 1 + ')');
// newest patient case (model-made) review: evidence click highlights
const mine = after.map((x) => x.id); await d.click(`.qrow >> nth=0`); await d.waitForSelector('.grid3');
const chip = d.locator('button.src').first(); if (await chip.count()) { await chip.click(); await d.waitForTimeout(300); log('source chip highlights evidence:', await d.locator('mark').count() > 0); }
await d.screenshot({ path: path.join(os.tmpdir(), 'careflow-review2.png'), fullPage: true });
// pick the model-made case explicitly
await d.goto(base + '/#/queue'); await d.waitForSelector('.qrow');
const modelRow = d.locator('.qrow', { hasText: 'Local model draft' }).first(); await modelRow.click(); await d.waitForSelector('.grid3'); await d.screenshot({ path: path.join(os.tmpdir(), 'careflow-review-model.png'), fullPage: true });
const rtxt = await d.innerText('main'); log('model case: shows model label:', /Local model draft/.test(rtxt), '| raw name hidden in masked preview:', await d.locator('details:has-text("What a model would see")').count() > 0);
await d.click('button[data-act=confirm]'); await d.waitForSelector('text=Clinician-confirmed');
// ---- admin ----
const a = await page(); await a.goto(base + '/#/login'); await a.click('button[data-r=admin]'); await a.fill('#lpin', '2468'); await a.click('button[type=submit]');
await a.waitForSelector('.qrow'); await a.goto(base + '/#/system'); await a.waitForSelector('text=Language model (Ollama)'); await a.screenshot({ path: path.join(os.tmpdir(), 'careflow-system-up.png'), fullPage: true });
const sys = await a.innerText('main'); log('system shows verified-local:', /Verified on this machine/.test(sys), '| mentions Gemini anywhere:', /gemini/i.test(sys));
await a.goto(base + '/#/queue'); await a.waitForSelector('.qrow'); await a.locator('.qrow').first().click(); await a.waitForSelector('.grid3');
log('admin read-only notice:', await a.locator('text=read-only access').count() > 0, '| approve disabled:', await a.locator('button[data-act=approve]').isDisabled());

// ---- model goes down: patient flow + labels ----
fake.st.tags = []; slm.resetStatusCache();
const p2 = await page(); await p2.goto(base + '/#/login'); await p2.click('button[type=submit]'); await p2.waitForSelector('text=Before we begin'); await p2.check('input[data-in=agree]'); await p2.click('#goBtn');
await p2.fill('#txt', 'Mujhe 3 din se bukhar hai aur sir dard hai.'); await p2.click('button[data-act=submit]'); await p2.waitForSelector('.qcard', { timeout: 20000 }); await p2.screenshot({ path: path.join(os.tmpdir(), 'careflow-patient-fallback.png'), fullPage: true });
log('fallback notice shown to patient:', /language model was not used/i.test(await p2.innerText('main')));
await a.goto(base + '/#/system'); await a.waitForSelector('text=Language model (Ollama)'); log('system when down:', /Not active/.test(await a.innerText('main')), '| claims verified:', /Verified on this machine/.test(await a.innerText('main')));

// ---- mobile ----
const m = await page(390, 800); await m.goto(base + '/#/login'); await m.click('button[data-r=clinician]'); await m.fill('#lpin', '2468'); await m.click('button[type=submit]'); await m.waitForSelector('.qrow');
log('mobile queue overflow (page):', await m.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)); await m.screenshot({ path: path.join(os.tmpdir(), 'careflow-mobile-queue.png') });
log('ERRORS:', errors.length ? errors : 'none');
await browser.close(); server.close(); fake.close();
