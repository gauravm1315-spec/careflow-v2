// Deterministic fallback used when the language model is unavailable (or masking cannot be verified).
// It is RULE-BASED keyword extraction — it does not understand language, does not translate, and will miss things.
// Every output built here is labelled "Rule-based fallback" in the UI and in the note.
import { splitSentences } from './safety.js';

const src = (quote, kind = 'message', ref = null, page = null) => ({ kind, ref, quote, verified: true, page });
const F = (text, quote, kind, ref, page) => ({ text, detail: '', source: src(quote, kind, ref, page), confidence: null });

const SYMPTOMS = [
  ['Fever', /fever|temperature|bukhar|bukhaar|बुखार|बुख़ार/i], ['Headache', /headache|head ache|sir\s*dard|सिर\s*दर्द|सरदर्द/i], ['Cough', /cough|khansi|खांसी|खाँसी/i],
  ['Cold / runny nose', /\bcold\b|runny nose|sneez|zukam|jukam|ज़ुकाम|जुकाम/i], ['Sore throat', /sore throat|throat pain|gala\s*dard|गले\s*में\s*दर्द/i],
  ['Vomiting', /vomit|ulti|उल्टी/i], ['Nausea', /nausea|nauseous|ji\s*michl|जी\s*मिचल/i], ['Diarrhoea', /diarrh|loose\s*motion|\bdast\b|दस्त/i],
  ['Abdominal pain', /stomach\s*(?:pain|ache)|abdominal|belly\s*pain|pet\s*(?:me\s*)?dard|पेट\s*(?:में\s*)?दर्द/i], ['Chest pain', /chest\s*(?:pain|tightness|pressure)|(?:pain|tightness|pressure)\s+in\s+(?:my\s+)?chest|seen[ae]\s+(?:me|mein)\s+dard|सीने\s*में\s*दर्द/i],
  ['Breathlessness', /short(?:ness)?\s*of\s*breath|breathless|difficulty\s*breathing|saans\s*(?:phool|nahi|lene)|सांस|साँस/i], ['Dizziness', /dizz|giddiness|chakkar|चक्कर/i],
  ['Weakness / fatigue', /weak|tired|fatigue|kamzori|thakan|कमज़ोरी|कमजोरी|थकान/i], ['Body ache', /body\s*(?:ache|pain)|badan\s*dard|बदन\s*दर्द|शरीर\s*में\s*दर्द/i],
  ['Joint pain', /joint\s*pain|knee\s*pain|जोड़ों\s*में\s*दर्द/i], ['Back pain', /back\s*pain|kamar\s*dard|कमर\s*दर्द/i], ['Rash', /\brash\b|itching|khujli|खुजली/i],
  ['Swelling', /swelling|swollen|sujan|सूजन/i], ['Sweating', /sweat|pasina|पसीना/i], ['Bleeding', /bleeding|blood\s*in|khoon|खून/i],
  ['Burning urination', /burning\s*(?:while|during|on)?\s*urin|painful\s*urin/i], ['Loss of appetite', /loss\s*of\s*appetite|not\s*eating|bhookh\s*nahi|भूख\s*नहीं/i],
];
const NEG = /\b(?:no|not|without|denies|denied|never|nahi|nahin)\b|नहीं|नही/i;
const DUR = /(?:since|for|from|past|last|over)\s+(?:the\s+)?(?:(?:last|past)\s+)?(\d+|a|an|one|two|three|four|five|six|seven|ten|few|couple of)\s*(hours?|days?|weeks?|months?|years?)|(\d+|ek|do|teen|char|paanch)\s*(din|hafte|haftey|mahine|ghante|saal)\s*se|since\s+(?:yesterday|morning|last\s+night|this\s+morning|last\s+week|today)|kal\s+se|aaj\s+se|(\d+|[०-९]+)\s*(?:दिन|हफ्ते|महीने|घंटे|साल)\s*से|सुबह\s*से|कल\s*से/i;
const PROG = [['Getting worse', /worse|worsen|increas|getting\s+bad|badh|बढ़|ज्यादा\s*हो/i], ['Getting better', /better|improv|reduc|kam\s*ho|घट|ठीक\s*हो/i], ['Unchanged', /\b(?:same|unchanged|no\s+change)\b|वैसा\s*ही/i]];
const SEV = /(\d{1,2})\s*(?:\/|out\s+of)\s*10|\b(mild|moderate|severe|unbearable|very\s+bad|bahut\s+zyada)\b/i;
const HIST = [['Diabetes', /diabet|sugar\b|शुगर|मधुमेह/i], ['High blood pressure', /hypertension|high\s+(?:blood\s+)?pressure|\bbp\b|बीपी/i], ['Asthma', /asthma|दमा|अस्थमा/i], ['Thyroid condition', /thyroid/i],
  ['Heart condition', /heart\s+(?:disease|problem|attack)|cardiac/i], ['Kidney condition', /kidney/i], ['Tuberculosis', /\btb\b|tuberculosis/i], ['Epilepsy', /epilep|seizure\s+disorder/i], ['Cancer', /cancer/i]];
