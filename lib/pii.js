// PII detection + masking. Layered, NOT perfect — see PII_LIMITATIONS and test/pii.test.js.
//
// Layers
//   1. Structured identifiers with VALIDATION  : e-mail, URL, Aadhaar (Verhoeff checksum), cards (Luhn), PAN, IFSC,
//                                                 Indian/international phone numbers, ABHA, EPIC.
//   2. Context-keyed identifiers               : MRN / UHID / passport / licence / account / policy numbers, date of birth,
//                                                 PIN codes, house numbers & street/locality names, "I live at …".
//   3. Names                                   : cue phrases ("my name is", titles, relations, Hindi/Hinglish cues),
//                                                 a gazetteer of common Indian names, and — if installed — the `compromise` NER library.
//   4. Propagation                             : every later occurrence of a detected name/ID is masked too.
//   5. VERIFICATION                            : the masked text is re-scanned; anything left over ⇒ masking FAILS (callers fail closed).
//
// The identifier→placeholder mapping (the "vault") lives only inside a Masker instance / the server-side case record.
// It is never put into model prompts, audit entries or logs, and is stripped from every API response.

export const PII_LIMITATIONS = [
  'Detection is heuristic. Names without a cue phrase and not in the built-in name list can be missed (especially unusual or regional names).',
  'Addresses are detected from keywords (house/flat, street/locality words, "I live at …", PIN codes); free-form addresses can be missed.',
  'Rare indirect identifiers (a unique job, a very small village, a distinctive event) are not detected.',
  'Some harmless words that look like names or places can be masked (over-masking). Clinical content is preserved on a best-effort basis.',
  'Masking is applied to text sent to a language model. Raw audio and report images/files are never masked; they are only sent to loopback (same-machine) services.',
];

export class PiiError extends Error { constructor(msg, residual = []) { super(msg); this.code = 'pii_unverified'; this.residual = residual; } }
export const __test = { failVerify: false }; // test hook: simulate a masking-verification failure

// ------------------------------------------------------------------------------------------------
// validators
const VD = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]];
const VP = [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]];
const VINV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];
export function verhoeffValid(num) {
  let c = 0; const d = String(num).split('').reverse().map(Number);
  if (d.some(Number.isNaN)) return false;
  d.forEach((x, i) => { c = VD[c][VP[i % 8][x]]; });
  return c === 0;
}
export function verhoeffCheckDigit(body) { // used by tests to build SYNTHETIC valid numbers
  let c = 0; const d = String(body).split('').reverse().map(Number);
  d.forEach((x, i) => { c = VD[c][VP[(i + 1) % 8][x]]; });
  return VINV[c];
}
export function luhnValid(num) {
  const d = String(num).replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let s = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = +d[i]; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; }
  return s % 10 === 0;
}

// ------------------------------------------------------------------------------------------------
// name lists (small, synthetic-safe; extend as needed)
const GIVEN = 'aarav aarti aditya akash amit amita anil anita anjali ankit ankita anuj arjun arun aruna asha ashok ayesha bharat chandra deepak deepika dev dinesh divya farhan fatima ganesh gaurav geeta gita gopal govind harish hari hema imran ishaan jyoti kajal kamal kavita kavya kiran krishna kunal lakshmi lalit lata madhav mahesh manish manoj meena meera mohan mohit mukesh nandini naveen neha nikhil nisha pallavi pankaj pooja prakash pradeep prateek priya rahul raj rajesh rakesh ramesh rani ravi rekha riya rohit roshan sachin sandeep sangeeta sanjay sarita saurabh seema shalini shankar shweta shyam sita sneha sonal sunil sunita suresh sushma swati tanvi tarun uma usha varun vijay vikas vikram vimal vinod vivek yash yogesh zoya'.split(' ');
const SURN = 'agarwal ahmed ansari banerjee bhatt bose chatterjee chauhan chopra das desai deshmukh dubey ghosh gupta iyer jain jha joshi kapoor khan kulkarni kumar malhotra mehta menon mishra mukherjee nair naidu pandey patel patil pawar pillai prasad qureshi rao reddy saxena sen shah sharma sheikh shukla singh sinha srivastava thakur tiwari trivedi verma yadav'.split(' ');
const NAME_SET = new Set([...GIVEN, ...SURN]);

