import * as slm from './slm.js';
import * as N from './normalize.js';
import { screen, detectInjection, norm, LEVEL_RANK } from './safety.js';
import { Masker, PiiError } from './pii.js';
import { extractSummary, fallbackFollowUps, mergeAnswers, detectLanguage } from './fallback.js';
import { computePriority, effectiveCategory, isReviewed, waitedMs } from './priority.js';
import { nextCaseId, saveFile, uid } from './db.js';

export const LABEL = { urgent: 'Urgent review', priority: 'Priority review', clarification: 'Needs clarification', routine: 'Routine review' };
const DISCLAIMER = 'Decision-support content only. Not a diagnosis. The priority is a preliminary suggestion, not a validated risk score. Requires review by a qualified healthcare professional.';
export const MODE_LABEL = { model: 'Local language-model draft', fallback: 'Rule-based fallback (no AI)', demo: 'Synthetic demo data (rule-based)' };

// ---- deterministic helpers -------------------------------------------------------------------
export function completeness(s) {
  const parts = [s.symptoms.length > 0, !!s.onset, !!s.progression, !!s.severity, s.history.length > 0, s.medications.length > 0, s.allergies.length > 0];
  return Math.round((parts.filter(Boolean).length / parts.length) * 100);
}
const missingFrom = (s) => [!s.symptoms.length && 'Identifiable symptoms', !s.onset && 'Symptom onset / duration', !s.progression && 'Progression', !s.severity && 'Severity',
  !s.history.length && 'Relevant medical history', !s.medications.length && 'Current medications', !s.allergies.length && 'Allergies'].filter(Boolean).map((field) => ({ field, why: '' }));

const dedupeFlags = (flags) => {
  const seen = [];
  return flags.filter((f) => {
    const key = norm(f.evidence).slice(0, 60);
    if (seen.some((k) => key && k && (k.includes(key) || key.includes(k)))) return false;
    seen.push(key); return true;
  });
};
const emptySummary = () => ({ chiefComplaint: 'Insufficient information', symptoms: [], denied: [], onset: null, progression: null, severity: null,
  history: [], medications: [], allergies: [], timeline: [], reportFindings: [], missing: [], conflicts: [], uncertain: [] });

/** Restore original wording inside quotes/evidence ONLY (server-side, so evidence can be highlighted in the real text). */
function unmaskQuotes(v, mk) {
  if (Array.isArray(v)) return v.map((x) => unmaskQuotes(x, mk));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, (k === 'quote' || k === 'evidence') && typeof x === 'string' ? mk.unmask(x) : unmaskQuotes(x, mk)]));
  return v;
}
const unmaskFollowUps = (qs, mk) => qs.map((q) => ({ ...q, q: mk.unmask(q.q), local: mk.unmask(q.local), reason: mk.unmask(q.reason), options: q.options.map((o) => mk.unmask(o)) }));


/** Compact text-only view of the previous summary for the final-summary prompt. Quotes are dropped; the result is MASKED before use. */
const slimSummary = (s) => ({ chief_complaint: s.chiefComplaint, symptoms: s.symptoms.map((x) => x.text), denied: s.denied.map((x) => x.text), onset: s.onset?.text || null, progression: s.progression?.text || null,
  severity: s.severity?.text || null, history: s.history.map((x) => x.text), medications: s.medications.map((x) => x.text), allergies: s.allergies.map((x) => x.text), missing: s.missing.map((m) => m.field),
  conflicts: s.conflicts.map((x) => x.description), uncertain: s.uncertain.map((x) => x.item) });

function setPriority(c) {
  c.priority = computePriority(c, { previous: c.priority });
  c.category = c.priority.category; // kept for compatibility with older code paths
}

