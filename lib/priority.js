// Preliminary triage-priority suggestion. EXTENDS lib/safety.js (deterministic rules) — it does not replace them.
//
//  * Deterministic warning-sign flags set a FLOOR. Neither the language model nor missing data can lower it.
//  * The model may only escalate, and an "urgent" escalation needs a quote that was verified against the original text.
//  * Missing / conflicting / unclear information never yields Routine.
//  * A clinician may override with a reason (see server.js); the override is stored separately and audited.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './env.js';
import { LEVEL_RANK, maxLevel } from './safety.js';

let RULES;
export function getRules() {
  if (RULES) return RULES;
  const file = process.env.PRIORITY_RULES_FILE || path.join(ROOT, 'config', 'priority-rules.json');
  RULES = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(RULES.order) || RULES.order.some((l) => !(l in LEVEL_RANK))) throw new Error('priority-rules.json: invalid "order"');
  return RULES;
}
export const resetRules = () => { RULES = undefined; };

const fill = (tpl, vars = {}) => tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const cap = (level, ceiling) => (LEVEL_RANK[level] < LEVEL_RANK[ceiling] ? ceiling : level);

export function computePriority(c, { previous } = {}) {
  const R = getRules(), why = [];
  const add = (level, code, vars, evidence, origin) => why.push({ level, code, text: fill(R.reasons[code], vars), evidence: (evidence || []).filter(Boolean), origin });
  let floor = 'routine';

  // 1. deterministic rules — the floor
  for (const f of c.flags.filter((x) => x.origin === 'rule')) {
    add(f.level, f.level === 'urgent' ? 'rule_urgent' : 'rule_priority', { label: f.label }, [f.source], 'rule');
    floor = maxLevel(floor, f.level);
  }
  // 2. language model: escalation only, with caps
  let model = 'routine';
  for (const f of c.flags.filter((x) => x.origin === 'ai')) {
    const verified = !!f.source?.verified;
    const level = verified || !R.slm.requireVerifiedQuoteForUrgent ? f.level : cap(f.level, R.slm.unverifiedEscalationCap);
    add(level, verified ? 'model_flag' : 'model_flag_unverified', { label: f.label }, [f.source], 'model'); model = maxLevel(model, level);
  }
  const ap = c.aiPriority;
  if (ap && c.ai?.mode === 'model' && (ap.level === 'urgent' || ap.level === 'priority') && !c.flags.some((f) => f.origin === 'ai')) {
    const level = cap(ap.level, R.slm.modelOnlyUrgencyCap);
    add(level, 'model_priority', { rationale: ap.rationale || 'no rationale given' }, [], 'model'); model = maxLevel(model, level);
  }
  // 3. clarification floor — uncertainty never means Routine
  const s = c.summary; let clar = false;
  const crit = R.criticalFields.filter((k) => (k === 'symptoms' ? !s.symptoms.length : !s[k]));
  if (s.conflicts.length) { add('clarification', 'conflict', {}, s.conflicts.flatMap((x) => [x.a?.source, x.b?.source]), 'rule-based'); clar = true; }
  if (s.uncertain.length || c.message?.voice?.uncertain?.length) { add('clarification', 'uncertain', {}, [], 'rule-based'); clar = true; }
  if (c.suspicious.length) { add('clarification', 'suspicious', {}, c.suspicious.map((x) => x.source), 'rule-based'); clar = true; }
  if (crit.length) { add('clarification', 'critical_missing', { fields: crit.join(', ') }, [], 'rule-based'); clar = true; }
  else if (c.completeness < R.completenessThreshold) { add('clarification', 'incomplete', { completeness: c.completeness, threshold: R.completenessThreshold }, [], 'rule-based'); clar = true; }
  if (c.ai?.mode !== 'model' && !R.fallbackCanBeRoutine) { add('clarification', 'no_ai', {}, [], 'rule-based'); clar = true; }

  let category = maxLevel(floor, model, clar ? 'clarification' : 'routine');
  if (previous?.floor) category = maxLevel(category, previous.floor); // never drop below a previously established deterministic floor
  floor = maxLevel(floor, previous?.floor || 'routine');
  if (category === 'routine') add('routine', 'routine', {}, [], 'rule-based');
  why.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  return { category, reasons: why, floor, basis: 'preliminary suggestion — not a diagnosis, not a validated risk score', ruleVersion: R.version, computedAt: new Date().toISOString() };
}

// ---- queue ordering (single source of truth; the dashboard uses the same rule) ----
export const effectiveCategory = (c) => c.review?.finalCategory || c.priority?.category || c.category;
export const isReviewed = (c) => !!(c.review?.confirmed || c.review?.override || c.review?.approval);
export function sortQueue(cases) {
  return [...cases].sort((a, b) =>
    (a.stage === 'approved') - (b.stage === 'approved')
    || LEVEL_RANK[effectiveCategory(a)] - LEVEL_RANK[effectiveCategory(b)]
    || new Date(a.createdAt) - new Date(b.createdAt));        // longest waiting first
}
export function waitedMs(c, now = Date.now()) {
  const end = c.review?.approval?.at ? new Date(c.review.approval.at).getTime() : now;
  return Math.max(0, end - new Date(c.createdAt).getTime());
}
