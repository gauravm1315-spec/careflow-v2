// All names, numbers and addresses below are INVENTED. Aadhaar-like numbers are generated with the Verhoeff algorithm; card numbers are public test numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Masker, PiiError, maskOnce, verhoeffValid, verhoeffCheckDigit, luhnValid, __test } from '../lib/pii.js';

const mask = (t) => { const m = new Masker(); const r = m.mask(t); return { ...r, m, ok: m.verify(r.text).ok }; };
const AADHAAR = (() => { const b = '23456789012'; return b + verhoeffCheckDigit(b); })();
const fmt4 = (n) => `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;

test('validators: Verhoeff (Aadhaar) and Luhn (cards)', () => {
  assert.ok(verhoeffValid(AADHAAR));
  assert.ok(!verhoeffValid(AADHAAR.slice(0, 11) + ((+AADHAAR[11] + 1) % 10)));
  assert.ok(luhnValid('4111 1111 1111 1111'));
  assert.ok(!luhnValid('4111 1111 1111 1112'));
});

test('phone numbers: Indian mobile (several formats), landline, international, Devanagari digits', () => {
  for (const t of ['Call 9876543210', 'Call 98765 43210', 'Call +91 98765-43210', 'Call +919876543210', 'Call 09876543210', 'Call 011-23456789', 'Call +44 20 7946 0958', 'फोन ९८७६५४३२१०']) {
    const r = mask(t); assert.match(r.text, /\[PHONE_\d\]/, t); assert.ok(r.ok, `verify: ${t}`);
  }
});

test('phone numbers: same number → same placeholder, different number → new placeholder', () => {
  const r = mask('Mobile 9876543210. Again 98765 43210. Other 9123456780.');
  assert.equal(r.text, 'Mobile [PHONE_1]. Again [PHONE_1]. Other [PHONE_2].');
});

test('e-mail, URL, PAN, IFSC, EPIC, ABHA', () => {
  const r = mask('Mail asha.v+test@example.co.in or see https://portal.example.org/p/123. PAN ABCDE1234F, IFSC HDFC0001234, voter XYZ1234567, ABHA 12-3456-7890-1234.');
  for (const ph of ['EMAIL_1', 'URL_1', 'PAN_1', 'IFSC_1', 'EPIC_1', 'ABHA_1']) assert.ok(r.text.includes(`[${ph}]`), `${ph} in ${r.text}`);
  assert.ok(r.ok);
});

test('Aadhaar: checksum-valid numbers are masked; random 12-digit numbers are not (unless context says Aadhaar)', () => {
  assert.match(mask(`ID ${fmt4(AADHAAR)}`).text, /\[AADHAAR_1\]/);
  assert.match(mask(`ID ${AADHAAR}`).text, /\[AADHAAR_1\]/);
  assert.ok(!/AADHAAR/.test(mask('Reference 234567890123 for the sample').text), 'invalid checksum, no context → left alone');
  assert.match(mask('My aadhaar number is 234567890123').text, /\[AADHAAR_1\]/, 'invalid checksum but explicit context → masked (fail towards privacy)');
});

test('cards: Luhn-valid numbers masked; 16-digit non-card numbers are not', () => {
  assert.match(mask('Paid with 4111 1111 1111 1111 yesterday').text, /\[CARD_1\]/);
  assert.match(mask('Paid with 4111-1111-1111-1111').text, /\[CARD_1\]/);
  assert.ok(!/CARD/.test(mask('Sample batch 1234 5678 9012 3456').text));
});

test('names: cue phrases, titles, relations, Hinglish and Hindi cues', () => {
  assert.equal(mask('My name is Ravi Kumar. I have fever.').text, 'My name is [PERSON_1]. I have fever.');
  assert.match(mask('Patient name: Anita Sinha, age 34').text, /Patient name: \[PERSON_1\], age 34/);
  assert.match(mask('Dr. Anil Mehta advised rest.').text, /Dr\. \[PERSON_1\] advised rest/);
  assert.match(mask('Mr Singh has diabetes').text, /Mr \[PERSON_1\] has diabetes/);
  assert.match(mask('my father Ramesh has chest pain').text, /my father \[PERSON_1\] has chest pain/);
  assert.match(mask('Mera naam sunita devi hai. Mujhe bukhar hai.').text, /Mera naam \[PERSON_1\] hai\. Mujhe bukhar hai/);
  assert.match(mask('मेरा नाम राजेश शर्मा है और मुझे बुखार है।').text, /मेरा नाम \[PERSON_1\] है और मुझे बुखार है/);
});

test('names: later bare mentions of a detected name are masked too (propagation)', () => {
  const r = mask('My father Ramesh Gupta is ill. Ramesh has fever and Gupta ji is worried.');
  assert.ok(!/Ramesh|Gupta/.test(r.text), r.text);
  assert.ok(r.ok);
});

test('names: common Indian names are caught even without a cue (gazetteer)', () => {
  assert.match(mask('Ravi Kumar came with fever').text, /\[PERSON_1\] came with fever/);
});

test('addresses, PIN codes, locations, date of birth, record numbers', () => {
  let r = mask('I live at Flat 12B, Gandhi Nagar, Patna 800001 and I have chest pain since morning.');
  assert.match(r.text, /I live at \[ADDRESS_1\] and I have chest pain since morning\./); assert.ok(r.ok);
  assert.match(mask('My address is 45 MG Road, Ranchi. Knee pain.').text, /My address is \[ADDRESS_1\]\. Knee pain\./);
  assert.match(mask('I live in Patna and have fever').text, /I live in \[LOCATION_1\] and have fever/);
  assert.match(mask('DOB: 12/03/1985').text, /DOB: \[DOB_1\]/);
  assert.match(mask('Born 5 June 1990.').text, /Born \[DOB_1\]\./);
  assert.match(mask('MRN: HX889912 and UHID 44556677').text, /MRN: \[ID_1\] and UHID \[ID_2\]/);
  assert.match(mask('Passport no Z1234567').text, /Passport no \[ID_1\]/);
});

test('clinically relevant text is preserved (symptoms, duration, drugs, allergies, measurements)', () => {
  const clinical = [
    'I have fever for 3 days, BP 140/90 mmHg, pulse 88/min, SpO2 96%, temp 38.4 C, RR 18.',
    'Taking paracetamol 500 mg twice daily and metformin 500 mg. Allergic to penicillin.',
    'HbA1c 7.1 % (4.0-5.6) H, WBC 13,400 /uL (4,000-11,000), platelets 150,000-450,000, glucose 110-126 mg/dL, creatinine 1.1.',
    'Hb 11.2 g/dL (12.0-15.5) on 12-10-2026 at 14:30. Call 112 or 108 for emergency. Pain 8/10 since 2 days, worse at night.',
    'Mujhe 3 din se bukhar hai aur sir dard hai. Khansi bhi hai. Saans phool rahi hai.',
    'मुझे दो दिन से बुखार और खांसी है।',
  ];
  for (const t of clinical) { const r = mask(t); assert.equal(r.text, t, `changed: ${r.text}`); assert.ok(r.ok); }
});

test('false positives: ordinary words that look like names, places or numbers are left alone', () => {
  for (const t of ['Hope this helps.', 'Mark the pain location.', 'Rose bush allergy. Will rest on Sunday.', 'ASHA worker visited on Monday.', 'Dizzy since March, takes 2 tablets at 8 am.', 'Ward 4B bed 12.', 'Reference 1234567890123.']) {
    assert.equal(mask(t).text, t, t);
  }
});

test('KNOWN FALSE POSITIVE (documented): spaced vitals that look like a 10-digit mobile number are masked', () => {
  assert.match(mask('readings 98 76 54 32 10 bpm').text, /\[PHONE_1\]/); // over-masking errs towards privacy
});

test('KNOWN LIMITATION (documented): an uncommon name with no cue and not in the name list is NOT detected', () => {
  const r = mask('Zebulon Quillfeather has fever');
  assert.ok(r.text.includes('Zebulon Quillfeather'), 'if this starts failing, great — update PII_LIMITATIONS');
});

test('stable placeholders across calls with the same vault; vault is separate from the masked text', () => {
  const m1 = new Masker(); const a = m1.mask('My name is Ravi Kumar, phone 9876543210.');
  const m2 = new Masker(m1.exportVault()); const b = m2.mask('Ravi Kumar called from 9876543210 and 9123456780.');
  assert.equal(b.text, '[PERSON_1] called from [PHONE_1] and [PHONE_2].');
  assert.ok(!JSON.stringify(a.text).includes('9876543210') && !JSON.stringify(b.text).includes('Ravi'));
  assert.equal(m2.unmask('Phone is [PHONE_1]'), 'Phone is 9876543210');
  assert.deepEqual(Object.keys(m2.counts()).sort(), ['PERSON', 'PHONE']);
});

test('placeholders never match detectors again (idempotent) and verify() is clean on masked output', () => {
  const r = mask('My name is Ravi Kumar, phone 9876543210, email r.k@example.com. Fever for 3 days.');
  const again = new Masker().mask(r.text);
  assert.equal(again.text, r.text); assert.ok(r.ok);
});

test('verify() FAILS when identifiers remain; maskStrict() throws PiiError (callers fail closed)', () => {
  const m = new Masker();
  const v = m.verify('Please call 9876543210 about the fever');
  assert.equal(v.ok, false); assert.ok(v.residual.includes('PHONE'));
  assert.ok(!JSON.stringify(v).includes('9876543210'), 'residual report never echoes the value');
  __test.failVerify = true;
  try { assert.throws(() => new Masker().maskStrict('My name is Ravi Kumar'), (e) => e instanceof PiiError && e.code === 'pii_unverified'); }
  finally { __test.failVerify = false; }
});

test('maskOnce helper reports verification and counts', () => {
  const r = maskOnce('Phone 9876543210 and mail a.b@example.com');
  assert.equal(r.verified, true); assert.deepEqual(r.counts, { PHONE: 1, EMAIL: 1 });
});

test('performance: long / hostile inputs are masked in linear time (regression: quadratic e-mail regex took ~8 s on 50k letters)', () => {
  const inputs = { 'long word': 'x'.repeat(50_000), 'digits + spaces': '1 '.repeat(25_000), 'long digits': '9'.repeat(30_000), 'dots': '1.2.3.'.repeat(8_000), 'at-signs': 'a@'.repeat(20_000),
    'hyphen soup': '1-2 3-4 '.repeat(5_000), 'name cues': 'my name is '.repeat(4_000), 'mixed': ('Fever 3 days. ' + 'z'.repeat(500) + ' ').repeat(100) };
  for (const [label, text] of Object.entries(inputs)) {
    const t0 = Date.now(); const m = new Masker(); const r = m.mask(text); m.verify(r.text);
    assert.ok(Date.now() - t0 < 1500, `${label}: ${Date.now() - t0} ms`);
  }
  assert.ok(mask(('x'.repeat(5000)) + ' My name is Ravi Kumar.').text.includes('[PERSON_1]'));
});