// ---- note builder (deterministic; the model only contributes the narrative) ------------------------
const F = (x) => (x ? x.text : 'Not reported');
const L = (a) => a.map((x) => x.text).join('; ') || 'Not reported';
export function summaryToText(s) {
  return [`Chief complaint: ${s.chiefComplaint}`, `Symptoms: ${s.symptoms.map((x) => x.text).join(', ') || 'None identified'}`, `Onset: ${F(s.onset)}`, `Progression: ${F(s.progression)}`,
    `Severity: ${F(s.severity)}`, `History: ${L(s.history)}`, `Medications: ${L(s.medications)}`, `Allergies: ${L(s.allergies)}`, `Reported negatives: ${s.denied.map((x) => x.text).join(', ') || 'None'}`].join('\n');
}

export function buildNote(c) {
  const s = c.summary, rv = c.review || {}, cat = effectiveCategory(c), lim = [];
  if (c.message.language.detected && !/^english/i.test(c.message.language.detected)) lim.push(c.ai.mode === 'model' ? `message in ${c.message.language.detected}, machine-translated (confidence ${Math.round((c.message.translation.confidence ?? 0) * 100)}%) — verify against original` : `message in ${c.message.language.detected}; no translation available — read the original`);
  if (c.message.voice?.uncertain?.length) lim.push(`${c.message.voice.uncertain.length} unclear phrase(s) in voice transcript`);
  c.reports.forEach((r) => r.unreadable.length && lim.push(`${r.fileName}: ${r.unreadable.join(', ')}`));
  const unv = [...c.flags.map((f) => f.source), ...[...s.symptoms, s.onset, s.progression, s.severity].filter(Boolean).map((f) => f.source)].filter((x) => x && !x.verified && !x.translated).length;
  if (unv) lim.push(`${unv} model-cited source quote(s) could not be matched to the original text — check evidence`);
  if (c.ai.mode !== 'model' && !c.synthetic) lim.push(`rule-based extraction used (${c.ai.reason || 'language model unavailable'}) — keyword matching only, may miss details`);
  const priority = c.priority;
  const pii = c.privacy?.masked ? Object.entries(c.privacy.counts).map(([k, v]) => `${k.toLowerCase()} ×${v}`).join(', ') : '';
  return [
    'CAREFLOW — REFERRAL / TRIAGE NOTE (DRAFT)',
    `Case: ${c.id}    Created: ${c.createdAt}`,
    `Summary source: ${MODE_LABEL[c.ai.mode === 'model' ? 'model' : c.synthetic ? 'demo' : 'fallback']}${c.ai.mode === 'model' && c.ai.model ? ` (${c.ai.model})` : ''}`,
    c.privacy?.masked ? `Privacy: personal identifiers were masked before any model processing${pii ? ` (${pii})` : ' (none found)'}; masking is heuristic.` : null,
    '',
    `Chief complaint: ${s.chiefComplaint}`,
    c.narrative ? `Overview: ${c.narrative}` : null,
    `Timeline: onset — ${F(s.onset)}; progression — ${F(s.progression)}; severity — ${F(s.severity)}`,
    `Reported symptoms: ${s.symptoms.map((x) => x.text).join(', ') || 'none identified'}${s.denied.length ? `; denies ${s.denied.map((x) => x.text).join(', ')}` : ''}`,
    `History: ${L(s.history)}`, `Medications: ${L(s.medications)}`, `Allergies: ${L(s.allergies)}`,
    c.reports.length ? `Reports: ${c.reports.map((r) => `${r.fileName} (${r.docType}${r.date ? ', ' + r.date : ''})`).join('; ')}` : null,
    s.reportFindings.length ? `Report findings: ${s.reportFindings.map((f) => f.text).join('; ')}` : null,
    `Possible warning signs: ${c.flags.length ? c.flags.map((f) => `${f.label} [${f.origin === 'rule' ? 'rule' : 'model'}: “${f.evidence}”]`).join('; ') : 'none recognised in available information'}`,
    c.answers.length ? `Patient follow-up answers:\n${c.answers.map((a) => `  - ${a.q} → ${a.skipped ? '(skipped)' : a.answer}`).join('\n')}` : null,
    `Missing information: ${s.missing.map((m) => m.field).join('; ') || 'none'}`,
    `Conflicting information: ${s.conflicts.map((x) => x.description).join('; ') || 'none'}`,
    `Uncertainty / limitations: ${[...s.uncertain.map((u) => u.item), ...lim].join('; ') || 'none'}`,
    c.suspicious.length ? `Suspicious embedded instructions (ignored): ${c.suspicious.map((x) => `“${x.quote}”`).join('; ')}` : null,
    c.clinicianQuestions?.length ? `Suggested questions for clinician: ${c.clinicianQuestions.join(' | ')}` : null,
    `Preliminary priority suggestion: ${LABEL[priority.category]} — ${priority.reasons.slice(0, 3).map((r) => r.text).join(' ')}`,
    rv.confirmed ? `Clinician-confirmed priority: ${LABEL[rv.confirmed.category]} (confirmed by ${rv.confirmed.by})` : null,
    rv.override ? `Clinician-confirmed priority: ${LABEL[rv.override.to]} — OVERRIDDEN from ${LABEL[rv.override.from]} by ${rv.override.by}: ${rv.override.reason}` : null,
    !rv.confirmed && !rv.override ? `Priority not yet reviewed by a clinician (current: ${LABEL[cat]}).` : null,
    `Reviewer notes: ${rv.notes || '—'}`,
    'Approval status: NOT APPROVED',
    '', DISCLAIMER,
  ].filter((l) => l !== null).join('\n');
}

