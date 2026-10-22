// Normalisers for model output: never trust it. Coerce types, clamp values and verify every quote against the real source text.
// (Kept from the original implementation — provider-independent, used by the local SLM adapter and tests.)
import { EMERGENCY_ADVICE, quoteFound } from './safety.js';

export const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
export const str = (v, n = 500) => (v == null ? '' : String(v)).trim().slice(0, n);
export const conf = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; };

export function mkSource(raw, quote, corpus, page) {
  const s = str(raw, 80);
  let kind = 'message', ref = null;
  const m = s.match(/^(report|answer)\s*[:#]?\s*(.+)$/i);
  if (m) { kind = m[1].toLowerCase(); ref = m[2].trim(); }
  const pool = [['message', null, corpus.message], ...Object.entries(corpus.reports || {}).map(([k, v]) => ['report', k, v]),
    ...Object.entries(corpus.answers || {}).map(([k, v]) => ['answer', k, v])];
  const own = pool.find(([k, r]) => k === kind && (r || null) === (ref || null));
  const q = str(quote, 300);
  let verified = !!(q && own && quoteFound(q, own[2]));
  if (!verified && q) { // re-attribute if the quote really lives elsewhere
    const alt = pool.find(([, , t]) => quoteFound(q, t));
    if (alt) { kind = alt[0]; ref = alt[1]; verified = true; }
  }
  return { kind, ref, quote: q, verified, page: Number(page) || null };
}

const finding = (f, corpus) => {
  if (!f) return null;
  const text = str(typeof f === 'string' ? f : f.text || f.name, 300);
  if (!text) return null;
  return { text, detail: str(f.detail, 300), source: mkSource(f.source, f.quote, corpus), confidence: conf(f.confidence) };
};
const findings = (a, corpus, cap = 25) => arr(a).slice(0, cap).map((f) => finding(f, corpus)).filter(Boolean);

export function normalizeSummary(j, corpus) {
  return {
    chiefComplaint: str(j.chief_complaint, 200) || 'Insufficient information',
    symptoms: findings(j.symptoms, corpus), denied: findings(j.denied_symptoms, corpus),
    onset: finding(j.onset, corpus), progression: finding(j.progression, corpus), severity: finding(j.severity, corpus),
    history: findings(j.history, corpus), medications: findings(j.medications, corpus), allergies: findings(j.allergies, corpus),
    timeline: arr(j.timeline).slice(0, 20).map((t) => ({ when: str(t.when, 80), event: str(t.event, 200), source: mkSource(t.source, t.quote, corpus) })).filter((t) => t.event),
    reportFindings: arr(j.report_findings).slice(0, 30).map((f) => ({ text: str(f.text, 250), source: mkSource(f.source, f.quote, corpus, f.page) })).filter((f) => f.text),
    missing: arr(j.missing).slice(0, 15).map((m) => ({ field: str(m.field ?? m, 120), why: str(m.why_it_matters, 200) })).filter((m) => m.field),
    conflicts: arr(j.conflicts).slice(0, 10).map((c) => ({
      description: str(c.description ?? c, 400),
      a: c.a ? { text: str(c.a.text, 200), source: mkSource(c.a.source, c.a.quote, corpus) } : null,
      b: c.b ? { text: str(c.b.text, 200), source: mkSource(c.b.source, c.b.quote, corpus) } : null,
    })).filter((c) => c.description),
    uncertain: arr(j.uncertain).slice(0, 15).map((u) => ({ item: str(u.item ?? u, 200), reason: str(u.reason, 200) })).filter((u) => u.item),
  };
}

export function normalizeFlags(j, corpus) {
  return arr(j.red_flags).slice(0, 10).map((f) => {
    const source = mkSource(f.source, f.quote, corpus);
    return { ruleId: 'ai', level: f.urgency === 'priority' ? 'priority' : 'urgent', label: str(f.label, 120), evidence: source.quote, why: str(f.why, 300),
      source, advice: EMERGENCY_ADVICE, origin: 'ai' };
  }).filter((f) => f.label);
}

export const normalizeSuspicious = (j, corpus) =>
  arr(j.suspicious_instructions).slice(0, 5).map((s) => ({ quote: str(s.quote, 300), note: str(s.note, 200) || 'Possible instruction embedded in patient-supplied text; not followed.',
    source: mkSource('message', s.quote, corpus), origin: 'ai' })).filter((s) => s.quote);

export function normalizePriority(j) {
  const l = j.ai_priority?.level;
  return { level: ['urgent', 'priority', 'clarification', 'routine'].includes(l) ? l : 'clarification', rationale: str(j.ai_priority?.rationale, 400), confidence: conf(j.ai_priority?.confidence) };
}

export function normalizeFollowUps(j) {
  return arr(j.follow_up_questions).slice(0, 6).map((q, i) => ({
    id: `q${i + 1}`, q: str(q.question, 300), local: str(q.question_local, 300) || str(q.question, 300), reason: str(q.reason, 250),
    type: ['text', 'yes_no', 'scale_0_10', 'choice'].includes(q.answer_type) ? q.answer_type : 'text',
    options: arr(q.options).map((o) => str(o, 60)).filter(Boolean).slice(0, 5), priority: Number(q.priority) || i + 1,
  })).filter((q) => q.q);
}

/** Normalise a report-photo extraction returned by the vision model. */
export function normalizeReportExtraction(json) {
  return {
    mode: 'model', isMedical: json.is_medical_document !== false, docType: str(json.doc_type, 80) || 'Document',
    date: /^\d{4}-\d{2}-\d{2}$/.test(json.report_date || '') ? json.report_date : null, rawText: str(json.raw_text, 20000),
    values: arr(json.values).slice(0, 60).map((v) => ({
      name: str(v.name, 80), value: str(v.value, 40), unit: str(v.unit, 20) || null, range: str(v.reference_range, 50) || null,
      flag: ['high', 'low', 'normal'].includes(v.flag) ? v.flag : 'unknown', page: Number(v.page) || 1,
      confidence: conf(v.confidence), lowConfidence: (conf(v.confidence) ?? 1) < 0.7, quote: str(v.quote, 200),
    })).filter((v) => v.name && v.value),
    unreadable: arr(json.unreadable).map((u) => `${str(u?.where ?? u, 100)}${u?.reason ? ` — ${str(u.reason, 100)}` : ''}`),
    confidence: conf(json.overall_confidence),
  };
}