const DRUGS = /\b(paracetamol|acetaminophen|crocin|dolo(?:\s*650)?|ibuprofen|aspirin|amlodipine|metformin|insulin|atorvastatin|azithromycin|amoxicillin|cetirizine|pantoprazole|omeprazole|salbutamol|levothyroxine|telmisartan|losartan|ors)\b(?:\s+\d+\s*(?:mg|ml))?/gi;

const sentences = (t) => splitSentences(t);
const first = (arr, re, { allowNeg = false } = {}) => arr.find((s) => re.test(s) && (allowNeg || !NEG.test(s.split(re)[0] || '')));

export function detectLanguage(t) {
  const dev = (t.match(/[\u0900-\u097F]/g) || []).length, lat = (t.match(/[A-Za-z]/g) || []).length;
  if (dev > lat * 0.3 && dev > 5) return 'Hindi / Devanagari (script detected)';
  if (/\b(mujhe|mera|meri|bukhar|khansi|dard|nahi|hai|hoon|din se|saans|pet|sir)\b/i.test(t)) return 'Hinglish (keyword heuristic)';
  return 'English (assumed)';
}

/** Parse "Name  value unit (range) H/L" lines from report text. Only trusts flags the document itself prints. */
export function parseLabLines(text) {
  const out = []; let page = 1;
  for (const line of String(text || '').split(/\n|\|/)) {
    const pg = /\[page\s*(\d+)\]/i.exec(line); if (pg) page = +pg[1];
    const l = line.replace(/\[page\s*\d+\]/gi, '').trim();
    const m = /^([A-Za-z][A-Za-z0-9 %()/.+-]{1,38}?)\s*[:\-]?\s+([<>]?\d[\d,]*\.?\d*)\s*([A-Za-zµ%/]+(?:\/[A-Za-zµ]+)?)?\s*(?:\(?\s*((?:[<>]\s*)?\d[\d.,]*\s*(?:[-–]\s*\d[\d.,]*)?)\s*\)?)?\s*(H|L|HIGH|LOW|High|Low)?\b/.exec(l);
    if (!m || /^(page|date|age|phone|id|sample)\b/i.test(m[1])) continue;
    const mark = (m[5] || '').toUpperCase();
    out.push({ name: m[1].trim(), value: m[2], unit: m[3] || null, range: m[4] || null, flag: mark.startsWith('H') ? 'high' : mark.startsWith('L') ? 'low' : 'unknown', page, confidence: null, lowConfidence: false, quote: l.slice(0, 160) });
  }
  return out.slice(0, 40);
}

// lexical associations used ONLY to notice that a patient statement and a report refer to the same thing. No thresholds.
const CONFLICT_LINKS = { diabetes: ['hba1c', 'glucose', 'blood sugar'], anaemia: ['haemoglobin', 'hemoglobin', 'hb '], 'high blood pressure': ['blood pressure'] };