// ---- model availability gate -----------------------------------------------------------------
async function modelReady() {
  const st = await slm.status();
  if (!st.enabled || !st.reachable || !st.modelPresent) return { ok: false, reason: st.reason };
  return { ok: true, st };
}
const fbReason = (e) => (e instanceof PiiError ? 'privacy masking could not be verified, so no text was sent to a model' : e?.message || 'language model unavailable');

// ---- case creation ---------------------------------------------------------------------------
const clean = (t) => String(t || '').replace(/\u0000/g, '').trim().slice(0, 6000);

export async function createCase({ user, body, pending, offline = false }) {
  const text = clean(body.text);
  if (!text && !pending.reports.length) throw Object.assign(new Error('Please describe the symptoms or attach a report.'), { status: 400 });
  const id = nextCaseId();
  const uiLang = body.uiLang === 'hi' ? 'hi' : 'en';
  const browserStt = body.voiceMode === 'browser-stt';
  const files = [], reports = [];
  const hasVoice = !!pending.audio || browserStt;
  const mode = hasVoice ? (pending.reports.length ? 'mixed' : 'voice') : pending.reports.length && !text ? 'report' : pending.reports.length ? 'mixed' : 'text';

  if (pending.audio) {
    const fid = uid('f'); saveFile(id, fid, pending.audio.buf);
    files.push({ id: fid, kind: 'audio', fileName: 'voice-recording.wav', mime: pending.audio.mime, size: pending.audio.buf.length });
    pending.audio.fileId = fid;
  }
  for (const p of pending.reports) {
    const fid = uid('f'); saveFile(id, fid, p.buf);
    files.push({ id: fid, kind: 'report', fileName: p.fileName, mime: p.mime, size: p.buf.length });
    const x = p.extraction;
    reports.push({ id: fid, fileName: p.fileName, docType: x.docType, date: x.date, values: x.values, rawText: x.rawText, unreadable: x.unreadable, confidence: x.confidence, isMedical: x.isMedical, mode: x.mode });
  }

  const c = {
    id, ownerId: user.id, ownerName: user.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    uiLang, inputMode: mode, consent: { at: new Date().toISOString(), version: 'v2', withdrawnAt: null }, stage: 'needs_answers',
    ai: { mode: 'fallback', model: null, intake: 'fallback', final: 'pending', reason: '', errors: [] },
    privacy: { masked: false, verified: false, counts: {} }, vault: {},
    message: { text, english: null, language: { detected: null, confidence: null }, translation: { confidence: null, uncertain: [] },
      voice: pending.audio ? { fileId: pending.audio.fileId, uncertain: pending.audio.uncertain || [], confidence: pending.audio.confidence ?? null, language: pending.audio.language, via: 'local-stt' }
        : browserStt ? { fileId: null, uncertain: [], confidence: null, language: null, via: 'browser-stt' } : null },
    files, reports, summary: emptySummary(), flags: [], suspicious: [], followUps: [], answers: [], patientRecap: null, narrative: '', clinicianQuestions: [],
    aiPriority: null, priority: null, category: 'clarification', completeness: 0, noteDraft: '', synthetic: !!offline,
    review: { decisions: {}, finalCategory: null, override: null, confirmed: null, editedSummary: null, notes: '', note: '', approval: null },
  };

  // 1) deterministic screening — raw text, instant, independent of any model
  let flags = screen(text, 'message');
  for (const r of reports) flags.push(...screen(r.rawText, 'report', r.id));
  c.suspicious = detectInjection(text);

  // 2) language model — only on masked text, only if verified available; otherwise a clearly labelled fallback
  const masker = new Masker();
  try {
    if (offline) throw new slm.SlmError('offline', 'Synthetic demo case — generated by rules only, no model was used');
    const ready = await modelReady();
    if (!ready.ok) throw new slm.SlmError('unavailable', ready.reason);
    const mMessage = masker.maskStrict(text).text;
    const mReports = reports.map((r) => ({ id: r.id, docType: r.docType, maskedText: masker.maskStrict(r.rawText || '').text }));
    c.privacy = { masked: true, verified: true, counts: masker.counts() };
    const corpus = { message: mMessage, reports: Object.fromEntries(mReports.map((r) => [r.id, r.maskedText])), answers: {} };
    const { json, model } = await slm.analyzeIntake({ message: mMessage, reports: mReports, inputMode: mode, uiLang });
    c.ai = { mode: 'model', model, intake: 'ok', final: 'pending', reason: '', errors: [] };
    c.summary = unmaskQuotes(N.normalizeSummary(json, corpus), masker);
    c.message.english = json.english_text ? masker.unmask(String(json.english_text).slice(0, 6000)) : null;
    c.message.language = { detected: String(json.language?.detected || '').slice(0, 60) || null, confidence: Number(json.language?.confidence) || null };
    c.message.translation = { confidence: Number(json.translation?.confidence) || null,
      uncertain: (json.translation?.uncertain_terms || []).slice(0, 8).map((t) => ({ original: String(t.original || '').slice(0, 80), note: String(t.note || '').slice(0, 160) })) };
    if (c.message.english && !/^english$/i.test(c.message.language.detected || 'English')) flags.push(...screen(c.message.english, 'message', null, { translated: true }));
    flags.push(...unmaskQuotes(N.normalizeFlags(json, corpus), masker));
    const sus = unmaskQuotes(N.normalizeSuspicious(json, corpus), masker);
    c.suspicious = [...c.suspicious, ...sus.filter((x) => !c.suspicious.some((y) => norm(y.quote) === norm(x.quote)))];
    c.aiPriority = N.normalizePriority(json);
    c.followUps = unmaskFollowUps(N.normalizeFollowUps(json), masker);
    if (!c.summary.missing.length) c.summary.missing = missingFrom(c.summary);
  } catch (e) {
    c.ai = { mode: 'fallback', model: null, intake: 'fallback', final: 'pending', reason: fbReason(e), errors: [`${e.code || 'error'}`] };
    if (e instanceof PiiError) c.privacy = { masked: false, verified: false, counts: {}, failed: e.residual };
    c.summary = extractSummary(text, reports);
    c.message.language = { detected: detectLanguage(text), confidence: null };
  }
  try { // always compute a masked preview (what a model would see) so staff can inspect masking quality
    const pv = masker.mask(text); c.privacy.preview = masker.verify(pv.text).ok ? pv.text : null;
    if (!c.privacy.masked) c.privacy.counts = masker.counts();
  } catch { c.privacy.preview = null; }
  c.vault = masker.exportVault();
  if (!c.followUps.length) c.followUps = fallbackFollowUps(c.summary, uiLang === 'hi');

  c.flags = dedupeFlags(flags.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]));
  c.completeness = completeness(c.summary);
  setPriority(c);
  c.noteDraft = buildNote(c);
  c.review.note = c.noteDraft;
  if (!c.followUps.length) { c.stage = 'ready_for_review'; c.ai.final = c.ai.mode === 'model' ? 'ok' : 'fallback'; }
  return c;
}