// words that are never part of a person name (used to stop cue-based captures and to veto gazetteer hits)
const NOT_NAME = new Set(('a an and are as at be been but by can could did do does feel felt for from had has have having he her his i if in is it its me my no not of on or our she since so that the their them there they this to was we were what when which while who will with would you your ' +
  'pain fever cough cold headache vomiting nausea dizziness dizzy rash swelling bleeding breathing breath chest stomach back leg arm hand head throat eye eyes ear ' +
  'patient doctor sir madam mr mrs ms miss dr days day weeks week months month years year today yesterday tomorrow morning night evening ' +
  'monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december ' +
  'hai hain hoon aur ko ki ka ke se me mein mujhe mera meri hum tum aap ji sahab ' +
  'allergy allergic diabetes asthma pressure sugar tablet tablets medicine medicines paracetamol mg ml').split(' '));

const TITLE = '(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Shri|Shree|Sri|Smt|Kumari|Master|Sh)';
const RELATION = '(?:father|mother|husband|wife|son|daughter|brother|sister|uncle|aunt|grandfather|grandmother|friend|neighbou?r|guardian|spouse|papa|mummy|bhai|behen|beti|beta|pati|patni)';
const STOP_ADDR = /\s(?:and|but|since|for|because|with|aur|lekin|se|ke saath)\s|[.;\n।]|\s[—–]\s/i;

const ASCII_DIGITS = (t) => t.replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x966)); // same length → offsets stay valid

// ------------------------------------------------------------------------------------------------
// optional NER (maintained library). Loaded lazily; absence is fine.
let nlp = null, nerTried = false;
async function loadNer() {
  if (nerTried) return nlp; nerTried = true;
  try { nlp = (await import('compromise')).default; } catch { nlp = null; }
  return nlp;
}
export const nerAvailable = () => !!nlp;
export const initPii = () => loadNer(); // call once at startup

// ------------------------------------------------------------------------------------------------
const PRIORITY = { EMAIL: 9, URL: 9, AADHAAR: 9, CARD: 9, PAN: 9, IFSC: 8, ABHA: 9, EPIC: 8, ID: 8, DOB: 8, PHONE: 8, ADDRESS: 7, PIN: 7, LOCATION: 6, PERSON: 5 };