export function extractSummary(text, reports = []) {
  const S = sentences(text);
  const sum = { chiefComplaint: '', symptoms: [], denied: [], onset: null, progression: null, severity: null, history: [], medications: [], allergies: [], timeline: [], reportFindings: [], missing: [], conflicts: [], uncertain: [] };
  for (const [name, re] of SYMPTOMS) {
    for (const s of S) {
      const m = re.exec(s); if (!m) continue;
      const neg = NEG.test(s.slice(Math.max(0, m.index - 28), m.index)) || (/नहीं|nahi/i.test(s) && !/हैं|hai/i.test(s.replace(/nahi/gi, '')));
      (neg ? sum.denied : sum.symptoms).push(F(name, s)); break;
    }
  }
  for (const s of S) { const m = DUR.exec(s); if (m) { sum.onset = F(m[0].trim(), s); break; } }
  for (const [label, re] of PROG) { const s = first(S, re); if (s) { sum.progression = F(label, s); break; } }
  for (const s of S) { const m = SEV.exec(s); if (m) { sum.severity = F(m[1] ? `${m[1]}/10` : m[2], s); break; } }
  for (const [label, re] of HIST) {
    const s = S.find((x) => re.test(x)); if (!s) continue;
    const m = re.exec(s); (NEG.test(s.slice(Math.max(0, m.index - 24), m.index)) ? sum.denied : sum.history).push(F(label, s));
  }
  if (!sum.history.length) { const s = S.find((x) => /no\s+(?:medical\s+)?(?:history|conditions?|illness)|koi\s+bimari\s+nahi/i.test(x)); if (s) sum.history.push(F('No relevant history reported', s)); }
  const seen = new Set();
  for (const s of S) for (const m of s.matchAll(DRUGS)) { const k = m[0].toLowerCase(); if (!seen.has(k)) { seen.add(k); sum.medications.push(F(m[0].trim(), s)); } }
  if (!sum.medications.length) { const s = S.find((x) => /no\s+medic(?:ine|ation)s?|not\s+taking\s+any|koi\s+dawai\s+nahi/i.test(x)); if (s) sum.medications.push(F('No medicines reported', s)); }
  for (const s of S) { const m = /allerg(?:y|ic|ies)\s*(?:to|:)?\s*([A-Za-z]+)?/i.exec(s); if (!m) continue;
    sum.allergies.push(F(NEG.test(s) ? 'No allergies reported' : `Allergy${m[1] && !/^(and|is|to)$/i.test(m[1]) ? `: ${m[1]}` : ' reported'}`, s)); break; }
  if (!sum.allergies.length) { const s = S.find((x) => /koi\s+allergy\s+nahi|एलर्जी\s+नहीं/i.test(x)); if (s) sum.allergies.push(F('No allergies reported', s)); }

  // reports
  for (const r of reports) {
    for (const v of r.values.filter((x) => x.flag === 'high' || x.flag === 'low')) sum.reportFindings.push({ text: `${v.name} ${v.value}${v.unit ? ' ' + v.unit : ''} (marked ${v.flag} in the report)`, source: src(v.quote || `${v.name} ${v.value}`, 'report', r.id, v.page) });
    for (const u of r.unreadable || []) sum.uncertain.push({ item: `${r.fileName}: ${u}`, reason: 'Unreadable part of report' });
  }
  const lowTerms = text.toLowerCase();
  for (const [cond, links] of Object.entries(CONFLICT_LINKS)) {
    const denied = sum.denied.some((d) => d.text.toLowerCase().includes(cond.split(' ')[0])) || new RegExp(`(?:no|not|don'?t have|do not have)\\s+(?:any\\s+)?${cond.split(' ')[0]}`, 'i').test(lowTerms);
    if (!denied) continue;
    for (const r of reports) {
      const v = r.values.find((x) => (x.flag === 'high' || x.flag === 'low') && links.some((l) => x.name.toLowerCase().includes(l.trim())));
      if (v) {
        const ps = S.find((x) => new RegExp(cond.split(' ')[0], 'i').test(x)) || text.slice(0, 120);
        sum.conflicts.push({ description: `Patient reports no ${cond}, but the report marks ${v.name} as ${v.flag} (${v.value}${v.unit ? ' ' + v.unit : ''}).`, a: { text: ps, source: src(ps) }, b: { text: `${v.name} ${v.value}`, source: src(v.quote || `${v.name} ${v.value}`, 'report', r.id, v.page) } });
      }
    }
  }
  for (const m of text.matchAll(/\[unclear:\s*([^\]]+)\]/gi)) sum.uncertain.push({ item: m[1].trim(), reason: 'Unclear word in the transcript' });
  sum.chiefComplaint = sum.symptoms.length ? sum.symptoms.slice(0, 3).map((s) => s.text.toLowerCase()).join(', ').replace(/^./, (c) => c.toUpperCase()) : (S[0] ? S[0].slice(0, 90) : 'Not clearly stated');
  sum.missing = [!sum.symptoms.length && 'Identifiable symptoms', !sum.onset && 'Onset / duration', !sum.progression && 'Progression', !sum.severity && 'Severity', !sum.history.length && 'Relevant medical history',
    !sum.medications.length && 'Current medications', !sum.allergies.length && 'Allergies'].filter(Boolean).map((field) => ({ field, why: '' }));
  return sum;
}