// ---- patient answers -> final summary --------------------------------------------------------
const RECAP = {
  en: (c) => `You told us: ${c.summary.chiefComplaint}. Your answers have been recorded exactly as you wrote them. A clinician will review everything.`,
  hi: (c) => `आपने बताया: ${c.summary.chiefComplaint}। आपके उत्तर जैसे आपने लिखे वैसे ही दर्ज किए गए हैं। एक चिकित्सक सब कुछ देखेंगे।`,
};

export async function submitAnswers({ c, answers, offline = false }) {
  const now = new Date().toISOString();
  c.answers = c.followUps.map((q) => {
    const a = answers.find((x) => x.qid === q.id) || {};
    const ans = String(a.answer ?? '').replace(/\u0000/g, '').trim().slice(0, 1000);
    return { qid: q.id, q: q.q, local: q.local, type: q.type, answer: ans, skipped: !!a.skipped || !ans, at: now };
  });
  const extra = [];
  for (const a of c.answers) if (!a.skipped && a.type === 'text') extra.push(...screen(a.answer, 'answer', a.qid)); // deterministic, raw
  for (const a of c.answers) c.suspicious.push(...detectInjection(a.answer, 'answer', a.qid));

  const masker = new Masker(c.vault);
  try {
    if (offline) throw new slm.SlmError('offline', 'Synthetic demo case — generated by rules only, no model was used');
    const ready = await modelReady();
    if (!ready.ok) throw new slm.SlmError('unavailable', ready.reason);
    const mMessage = masker.maskStrict(c.message.text).text;
    const mReports = c.reports.map((r) => ({ id: r.id, docType: r.docType, maskedText: masker.maskStrict(r.rawText || '').text }));
    const mAnswers = c.answers.map((a) => ({ ...a, maskedAnswer: a.skipped ? '' : masker.maskStrict(a.answer).text }));
    c.privacy = { ...c.privacy, masked: true, verified: true, counts: masker.counts() };
    const corpus = { message: mMessage, reports: Object.fromEntries(mReports.map((r) => [r.id, r.maskedText])), answers: Object.fromEntries(mAnswers.filter((a) => !a.skipped).map((a) => [a.qid, a.maskedAnswer])) };
    const { json, model } = await slm.finalizeSummary({ message: mMessage, reports: mReports, answers: mAnswers, inputMode: c.inputMode, uiLang: c.uiLang,
      previous: masker.maskStrict(JSON.stringify({ summary: slimSummary(c.summary), flags: c.flags.map((f) => f.label) })).text });
    c.ai = { ...c.ai, mode: 'model', model, final: 'ok', reason: '' };
    c.summary = unmaskQuotes(N.normalizeSummary(json, corpus), masker);
    if (!c.summary.missing.length) c.summary.missing = missingFrom(c.summary);
    c.narrative = String(json.narrative || '').slice(0, 800);
    c.clinicianQuestions = (json.clinician_questions || []).slice(0, 5).map((q) => String(q).slice(0, 250));
    const pr = json.patient_recap || {};
    c.patientRecap = { text: masker.unmask(String(pr.text || '').slice(0, 1500)), needsConfirmation: (pr.needs_confirmation || []).slice(0, 6).map((x) => masker.unmask(String(x).slice(0, 200))), source: 'model' };
    c.aiPriority = N.normalizePriority(json);
    extra.push(...unmaskQuotes(N.normalizeFlags(json, corpus), masker));
    for (const s of unmaskQuotes(N.normalizeSuspicious(json, corpus), masker)) if (!c.suspicious.some((y) => norm(y.quote) === norm(s.quote))) c.suspicious.push(s);
  } catch (e) {
    c.ai = { ...c.ai, mode: c.ai.mode === 'model' ? 'model' : 'fallback', final: 'fallback', reason: fbReason(e), errors: [...c.ai.errors, `final:${e.code || 'error'}`] };
    c.summary = mergeAnswers(c.summary, c.answers);
    c.patientRecap = { text: RECAP[c.uiLang](c), needsConfirmation: [], source: 'fallback' };
  }
  c.vault = masker.exportVault();
  c.flags = dedupeFlags([...c.flags, ...extra].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])); // flags are only ever added
  c.completeness = completeness(c.summary);
  setPriority(c);
  c.noteDraft = buildNote(c);
  if (!c.review.editedSummary) c.review.note = c.noteDraft;
  c.stage = 'ready_for_review';
  c.updatedAt = now;
  return c;
}

