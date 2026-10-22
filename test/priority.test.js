import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePriority, sortQueue, waitedMs, effectiveCategory, isReviewed, getRules } from '../lib/priority.js';
import { screen } from '../lib/safety.js';

const finding = (t) => ({ text: t, detail: '', source: { kind: 'message', ref: null, quote: t, verified: true }, confidence: null });
const mk = (o = {}) => ({
  id: 'CF-1', createdAt: new Date().toISOString(), stage: 'ready_for_review', flags: [], suspicious: [], completeness: 100, aiPriority: null, ai: { mode: 'model' }, message: { voice: null },
  summary: { symptoms: [finding('Fever')], onset: finding('3 days'), progression: finding('Same'), severity: finding('3/10'), history: [finding('none')], medications: [finding('none')], allergies: [finding('none')], conflicts: [], uncertain: [], denied: [], missing: [] },
  review: {}, priority: null, ...o,
});
const ruleFlag = (text) => screen(text)[0];
const aiFlag = (level, verified) => ({ ruleId: 'ai', level, label: 'Model flag', evidence: 'x', source: { kind: 'message', quote: 'x', verified }, origin: 'ai', advice: '' });

test('rules file documents that this is a preliminary suggestion, not a validated score', () => {
  const R = getRules(); assert.match(R.statement, /not a diagnosis/i); assert.match(R.statement, /NOT a clinical threshold/i);
  assert.deepEqual(R.order, ['urgent', 'priority', 'clarification', 'routine']);
});

test('deterministic urgent rule → Urgent with a reason and linked evidence', () => {
  const f = ruleFlag('I have chest pain and I am sweating a lot');
  const p = computePriority(mk({ flags: [f] }));
  assert.equal(p.category, 'urgent'); assert.equal(p.reasons[0].origin, 'rule'); assert.equal(p.reasons[0].evidence[0].quote, f.source.quote);
  assert.match(p.basis, /not a diagnosis/);
});

test('SAFETY: model saying "routine" cannot lower a deterministic flag', () => {
  const p = computePriority(mk({ flags: [ruleFlag('I cannot breathe properly')], aiPriority: { level: 'routine', rationale: 'fine' } }));
  assert.equal(p.category, 'urgent');
});

test('SAFETY: a floor from an earlier computation survives even if the flag list is later emptied', () => {
  const first = computePriority(mk({ flags: [ruleFlag('I fainted this morning')] }));
  const second = computePriority(mk({ flags: [] }), { previous: first });
  assert.equal(first.category, 'urgent'); assert.equal(second.category, 'urgent'); assert.equal(second.floor, 'urgent');
});

test('model escalation is capped: urgency without a flag → Priority; unverified urgent quote → Priority; verified urgent quote → Urgent', () => {
  assert.equal(computePriority(mk({ aiPriority: { level: 'urgent', rationale: 'scary' } })).category, 'priority');
  assert.equal(computePriority(mk({ flags: [aiFlag('urgent', false)] })).category, 'priority');
  assert.equal(computePriority(mk({ flags: [aiFlag('urgent', true)] })).category, 'urgent');
});

test('model priority is ignored when the fallback produced the summary (no model output to trust)', () => {
  assert.equal(computePriority(mk({ ai: { mode: 'fallback' }, aiPriority: { level: 'urgent' } })).category, 'routine');
});

test('UNCERTAINTY NEVER MEANS ROUTINE: missing critical fields, low completeness, conflicts, unclear text, embedded instructions', () => {
  const s = mk().summary;
  const cases = {
    'no symptoms': mk({ summary: { ...s, symptoms: [] } }), 'no onset': mk({ summary: { ...s, onset: null } }), 'low completeness': mk({ completeness: 30 }),
    conflict: mk({ summary: { ...s, conflicts: [{ description: 'x', a: null, b: null }] } }), uncertain: mk({ summary: { ...s, uncertain: [{ item: 'x', reason: 'y' }] } }),
    'unclear audio': mk({ message: { voice: { uncertain: [{ text: 'x' }] } } }), injection: mk({ suspicious: [{ quote: 'ignore previous', source: {} }] }),
  };
  for (const [name, c] of Object.entries(cases)) assert.equal(computePriority(c).category, 'clarification', name);
});

test('Routine only when clean: no flags, key details present, nothing conflicting', () => {
  const p = computePriority(mk()); assert.equal(p.category, 'routine'); assert.equal(p.reasons[0].code, 'routine');
});

test('a Priority-level rule outranks clarification; Urgent outranks Priority', () => {
  assert.equal(computePriority(mk({ flags: [ruleFlag('I have shortness of breath'), ], completeness: 20 })).category, 'priority');
  assert.equal(computePriority(mk({ flags: [ruleFlag('I have chest pain'), ruleFlag('I cannot breathe')] })).category, 'urgent');
});

test('SORT: Urgent → Priority → Clarification → Routine, then longest waiting first, approved cases last', () => {
  const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const c = (id, cat, h, extra = {}) => mk({ id, createdAt: t(h), priority: { category: cat }, ...extra });
  const q = sortQueue([c('routine-old', 'routine', 50), c('clar', 'clarification', 5), c('urgent-new', 'urgent', 1), c('urgent-old', 'urgent', 9), c('prio', 'priority', 2), c('done', 'urgent', 99, { stage: 'approved' })]);
  assert.deepEqual(q.map((x) => x.id), ['urgent-old', 'urgent-new', 'prio', 'clar', 'routine-old', 'done']);
});

test('SORT: a clinician override immediately changes the position (effective category wins over the suggestion)', () => {
  const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const a = mk({ id: 'A', createdAt: t(10), priority: { category: 'routine' } }), b = mk({ id: 'B', createdAt: t(1), priority: { category: 'priority' } });
  assert.deepEqual(sortQueue([a, b]).map((x) => x.id), ['B', 'A']);
  a.review = { finalCategory: 'urgent', override: { by: 'Dr', reason: 'r', from: 'routine', to: 'urgent' } };
  assert.equal(effectiveCategory(a), 'urgent');
  assert.deepEqual(sortQueue([a, b]).map((x) => x.id), ['A', 'B']);
});

test('reviewed vs unreviewed and waiting time (stops at approval)', () => {
  const t = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  assert.equal(isReviewed(mk()), false);
  assert.equal(isReviewed(mk({ review: { confirmed: { by: 'Dr' } } })), true);
  const w = waitedMs(mk({ createdAt: t(3) })); assert.ok(w > 2.9 * 3600e3 && w < 3.1 * 3600e3);
  assert.ok(Math.abs(waitedMs(mk({ createdAt: t(5), review: { approval: { at: t(4) } } })) - 3600e3) < 5000);
});