const Q = [
  ['onset', 'When did the symptoms first begin?', 'लक्षण कब शुरू हुए?', 'Onset not reported', 'text'],
  ['progression', 'Are the symptoms getting better, worse, or staying the same?', 'क्या लक्षण बेहतर हो रहे हैं, बिगड़ रहे हैं, या वैसे ही हैं?', 'Progression not reported', 'choice', ['Better', 'Worse', 'Same']],
  ['severity', 'How severe are the symptoms, from 0 (none) to 10 (worst)?', 'लक्षण कितने गंभीर हैं, 0 (कुछ नहीं) से 10 (सबसे ज़्यादा)?', 'Severity not reported', 'scale_0_10'],
  ['history', 'Do you have any long-term medical conditions (for example diabetes, blood pressure, asthma)?', 'क्या आपको कोई पुरानी बीमारी है (जैसे शुगर, बीपी, दमा)?', 'No medical history provided', 'text'],
  ['medications', 'Are you currently taking any medicines?', 'क्या आप अभी कोई दवा ले रहे हैं?', 'Medication list missing', 'text'],
  ['allergies', 'Do you have any allergies to medicines or food?', 'क्या आपको किसी दवा या खाने से एलर्जी है?', 'Allergy status unknown', 'yes_no'],
];
export function fallbackFollowUps(summary, hindi) {
  const qs = Q.filter(([k]) => !summary[k] || (Array.isArray(summary[k]) && !summary[k].length))
    .map(([, q, hi, reason, type, options]) => ({ q, local: hindi ? hi : q, reason, type, options: options || [] }));
  for (const c of summary.conflicts.slice(0, 1)) qs.unshift({ q: 'Your report and your message seem to disagree on one point. Can you tell us more?', local: hindi ? 'आपकी रिपोर्ट और आपके संदेश में एक बात मेल नहीं खा रही। क्या आप थोड़ा और बता सकते हैं?' : 'Your report and your message seem to disagree on one point. Can you tell us more?', reason: c.description, type: 'text', options: [] });
  return qs.slice(0, 6).map((q, i) => ({ id: `q${i + 1}`, priority: i + 1, ...q }));
}

/** Update a fallback summary with the patient's answers (kept verbatim — no interpretation). */
export function mergeAnswers(summary, answers) {
  const s = structuredClone(summary);
  for (const a of answers) {
    if (a.skipped) continue;
    const f = F(a.answer, a.answer, 'answer', a.qid);
    const q = a.q.toLowerCase();
    if (/begin|start|when/.test(q) && !s.onset) s.onset = f;
    else if (/better|worse|same/.test(q) && !s.progression) s.progression = f;
    else if (/severe|0 \(none\)/.test(q) && !s.severity) s.severity = F(`${a.answer}/10`, a.answer, 'answer', a.qid);
    else if (/long-term|conditions/.test(q)) s.history.push(f);
    else if (/medicine/.test(q)) s.medications.push(f);
    else if (/allerg/.test(q)) s.allergies.push(F(/^(no|nahi|नहीं)/i.test(a.answer) ? 'No allergies reported' : `Allergy reported: ${a.answer}`, a.answer, 'answer', a.qid));
    else s.timeline.push({ when: '', event: `${a.q} → ${a.answer}`, source: src(a.answer, 'answer', a.qid) });
  }
  s.missing = [!s.symptoms.length && 'Identifiable symptoms', !s.onset && 'Onset / duration', !s.progression && 'Progression', !s.severity && 'Severity', !s.history.length && 'Relevant medical history',
    !s.medications.length && 'Current medications', !s.allergies.length && 'Allergies'].filter(Boolean).map((field) => ({ field, why: '' }));
  return s;
}