/** Recompute the priority suggestion (e.g. after the rules file changed). Never lowers an established deterministic floor. */
export function refreshPriority(c) { setPriority(c); return c; }

// ---- role projections ------------------------------------------------------------------------
export function forPatient(c) {
  return {
    id: c.id, createdAt: c.createdAt, stage: c.stage, uiLang: c.uiLang, inputMode: c.inputMode, consent: c.consent,
    language: c.message.language.detected, followUps: c.followUps, answers: c.answers, patientRecap: c.patientRecap,
    urgent: c.flags.filter((f) => f.level === 'urgent' || f.level === 'priority').map((f) => ({ label: f.label, advice: f.advice, level: f.level })),
    summary: c.stage === 'needs_answers' ? null : c.summary, ai: { mode: c.ai.mode, intake: c.ai.intake === 'ok' ? 'ok' : 'fallback', final: c.ai.final, reason: c.ai.reason },
    approved: c.stage === 'approved', message: { text: c.message.text }, reports: c.reports.map((r) => ({ id: r.id, fileName: r.fileName, docType: r.docType })),
  };
}
export function forStaff(c) { const { vault, ...rest } = c; return { ...rest, effectiveCategory: effectiveCategory(c), reviewed: isReviewed(c), waitedMs: waitedMs(c) }; } // the vault never leaves the server

export function listItem(c) {
  const cat = effectiveCategory(c), rv = c.review;
  return { id: c.id, createdAt: c.createdAt, updatedAt: c.updatedAt, stage: c.stage, category: cat, suggested: !rv.finalCategory && !rv.confirmed, suggestedCategory: c.priority.category,
    reason: c.priority.reasons[0]?.text || '', chief: c.summary.chiefComplaint, language: c.message.language.detected, inputMode: c.inputMode, completeness: c.completeness, flagCount: c.flags.length,
    snippet: c.message.text.slice(0, 140), synthetic: c.synthetic, mode: c.synthetic ? 'demo' : c.ai.mode, conflicts: c.summary.conflicts.length, answered: c.answers.length,
    reviewed: isReviewed(c), confirmedBy: rv.confirmed?.by || rv.override?.by || rv.approval?.by || null, overridden: !!rv.override, waitedMs: waitedMs(c),
    piiMasked: Object.values(c.privacy?.counts || {}).reduce((a, b) => a + b, 0) };
}