function tokensAfter(text, from, { maxTokens = 3, caseSensitive = true, hindiRoman = false } = {}) {
  // collect consecutive name-like tokens starting at `from`
  const re = /[ \t]+|[A-Za-z][A-Za-z'’.-]*|[\u0900-\u097F]+|[^\sA-Za-z\u0900-\u097F]/y;
  let i = from, out = [], first = null, last = from;
  while (i < text.length && out.length < maxTokens) {
    re.lastIndex = i; const m = re.exec(text); if (!m) break;
    const tok = m[0];
    if (/^[ \t]+$/.test(tok)) { i += tok.length; continue; }
    if (/^[A-Z]\.$/.test(tok) && out.length < maxTokens - 1) { if (first === null) first = i; out.push(tok); last = i + tok.length; i = last; continue; } // initial ("A. Rao")
    const clean = tok.replace(/[.'’-]+$/, '');
    const low = clean.toLowerCase();
    const latin = /^[A-Za-z]/.test(clean), dev = /^[\u0900-\u097F]/.test(clean);
    const ok = clean.length >= 2 && !NOT_NAME.has(low) && (dev || (latin && (caseSensitive ? /^[A-Z][A-Za-z'’-]*$/.test(clean) : /^[A-Za-z]+$/.test(clean))));
    if (!ok) break;
    if (dev && /^(है|हैं|हूँ|हूं|और|को|की|का|के|से|में|मुझे)$/.test(clean)) break;
    if (first === null) first = i;
    out.push(clean); last = i + tok.length; i = last;
    if (/\.$/.test(tok) && clean.length > 1 && !/^(?:Mr|Mrs|Ms|Dr|Prof|Sh|Smt)$/i.test(clean)) { last = i - 1; break; } // sentence end ("Kumar. Call …")
  }
  return out.length ? { s: first, e: last, n: out.length } : null;
}

function detect(text) {
  const a = ASCII_DIGITS(text), out = [];
  const add = (s, e, type, conf = 1) => { if (e > s) out.push({ s, e, type, conf }); };
  const ctxBefore = (idx, n = 45) => a.slice(Math.max(0, idx - n), idx).toLowerCase();

  // ---- 1. structured identifiers ----
  for (const m of a.matchAll(/(?<![A-Z0-9._%+-])[A-Z0-9._%+-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63}){0,6}\.[A-Z]{2,24}/gi)) add(m.index, m.index + m[0].length, 'EMAIL');
  for (const m of a.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi)) add(m.index, m.index + m[0].length, 'URL');
  for (const m of a.matchAll(/(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (verhoeffValid(digits) || /aadh?aa?r|uidai|\buid\b|आधार/.test(ctxBefore(m.index))) add(m.index, m.index + m[0].length, 'AADHAAR');
  }
  for (const m of a.matchAll(/(?<!\d)\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g)) { // 16 digits: card (Luhn) or Aadhaar VID (context)
    const d = m[0].replace(/\D/g, '');
    if (luhnValid(d)) add(m.index, m.index + m[0].length, 'CARD');
    else if (/aadh?aa?r|vid\b|आधार/.test(ctxBefore(m.index))) add(m.index, m.index + m[0].length, 'AADHAAR');
    else if (/card|credit|debit|visa|master|rupay|cvv/.test(ctxBefore(m.index))) add(m.index, m.index + m[0].length, 'CARD');
  }
  for (const m of a.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) { // 13–19 digit cards
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 13 && (luhnValid(d) || /card|credit|debit|visa|master|rupay|cvv/.test(ctxBefore(m.index)))) add(m.index, m.index + m[0].length, 'CARD');
  }
  for (const m of a.matchAll(/(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/g)) add(m.index, m.index + m[0].length, 'PAN');
  for (const m of a.matchAll(/(?<![A-Z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Z0-9])/g)) add(m.index, m.index + m[0].length, 'IFSC');
  for (const m of a.matchAll(/(?<![A-Z0-9])[A-Z]{3}\d{7}(?!\d)/g)) add(m.index, m.index + m[0].length, 'EPIC');
  for (const m of a.matchAll(/(?<!\d)\d{2}-\d{4}-\d{4}-\d{4}(?!\d)/g)) add(m.index, m.index + m[0].length, 'ABHA');

  // phone numbers: candidates are validated, not just pattern-matched
  for (const m of a.matchAll(/(?<!\w)(?<!\d[,./:-])\+?\d[\d\s().-]{7,17}\d(?!\w)(?![,./:]\d)/g)) {
    const raw = m[0]; if (/\d\.\d/.test(raw)) continue; // decimals (lab values), not phone numbers
    const plus = raw.trim().startsWith('+'); let d = raw.replace(/\D/g, '');
    let phone = false;
    if (plus && d.length >= 11 && d.length <= 15) phone = true;
    else {
      let r = d; if (r.length === 12 && r.startsWith('91')) r = r.slice(2); else if (r.length === 11 && r.startsWith('0')) r = r.slice(1);
      if (r.length === 10 && /^[6-9]/.test(r)) phone = true;
      else if (/^0\d{9,11}$/.test(d)) phone = true;               // landline with STD code
    }
    if (phone) add(m.index, m.index + raw.length, 'PHONE');
  }

  // ---- 2. context-keyed identifiers ----
  const ID_CTX = /(?:\bmrn\b|\buhid\b|\babha(?:\s*(?:id|number|no\.?))?|patient\s*(?:id|no\.?|number)|\b(?:reg(?:istration)?|ip|op|case)\s*(?:no\.?|number|#)|passport(?:\s*(?:no\.?|number))?|voter\s*id|(?:driving\s*)?licen[cs]e(?:\s*(?:no\.?|number))?|\bdl\s*no\.?|account\s*(?:no\.?|number)|a\/c(?:\s*(?:no\.?|number))?|policy\s*(?:no\.?|number)|ration\s*card(?:\s*(?:no\.?|number))?|member\s*id|insurance\s*id|aadh?aa?r(?:\s*(?:no\.?|number))?|pan(?:\s*(?:no\.?|number|card))?)\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{3,24})/gid;
  for (const m of a.matchAll(ID_CTX)) { const [s, e] = m.indices[1]; if (/\d/.test(m[1])) add(s, e, 'ID'); }
  for (const m of a.matchAll(/(?:\bdob\b|d\.o\.b\.?|date\s+of\s+birth|\bborn(?:\s+on)?\b|जन्म(?:\s*(?:तिथि|तारीख))?)\s*[:\-]?\s*(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/gid)) add(m.indices[1][0], m.indices[1][1], 'DOB');
  for (const m of a.matchAll(/(?:pin\s*code|pincode|\bpin\b|postal\s*code|zip)\s*[:\-]?\s*([1-9]\d{2}\s?\d{3})(?!\d)/gid)) add(m.indices[1][0], m.indices[1][1], 'PIN');

  // addresses
  const house = /\b(?:h\.?\s?no\.?|house\s*(?:no\.?|number)|flat\s*(?:no\.?)?|plot\s*(?:no\.?)?|door\s*no\.?|room\s*no\.?)\s*[:#\-]?\s*[\w/-]+/gi;
  for (const m of a.matchAll(house)) {
    const rest = a.slice(m.index + m[0].length); const stop = rest.search(STOP_ADDR);
    add(m.index, m.index + m[0].length + Math.min(stop < 0 ? 80 : stop, 80), 'ADDRESS');
  }
  const cue = /(?:(?:my|our)\s+)?(?:home\s+|residential\s+|current\s+|permanent\s+)?address(?:\s+is)?|(?:live|lives|living|stay|stays|staying|reside|resides|residing)\s+(?:at|near)|\br\/o\b|resident\s+of|पता|रहता\s+हूँ|रहती\s+हूँ/gi;
  for (const m of a.matchAll(cue)) {
    let from = m.index + m[0].length; while (/[\s:\-]/.test(a[from] || '')) from++;
    if (a[from] === '\u0001') continue; // already masked
    const rest = a.slice(from, from + 100); const stop = rest.search(STOP_ADDR);
    const len = Math.min(stop < 0 ? 90 : stop, 90); if (len >= 3) add(from, from + len, 'ADDRESS');
  }
  for (const m of a.matchAll(/(?:live|lives|living|stay|stays|staying|reside|resides|residing)\s+in\s+/gi)) { // coarse location
    const from = m.index + m[0].length; if (a[from] === '\u0001') continue; const rest = a.slice(from, from + 60); const stop = rest.search(STOP_ADDR);
    const len = Math.min(stop < 0 ? 40 : stop, 40);
    if (len >= 3 && /^[A-Z\u0900-\u097F]/.test(a.slice(from, from + 1))) add(from, from + len, 'LOCATION', 0.7);
  }
  for (const m of a.matchAll(/\b(?:[A-Z][a-z]+\s+){1,3}(?:Road|Rd\.?|Street|St\.?|Nagar|Colony|Lane|Marg|Chowk|Sector\s*\d+|Enclave|Vihar|Puram|Bazaar|Market|Gali|Mohalla|Society|Apartments?|Layout|Cross)\b(?:\s*,\s*[A-Z][a-z]+)*(?:\s*[-,]?\s*[1-9]\d{2}\s?\d{3}(?!\d))?/g)) add(m.index, m.index + m[0].length, 'ADDRESS', 0.8);

  // ---- 3. names ----
  const cueNames = [
    [/\b(?:my\s+name\s+is|name\s+is|patient(?:'s|’s)?\s+name(?:\s+is)?|name\s*[:\-]|i\s+am\s+called|i'm\s+called|known\s+as|signed|regards)\s*/gi, { caseSensitive: true }],
    [new RegExp(`\\b${TITLE}\\.?\\s+`, 'g'), { caseSensitive: true, maxTokens: 3 }],
    [new RegExp(`\\b${RELATION}(?:'s|’s)?\\s+(?:(?:name\\s+is|named|called)\\s+)?`, 'gi'), { caseSensitive: true }],
    [/\b(?:mera\s+naam|mera\s+nam|meri\s+naam|naam|nam)\s*[:\-]?\s*(?:hai\s+)?/gi, { caseSensitive: false }],
    [/(?:मेरा\s+नाम|मेरी\s+नाम|नाम)\s*[:\-]?\s*/g, { caseSensitive: false }],
    [/(?:श्रीमती|श्री|डॉ\.?|कुमारी)\s*/g, { caseSensitive: false }],
  ];
  for (const [re, opt] of cueNames) {
    for (const m of text.matchAll(re)) {
      const t = tokensAfter(text, m.index + m[0].length, opt);
      if (t) add(t.s, t.e, 'PERSON', 0.9);
    }
  }
  for (const m of text.matchAll(/\b([A-Z][a-z]{2,})\s+ji\b/g)) if (!NOT_NAME.has(m[1].toLowerCase())) add(m.index, m.index + m[1].length, 'PERSON', 0.7);
  // gazetteer: capitalised tokens that are common Indian names; adjacent hits merge into one name
  const tokRe = /[A-Za-z][A-Za-z'’-]*/g; let run = null;
  const flush = () => { if (run) add(run.s, run.e, 'PERSON', 0.6); run = null; };
  let lastEnd = -10;
  for (const m of text.matchAll(tokRe)) {
    const t = m[0], low = t.toLowerCase();
    const cap = /^[A-Z][a-z'’-]+$/.test(t) || /^[A-Z]{3,}$/.test(t);
    const hit = cap && NAME_SET.has(low) && !NOT_NAME.has(low) && t !== 'ASHA'; // ASHA = accredited health worker (acronym), not a name
    if (hit) {
      if (run && /^[ \t]+$/.test(text.slice(lastEnd, m.index))) run.e = m.index + t.length; else { flush(); run = { s: m.index, e: m.index + t.length }; }
      lastEnd = m.index + t.length;
    } else flush();
  }
  flush();
  if (nlp) { // optional maintained NER library, if installed
    try {
      for (const p of nlp(text).people().json({ offset: true })) {
        const s = p.offset?.start, l = p.offset?.length;
        if (Number.isInteger(s) && Number.isInteger(l) && !NOT_NAME.has(String(p.text).trim().toLowerCase())) add(s, s + l, 'PERSON', 0.6);
      }
    } catch { /* NER is best-effort */ }
  }
  return out;
}

function resolve(spans) {
  const sorted = [...spans].sort((x, y) => (PRIORITY[y.type] - PRIORITY[x.type]) || ((y.e - y.s) - (x.e - x.s)) || x.s - y.s);
  const taken = [];
  for (const s of sorted) if (!taken.some((t) => s.s < t.e && t.s < s.e)) taken.push(s);
  return taken.sort((x, y) => x.s - y.s);
}

const keyOf = (type, raw) => (['PHONE', 'AADHAAR', 'CARD', 'PIN', 'ABHA'].includes(type) ? raw.replace(/\D/g, '') : raw.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim());
const PH = /\[[A-Z]+_\d+\]/g;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Masker {
  /** @param {Record<string,string>} vault existing placeholder→original map (to keep numbering stable across a case) */
  constructor(vault = {}) {
    this.vault = { ...vault }; this.n = {}; this.byKey = new Map();
    for (const [ph, original] of Object.entries(this.vault)) {
      const m = /^([A-Z]+)_(\d+)$/.exec(ph); if (!m) continue;
      this.n[m[1]] = Math.max(this.n[m[1]] || 0, +m[2]); this.byKey.set(`${m[1]}|${keyOf(m[1], original)}`, ph);
    }
  }
  placeholder(type, raw) {
    const key = `${type}|${keyOf(type, raw)}`;
    if (this.byKey.has(key)) return this.byKey.get(key);
    if (type === 'PERSON') { // "Ravi" after "Ravi Kumar" → same person
      const toks = keyOf(type, raw).split(' ');
      for (const [ph, orig] of Object.entries(this.vault)) if (ph.startsWith('PERSON_') && toks.length === 1 && keyOf('PERSON', orig).split(' ').includes(toks[0])) { this.byKey.set(key, ph); return ph; }
    }
    const k = (this.n[type] = (this.n[type] || 0) + 1), ph = `${type}_${k}`;
    this.vault[ph] = raw.trim(); this.byKey.set(key, ph); return ph;
  }
  /** Mask `text`. Returns { text, items:[{type,placeholder}] } */
  mask(text) {
    const src = String(text ?? ''); if (!src) return { text: '', items: [] };
    const spans = resolve(detect(src)); let out = '', pos = 0; const items = [];
    for (const s of spans) {
      const raw = src.slice(s.s, s.e); const ph = this.placeholder(s.type, raw);
      out += src.slice(pos, s.s) + `[${ph}]`; pos = s.e; items.push({ type: s.type, placeholder: ph });
    }
    out += src.slice(pos);
    // propagation: later bare mentions of an already-detected name / identifier
    for (const [ph, original] of Object.entries(this.vault)) {
      const type = ph.split('_')[0];
      if (type === 'PERSON') {
        for (const tok of original.split(/\s+/).filter((t) => t.length >= 3 && !NOT_NAME.has(t.toLowerCase()) && !/^[\u0900-\u097F]/.test(t))) {
          out = out.replace(new RegExp(`(?<![\\w\\[])${esc(tok)}(?![\\w\\]])`, 'gi'), `[${ph}]`);
        }
        if (/^[\u0900-\u097F]/.test(original)) out = out.split(original).join(`[${ph}]`);
      } else if (original.length >= 4) out = out.split(original).join(`[${ph}]`);
    }
    return { text: out, items };
  }
  /** Re-scan masked text. ok=false means something identifying is (probably) still in there. Never returns the values. */
  verify(masked) {
    if (__test.failVerify) return { ok: false, residual: ['TEST_HOOK'] };
    const blank = String(masked).replace(PH, '\u0001');
    const residual = [...new Set(detect(blank).map((s) => s.type))];
    for (const [ph, original] of Object.entries(this.vault)) if (original.length >= 4 && blank.toLowerCase().includes(original.toLowerCase())) residual.push(ph.split('_')[0] + '_PROPAGATION');
    return { ok: residual.length === 0, residual: [...new Set(residual)] };
  }
  /** Mask + verify; throws PiiError (callers must then skip external/AI processing). */
  maskStrict(text) {
    const r = this.mask(text); const v = this.verify(r.text);
    if (!v.ok) throw new PiiError('Masking could not be verified', v.residual);
    return r;
  }
  /** Restore original values (server-side display of model quotes only). */
  unmask(text) { return String(text ?? '').replace(/\[([A-Z]+_\d+)\]/g, (m, ph) => this.vault[ph] ?? m); }
  counts() { const c = {}; for (const ph of Object.keys(this.vault)) { const t = ph.split('_')[0]; c[t] = (c[t] || 0) + 1; } return c; }
  exportVault() { return { ...this.vault }; }
}

export const maskOnce = (text) => { const m = new Masker(); const r = m.mask(text); return { ...r, verified: m.verify(r.text).ok, counts: m.counts() }; };
