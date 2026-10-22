import { api } from './api.js';
import { S, $, $$, esc, ago, fmt, fmtWait, toast, catTag, CAT, ticks, srcChip, finding, disclaimer, modeChip, humanChip } from './ui.js';
import { ACTS, INPUTS, leave, go, mount, shell, pageHead } from './core.js';

const RANK = { urgent: 0, priority: 1, clarification: 2, routine: 3 };
const STAGE = { needs_answers: 'Patient answering', ready_for_review: 'Awaiting review', in_review: 'In review', approved: 'Approved' };

// ================= queue =================
let QF = 'open', LIST = [];
const sortList = (a) => [...a].sort((x, y) => (x.stage === 'approved') - (y.stage === 'approved') || RANK[x.category] - RANK[y.category] || new Date(x.createdAt) - new Date(y.createdAt));

export async function viewQueue() {
  LIST = await api('GET', '/cases');
  drawQueue();
  const iv = setInterval(async () => { try { LIST = await api('GET', '/cases'); drawQueue(true); } catch { /* ignore */ } }, 15000);
  leave.fn = () => clearInterval(iv);
}

function drawQueue() {
  const open = LIST.filter((c) => c.stage !== 'approved');
  const fl = { open, urgent: open.filter((c) => c.category === 'urgent' || c.category === 'priority'), unreviewed: open.filter((c) => !c.reviewed),
    waiting: LIST.filter((c) => c.stage === 'needs_answers'), approved: LIST.filter((c) => c.stage === 'approved'), all: LIST }[QF];
  const rows = sortList(fl);
  const filters = [['open', 'Open'], ['urgent', 'Urgent & priority'], ['unreviewed', 'Unreviewed'], ['waiting', 'Patient answering'], ['approved', 'Approved'], ['all', 'All']];
  mount(shell(`${pageHead('Review queue', 'Sorted automatically: Urgent → Priority → Needs clarification → Routine, then longest waiting first. Priorities are <b>preliminary suggestions</b> until a clinician confirms them.')}
    <div class="figures"><div><b>${open.length}</b><span>Open cases</span></div><div class="u"><b>${open.filter((c) => c.category === 'urgent').length}</b><span>Urgent</span></div>
      <div><b>${open.filter((c) => !c.reviewed).length}</b><span>Unreviewed by a clinician</span></div><div><b>${LIST.filter((c) => c.stage === 'needs_answers').length}</b><span>Patient still answering</span></div></div>
    <div class="filters">${filters.map(([k, l]) => `<button data-act="qf" data-k="${k}" aria-pressed="${QF === k}">${l}</button>`).join('')}</div>
    ${rows.length ? `<div class="scroll-x panel" style="padding:0"><table><thead><tr><th>Priority</th><th>Waiting</th><th>Case</th><th>Presenting complaint &amp; reason</th><th class="hide-sm">Source</th><th class="hide-sm hide-md">Completeness</th><th>Flags</th><th>Stage</th></tr></thead><tbody>
      ${rows.map((c) => `<tr class="qrow ${c.category}${c.reviewed ? ' reviewed' : ''}" data-act="open-case" data-id="${c.id}" tabindex="0">
        <td>${catTag(c.category)}<br>${c.reviewed ? (c.overridden ? humanChip('Overridden · ' + c.confirmedBy) : humanChip('Confirmed · ' + (c.confirmedBy || ''))) : '<span class="chip unrev" title="No clinician has confirmed this priority yet">Unreviewed · suggested</span>'}</td>
        <td class="small mono nowrap" title="Submitted ${esc(fmt(c.createdAt))}">${fmtWait(c.waitedMs)}<br><span class="tiny faint">${esc(fmt(c.createdAt))}</span></td>
        <td class="mono">${c.id}${c.synthetic ? '<br><span class="tiny faint">synthetic</span>' : ''}</td>
        <td><b>${esc(c.chief)}</b><br><span class="small muted">${esc(c.reason)}</span>${c.overridden && c.suggestedCategory !== c.category ? `<br><span class="tiny faint">suggested: ${CAT[c.suggestedCategory]}</span>` : ''}</td>
        <td class="hide-sm small">${esc(c.language || '—')}<br><span class="faint">${c.inputMode}</span><br>${modeChip(c.mode)}${c.piiMasked ? `<br><span class="chip" title="Personal identifiers found and masked before any model use">🛡 ${c.piiMasked} masked</span>` : ''}</td>
        <td class="hide-sm hide-md">${ticks(c.completeness)}</td>
        <td>${c.flagCount ? `<b style="color:var(--urgent)">${c.flagCount}</b>` : '<span class="faint">0</span>'}${c.conflicts ? `<br><span class="tiny" style="color:var(--clar)">${c.conflicts} conflict${c.conflicts > 1 ? 's' : ''}</span>` : ''}</td>
        <td class="small">${STAGE[c.stage]}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No cases here.</div>'}`));
}
ACTS.qf = (el) => { QF = el.dataset.k; drawQueue(); };
ACTS['open-case'] = (el) => go(`#/review/${el.dataset.id}`);
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList?.contains('qrow')) ACTS['open-case'](e.target); });

// ================= review =================
let R = null; // { c, summary, notes, note, cat, reason }
const EV = {};

const summaryText = (s) => {
  const F = (x) => (x ? x.text : 'Not reported'), L = (a) => a.map((x) => x.text).join('; ') || 'Not reported';
  return [`Chief complaint: ${s.chiefComplaint}`, `Symptoms: ${s.symptoms.map((x) => x.text).join(', ') || 'None identified'}`, `Onset: ${F(s.onset)}`, `Progression: ${F(s.progression)}`,
    `Severity: ${F(s.severity)}`, `History: ${L(s.history)}`, `Medications: ${L(s.medications)}`, `Allergies: ${L(s.allergies)}`, `Reported negatives: ${s.denied.map((x) => x.text).join(', ') || 'None'}`].join('\n');
};

export async function viewReview(id) {
  let c = await api('GET', `/cases/${id}`);
  if (c.stage === 'ready_for_review' && S.me.role === 'clinician') c = await api('POST', `/cases/${id}/review`, { action: 'open' });
  R = { c, summary: c.review.editedSummary ?? summaryText(c.summary), notes: c.review.notes, note: c.review.note || c.noteDraft, cat: '', reason: '' };
  drawReview();
}

function flagBlock(c) {
  if (!c.flags.length) return '';
  const top = c.flags.some((f) => f.level === 'urgent');
  return `<section class="alert ${top ? '' : 'priority'}" role="alert"><h3>${top ? 'Possible urgent warning signs' : 'Warning signs reported'} · for clinician review</h3><ul>
    ${c.flags.map((f) => `<li><b>${esc(f.label)}</b> <span class="chip ${f.origin === 'ai' ? 'ai' : ''}" title="${f.origin === 'ai' ? 'Described by the language model — verify' : 'Deterministic rule — independent of any model'}">${f.origin === 'ai' ? 'model' : 'rule'}</span> ${srcChip(f.source, c)}<br><q>${esc(f.evidence)}</q>${f.why ? `<br><span class="small">${esc(f.why)}</span>` : ''}</li>`).join('')}</ul>
    <p class="adv">${esc(c.flags[0].advice)}</p></section>`;
}

function evidence(c) {
  const lang = c.message.language.detected, nonEn = c.message.english && !/^english$/i.test(lang || 'English');
  EV['ev-message'] = c.message.text; if (nonEn) EV['ev-english'] = c.message.english;
  const voice = c.message.voice, vf = c.files.find((f) => f.kind === 'audio');
  return `<section class="panel"><p class="label">Patient statement <span class="r">${lang ? esc(lang) : ''}${c.message.language.confidence ? ` · ${Math.round(c.message.language.confidence * 100)}%` : ''}</span></p>
      ${vf ? `<audio controls src="/api/cases/${c.id}/files/${vf.id}" style="width:100%;height:34px;margin-bottom:8px"></audio>` : ''}
      ${voice ? `<p class="small"><span class="chip ${voice.via === 'browser-stt' ? 'warn' : ''}">${voice.via === 'browser-stt' ? 'browser speech-to-text (processed by the browser vendor)' : 'local speech-to-text'}</span> ${voice.confidence != null ? `confidence ${Math.round(voice.confidence * 100)}%` : 'no confidence score available'}${voice.uncertain?.length ? ` · <span style="color:var(--clar)">${voice.uncertain.length} unclear phrase(s): ${voice.uncertain.map((u) => esc(u.text)).join(', ')}</span>` : ''}</p>` : ''}
      <div class="evidence quote" id="ev-message">${esc(c.message.text)}</div>
      ${nonEn ? `<p class="label" style="margin-top:14px">English translation <span class="r"><span class="chip ai">machine</span> ${c.message.translation.confidence ? Math.round(c.message.translation.confidence * 100) + '%' : ''}</span></p>
        <div class="evidence quote" id="ev-english">${esc(c.message.english)}</div>
        ${c.message.translation.uncertain.length ? `<p class="small" style="color:var(--clar)">Uncertain terms: ${c.message.translation.uncertain.map((u) => `<b>${esc(u.original)}</b> (${esc(u.note)})`).join('; ')}</p>` : ''}
        <p class="tiny faint">Verify against the original before relying on the translation.</p>` : ''}</section>
    ${c.reports.map((r) => { EV[`ev-report-${r.id}`] = r.rawText; const hasFile = c.files.some((f) => f.id === r.id);
      return `<section class="panel"><p class="label">Report <span class="r">${hasFile ? `<a href="/api/cases/${c.id}/files/${r.id}" target="_blank" rel="noopener">open original ↗</a>` : '<span class="faint">original not stored</span>'}</span></p>
      <p style="margin:0"><b>${esc(r.fileName)}</b> <span class="muted small">${esc(r.docType)}${r.date ? ' · ' + esc(r.date) : ''}${r.confidence != null ? ` · read confidence ${Math.round(r.confidence * 100)}%` : ''}</span></p>
      ${r.values.length ? `<table class="small" style="margin-top:8px"><thead><tr><th>Test</th><th>Value</th><th>Range</th><th>Pg</th></tr></thead><tbody>${r.values.map((v) => `<tr><td>${esc(v.name)}</td><td><b>${esc(v.value)}</b> ${esc(v.unit || '')} ${v.flag === 'high' || v.flag === 'low' ? `<span class="chip warn">${v.flag}</span>` : ''}${v.lowConfidence ? ' <span class="chip warn">low conf.</span>' : ''}</td><td class="muted">${esc(v.range || '—')}</td><td>${v.page}</td></tr>`).join('')}</tbody></table>` : ''}
      ${r.unreadable.length ? `<p class="notice small" style="margin-top:8px">Unreadable: ${esc(r.unreadable.join('; '))}</p>` : ''}
      <details style="margin-top:8px"><summary class="small">Full text as read by AI</summary><div class="evidence small quote" id="ev-report-${r.id}">${esc(r.rawText)}</div></details></section>`; }).join('')}
    ${c.answers.length ? `<section class="panel"><p class="label">Patient follow-up answers</p>${c.answers.map((a) => { EV[`ev-answer-${a.qid}`] = a.answer;
      return `<p class="small" style="margin:0 0 10px"><span class="muted">${esc(a.q)}</span><br>${a.skipped ? '<span class="faint">skipped</span>' : `<span class="evidence" id="ev-answer-${a.qid}">${esc(a.answer)}</span>`}</p>`; }).join('')}</section>` : (c.stage === 'needs_answers' ? '<div class="notice">The patient has not yet answered the follow-up questions.</div>' : '')}`;
}

function summaryPanel(c) {
  const s = c.summary, list = (a) => (a.length ? a.map((x) => finding(x, c)).join('') : '<span class="faint">Not reported</span>');
  return `<section class="panel"><p class="label">Structured summary <span class="r">${modeChip(c.synthetic ? 'demo' : c.ai.mode, c.ai.model)} ${ticks(c.completeness)} ${c.completeness}%</span></p>
      ${c.narrative ? `<p style="font:400 16px/1.6 var(--serif);margin:0 0 14px">${esc(c.narrative)}</p>` : ''}
      <dl class="kv"><dt>Chief complaint</dt><dd><b>${esc(s.chiefComplaint)}</b></dd><dt>Symptoms</dt><dd>${list(s.symptoms)}</dd>${s.denied.length ? `<dt>Denies</dt><dd>${list(s.denied)}</dd>` : ''}
      <dt>Onset</dt><dd>${finding(s.onset, c)}</dd><dt>Progression</dt><dd>${finding(s.progression, c)}</dd><dt>Severity</dt><dd>${finding(s.severity, c)}</dd>
      <dt>History</dt><dd>${list(s.history)}</dd><dt>Medications</dt><dd>${list(s.medications)}</dd><dt>Allergies</dt><dd>${list(s.allergies)}</dd>
      ${s.reportFindings.length ? `<dt>From reports</dt><dd>${s.reportFindings.map((f) => `<span class="fnd">${esc(f.text)} ${srcChip(f.source, c)}</span>`).join('')}</dd>` : ''}
      ${s.timeline.length ? `<dt>Timeline</dt><dd>${s.timeline.map((x) => `<div><b>${esc(x.when)}</b> — ${esc(x.event)} ${srcChip(x.source, c)}</div>`).join('')}</dd>` : ''}</dl></section>
    ${s.conflicts.length ? `<section class="panel" style="border-color:var(--clar)"><p class="label">Conflicting information</p>${s.conflicts.map((x) => `<div style="margin-bottom:10px"><b>${esc(x.description)}</b><br>${x.a ? `<span class="fnd">A: ${esc(x.a.text)} ${srcChip(x.a.source, c)}</span>` : ''}${x.b ? `<span class="fnd">B: ${esc(x.b.text)} ${srcChip(x.b.source, c)}</span>` : ''}</div>`).join('')}<p class="tiny faint">Both versions are kept. Nothing was silently corrected.</p></section>` : ''}
    <section class="panel"><p class="label">Missing & uncertain</p>
      ${s.missing.length ? `<p class="small" style="margin:0 0 8px"><b>Missing:</b> ${s.missing.map((m) => `<span class="chip" title="${esc(m.why)}">${esc(m.field)}</span>`).join(' ')}</p>` : '<p class="small muted">Nothing flagged as missing.</p>'}
      ${s.uncertain.length ? `<p class="small" style="margin:0"><b>Uncertain:</b> ${s.uncertain.map((u) => `<span class="chip warn" title="${esc(u.reason)}">${esc(u.item)}</span>`).join(' ')}</p>` : ''}
      ${c.suspicious.length ? `<div class="notice" style="margin-top:10px"><b>Embedded instruction ignored.</b> ${c.suspicious.map((x) => `<q>${esc(x.quote)}</q> ${srcChip(x.source, c)}`).join(' ')}<br><span class="small">The case was escalated to at least “needs clarification”. Patient text can never change triage rules.</span></div>` : ''}</section>
    ${c.clinicianQuestions?.length ? `<section class="panel"><p class="label">Suggested questions to ask <span class="r">${modeChip('model')}</span></p><ul class="small" style="margin:0;padding-left:18px">${c.clinicianQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></section>` : ''}`;
}

function whyPanel(c) {
  const p = c.priority;
  return `<section class="panel"><p class="label">Why this priority <span class="r"><span class="chip">preliminary suggestion</span></span></p>
    <p style="margin:0 0 8px">${catTag(p.category)} <span class="small muted">Rules v${esc(p.ruleVersion)} · computed ${esc(fmt(p.computedAt))}</span></p>
    <ol class="small" style="margin:0 0 8px;padding-left:20px">${p.reasons.map((r) => `<li style="margin-bottom:6px">${esc(r.text)} <span class="chip ${r.origin === 'model' ? 'ai' : ''}">${r.origin === 'rule' ? 'deterministic rule' : r.origin === 'model' ? 'model-suggested' : 'rule-based check'}</span> ${r.evidence.map((e) => srcChip(e, c)).join(' ')}</li>`).join('')}</ol>
    <p class="tiny faint" style="margin:0">Not a diagnosis and not a validated clinical risk score. Deterministic warning-sign rules set a floor that the model cannot lower. Missing or conflicting information never produces “Routine”.</p></section>`;
}

function privacyPanel(c) {
  const pv = c.privacy || {}, counts = Object.entries(pv.counts || {});
  return `<section class="panel"><p class="label">Privacy masking <span class="r">${pv.masked ? '<span class="chip ai">masked before model</span>' : '<span class="chip">no text sent to a model</span>'}</span></p>
    <p class="small" style="margin:0 0 6px">${counts.length ? counts.map(([k, v]) => `<span class="chip">${esc(k.toLowerCase())} ×${v}</span>`).join(' ') : '<span class="muted">No personal identifiers detected.</span>'}
      ${pv.verified ? '<span class="chip">verified</span>' : pv.failed ? '<span class="chip warn">verification failed → model skipped</span>' : ''}</p>
    ${pv.preview ? `<details><summary class="small">What a model would see (masked)</summary><div class="evidence small quote">${esc(pv.preview)}</div></details>` : ''}
    <p class="tiny faint" style="margin:8px 0 0">Heuristic masking — can miss unusual names or free-form addresses. The original statement above is shown unmasked to authorised staff only.</p></section>`;
}

function decisionPanel(c) {
  const rv = c.review, approved = c.stage === 'approved', clin = S.me.role === 'clinician', locked = approved || !clin;
  const cur = rv.finalCategory || c.priority.category;
  const suggestions = [...c.flags.map((f, i) => ({ key: `flag:${f.ruleId}:${i}`, label: `Warning: ${f.label}` })), ...(c.ai.mode === 'model' ? c.summary.symptoms.map((s) => ({ key: `sym:${s.text}`, label: `Symptom: ${s.text}` })) : [])];
  const state = rv.override ? `${humanChip('Overridden')} <span class="small">${CAT[rv.override.from]} → <b>${CAT[rv.override.to]}</b> by ${esc(rv.override.by)} · ${esc(fmt(rv.override.at))}<br>Reason: ${esc(rv.override.reason)}</span>`
    : rv.confirmed ? `${humanChip('Clinician-confirmed')} <span class="small">${CAT[rv.confirmed.category]} · ${esc(rv.confirmed.by)} · ${esc(fmt(rv.confirmed.at))}</span>`
    : '<span class="chip unrev">Unreviewed — suggestion only</span>';
  return `<section class="panel"><p class="label">Priority decision</p>
      <p style="margin:0 0 8px">${state}</p>
      <p class="small muted" style="margin:0 0 4px">Current: ${catTag(cur)}${rv.finalCategory ? ` <span class="faint">(suggestion was ${CAT[c.priority.category]})</span>` : ''}</p>
      ${!clin ? '<p class="notice small">Administrators have read-only access. Sign in as a clinician to review.</p>' : ''}
      ${!rv.confirmed && !rv.override && clin && !approved ? `<button class="btn sm" data-act="confirm">✓ Confirm “${CAT[cur]}”</button>` : ''}
      <p class="small" style="margin:12px 0 2px"><b>Change priority</b> (reason required, recorded in the audit log)</p>
      <div class="catpick">${Object.keys(CAT).map((k) => `<button data-act="pick-cat" data-k="${k}" ${locked ? 'disabled' : ''} aria-pressed="${(R.cat || cur) === k}">${catTag(k)}</button>`).join('')}</div>
      ${R.cat && R.cat !== cur ? `<label class="field"><span>Reason for override (required)</span><input type="text" data-in="reason" value="${esc(R.reason)}" placeholder="e.g. Called patient, symptoms resolved"></label><button class="btn sm" id="ovBtn" data-act="override" ${R.reason.trim() ? '' : 'disabled'}>Save override</button>` : ''}</section>
    ${suggestions.length ? `<section class="panel"><p class="label">Accept or reject suggestions</p>${suggestions.slice(0, 12).map((s) => { const d = rv.decisions[s.key];
      return `<div class="sugg ${d || ''}"><span class="t">${esc(s.label)}</span><span class="row" style="gap:4px"><button class="btn sm ${d === 'accepted' ? '' : 'ghost'}" data-act="decide" data-k="${esc(s.key)}" data-l="${esc(s.label)}" data-v="accepted" ${locked ? 'disabled' : ''} aria-label="Accept">✓</button>
      <button class="btn sm ${d === 'rejected' ? 'danger' : 'ghost'}" data-act="decide" data-k="${esc(s.key)}" data-l="${esc(s.label)}" data-v="rejected" ${locked ? 'disabled' : ''} aria-label="Reject">✕</button></span></div>`; }).join('')}<p class="tiny faint" style="margin:8px 0 0">Rejecting a suggestion records your judgement; it never deletes a deterministic warning-sign flag.</p></section>` : ''}
    <section class="panel"><p class="label">Summary (editable) <span class="r">${rv.editedSummary ? humanChip('human-edited') : modeChip(c.synthetic ? 'demo' : c.ai.mode, c.ai.model)}</span></p>
      <textarea class="noteta" style="min-height:190px" data-in="summary" ${locked ? 'disabled' : ''}>${esc(R.summary)}</textarea></section>
    <section class="panel"><p class="label">Clinician notes <span class="r">${humanChip('human')}</span></p><textarea rows="3" data-in="notes" ${locked ? 'disabled' : ''} placeholder="Your own observations…">${esc(R.notes)}</textarea></section>
    <section class="panel"><p class="label">Referral / triage note <span class="r">${approved ? humanChip('approved') : '<span class="chip warn">draft — not approved</span>'}</span></p>
      <textarea class="noteta" data-in="note" ${locked ? 'disabled' : ''}>${esc(R.note)}</textarea>
      <div class="row" style="margin-top:12px"><button class="btn ghost sm" data-act="save" ${locked ? 'disabled' : ''}>Save edits</button><button class="btn ghost sm" data-act="regen" ${locked ? 'disabled' : ''}>Regenerate draft</button>
        <button class="btn" data-act="approve" ${locked ? 'disabled' : ''}>✓ Approve final note</button></div>
      ${approved && rv.approval ? `<p class="small" style="color:var(--human)">Approved by ${esc(rv.approval.by)} · ${fmt(rv.approval.at)}</p>` : ''}
      <div style="margin-top:12px">${disclaimer()}</div></section>`;
}

function drawReview() {
  const c = R.c;
  const keep = window.scrollY;
  const prov = c.synthetic ? 'demo' : c.ai.mode;
  mount(shell(`${pageHead(`Case <span class="mono">${c.id}</span>`, `Submitted ${fmt(c.createdAt)} · waiting ${fmtWait(c.waitedMs)} · ${c.inputMode} intake · ${STAGE[c.stage]}`,
      `${modeChip(prov, c.ai.model)} ${catTag(c.effectiveCategory)} <a class="btn ghost sm" href="#/queue">← Queue</a>`)}
    ${flagBlock(c)}
    ${c.ai.mode !== 'model' && !c.synthetic ? `<div class="notice"><b>Rule-based fallback — no language model was used.</b> ${esc(c.ai.reason || '')} Warning-sign screening still ran. Read the original statement directly.</div>` : ''}
    ${c.synthetic ? '<div class="notice"><b>Synthetic demo case.</b> Invented text, generated through the rules engine — no model and no real patient.</div>' : ''}
    <div class="grid3"><div class="stack"><p class="label" style="margin:0 0 -6px">Source evidence</p>${evidence(c)}</div>
      <div class="stack"><p class="label" style="margin:0 0 -6px">Priority &amp; summary</p>${whyPanel(c)}${summaryPanel(c)}${privacyPanel(c)}</div>
      <div class="stack"><p class="label" style="margin:0 0 -6px">Decision</p>${decisionPanel(c)}</div></div>`));
  window.scrollTo(0, keep);
}

const mark = (raw, q) => { const i = q ? raw.toLowerCase().indexOf(q.toLowerCase()) : -1; return i < 0 ? null : `${esc(raw.slice(0, i))}<mark>${esc(raw.slice(i, i + q.length))}</mark>${esc(raw.slice(i + q.length))}`; };
ACTS['focus-src'] = (el) => {
  const { kind, ref, quote } = el.dataset;
  const ids = [kind === 'report' ? `ev-report-${ref}` : kind === 'answer' ? `ev-answer-${ref}` : 'ev-message', 'ev-english'];
  $$('.evidence').forEach((n) => { if (EV[n.id] !== undefined) n.innerHTML = esc(EV[n.id]); });
  let target = null;
  for (const id of ids) { const raw = EV[id], m = raw && mark(raw, quote); if (m) { $(`#${id}`).innerHTML = m; target = $(`#${id}`); break; } }
  target ||= $(`#${ids[0]}`);
  if (!target) return toast('Evidence not available for this tag.', true);
  target.closest('details')?.setAttribute('open', '');
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
  if (!mark(EV[target.id] || '', quote)) toast('Exact wording not found in the original — treat this AI citation as unverified.', true);
};

INPUTS.summary = (el) => { R.summary = el.value; }; INPUTS.notes = (el) => { R.notes = el.value; }; INPUTS.note = (el) => { R.note = el.value; };
INPUTS.reason = (el) => { R.reason = el.value; const b = $('#ovBtn'); if (b) b.disabled = !el.value.trim(); };
ACTS['pick-cat'] = (el) => { R.cat = el.dataset.k; drawReview(); };

async function act(body, ok) {
  try { R.c = await api('POST', `/cases/${R.c.id}/review`, body); if (ok) toast(ok); drawReview(); } catch (e) { toast(e.message, true); }
}
ACTS.decide = (el) => { const cur = R.c.review.decisions[el.dataset.k]; return act({ action: 'decide', key: el.dataset.k, label: el.dataset.l, value: cur === el.dataset.v ? null : el.dataset.v }); };
ACTS.confirm = () => act({ action: 'confirm' }, 'Priority confirmed and recorded in the audit log');
ACTS.override = async () => { await act({ action: 'override', to: R.cat, reason: R.reason }, 'Priority updated'); R.cat = ''; R.reason = ''; drawReview(); };
ACTS.save = () => act({ action: 'save', summary: R.summary, notes: R.notes, note: R.note }, 'Edits saved');
ACTS.regen = async () => { await act({ action: 'regenerate' }); R.note = R.c.review.note; drawReview(); toast('Draft regenerated'); };
ACTS.approve = async () => {
  if (!confirm('Approve this final note? The case will be locked.')) return;
  await act({ action: 'save', summary: R.summary, notes: R.notes, note: R.note });
  await act({ action: 'approve', note: R.note, notes: R.notes }, 'Final note approved and recorded in the audit log.');
  R.note = R.c.review.note; drawReview();
};

// ================= audit =================
export async function viewAudit() {
  const [rows, ver] = await Promise.all([api('GET', '/audit'), api('GET', '/audit/verify')]);
  let q = '';
  const table = () => rows.filter((a) => `${a.action} ${a.actor} ${a.caseId || ''} ${a.detail}`.toLowerCase().includes(q.toLowerCase()));
  const body = () => table().map((a) => `<tr><td class="small mono" style="white-space:nowrap">${fmt(a.at)}</td><td>${esc(a.actor)}</td><td class="small" style="text-transform:capitalize">${a.role}</td><td><b>${esc(a.action)}</b></td><td class="mono small">${a.caseId || '—'}</td><td class="small muted">${esc(a.detail)}</td><td class="tiny mono faint">${a.hash.slice(0, 8)}</td></tr>`).join('');
  mount(shell(`${pageHead('Audit log', 'Every action by people and by the AI. Entries hold IDs and actions only — never patient text.',
    `<span class="chip ${ver.ok ? 'ai' : 'warn'}" id="vchip">${ver.ok ? `✓ hash chain verified · ${ver.total} entries` : `✕ chain broken at entry ${ver.brokenAt}`}</span><button class="btn ghost sm" data-act="reverify">Re-verify</button>`)}
    <input type="text" id="aq" data-in="aq" placeholder="Filter by action, actor or case ID…" style="max-width:420px;margin-bottom:14px">
    <div class="panel scroll-x" style="padding:0"><table><thead><tr><th>Time</th><th>Actor</th><th>Role</th><th>Action</th><th>Case</th><th>Detail</th><th>Hash</th></tr></thead><tbody id="abody">${body()}</tbody></table></div>`));
  INPUTS.aq = (el) => { q = el.value; $('#abody').innerHTML = body(); };
}
ACTS.reverify = async () => { const v = await api('GET', '/audit/verify'); toast(v.ok ? `Chain intact (${v.total} entries).` : `Chain BROKEN at entry ${v.brokenAt}.`, !v.ok); };

// ================= system (admin) =================
export async function viewSystem() {
  const [h, pr] = await Promise.all([api('GET', '/health?fresh=1'), api('GET', '/priority-rules')]);
  const m = h.slm;
  mount(shell(`${pageHead('System', 'What is actually running, what is private, and the rules in force.', '<button class="btn ghost sm" data-act="recheck">Re-check now</button>')}
    <div class="grid2"><section class="panel"><p class="label">Language model (Ollama)</p>
      <p>${m.verifiedLocal ? `<span class="chip ai">✓ Verified on this machine</span>` : m.reachable && m.modelPresent ? '<span class="chip warn">Reachable, but not on this machine</span>' : '<span class="chip warn">Not active — rule-based fallback in use</span>'}</p>
      <dl class="kv"><dt>Model</dt><dd class="mono">${esc(m.model)}</dd><dt>Endpoint</dt><dd class="mono">${esc(m.endpoint)} <span class="faint">(${m.endpointKind})</span></dd><dt>Reachable</dt><dd>${m.reachable ? 'yes' : 'no'}</dd><dt>Model installed</dt><dd>${m.modelPresent ? 'yes' : 'no'}</dd>${m.installed?.length ? `<dt>Installed</dt><dd class="small mono">${m.installed.map(esc).join(', ')}</dd>` : ''}</dl>
      <p class="small muted">${esc(m.reason)}</p>
      <p class="tiny faint">“Local” is only claimed when the endpoint is a loopback address and the model is confirmed installed.</p></section>
    <section class="panel"><p class="label">What needs the model — and what does not</p>
      <ul class="small"><li><b>Works without the model:</b> consent, text intake, warning-sign rules, rule-based summary &amp; follow-up questions, text-PDF report reading, priority scoring &amp; sorting, clinician review, audit log, masking.</li>
      <li><b>Needs the model:</b> language-model summary, English translation, tailored follow-up questions, patient recap in their language, reading report <i>photos</i>.</li>
      <li><b>Needs a local Whisper-style service:</b> voice transcription — <span class="chip ${h.stt.configured ? 'ai' : 'warn'}">${h.stt.configured ? `configured · ${esc(h.stt.endpoint)}` : 'not configured'}</span></li></ul></section></div>
    <div class="grid2" style="margin-top:22px"><section class="panel"><p class="label">Privacy design</p>
      <ul class="small"><li>Personal identifiers are masked before <b>any</b> text reaches a model; the placeholder map stays on the server and is never put in prompts, logs or API responses.</li>
      <li>If masking cannot be verified, nothing is sent to a model and the patient continues with the rule-based workflow.</li>
      <li>Raw audio and report images go only to loopback services${h.privacy.remoteRawAllowed ? ' — <b>remote raw upload is ENABLED (PRIVACY_ALLOW_REMOTE_RAW=1)</b>' : ' (remote raw upload is off)'}.</li>
      <li>Detectors: built-in validators (Aadhaar checksum, Luhn), context patterns, name cues &amp; list${h.privacy.ner ? ' + <b>compromise</b> NER' : ' (optional <span class="mono">compromise</span> NER not installed)'}.</li></ul>
      <p class="label" style="margin-top:14px">Known limitations</p><ul class="small">${h.privacy.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>
    <section class="panel"><p class="label">Priority rules · v${esc(pr.version)}</p><p class="small">${esc(pr.statement)}</p>
      <dl class="kv"><dt>Order</dt><dd>${pr.order.map((k) => catTag(k)).join(' → ')}</dd><dt>Completeness threshold</dt><dd>${pr.completenessThreshold}% <span class="faint small">(product setting)</span></dd><dt>Critical fields</dt><dd>${pr.criticalFields.join(', ')}</dd>
      <dt>Model may</dt><dd class="small">${esc(pr.slm.note)} Urgent escalation needs a verified quote; otherwise capped at <b>${pr.slm.unverifiedEscalationCap}</b>.</dd></dl>
      <p class="tiny faint">Edit <span class="mono">config/priority-rules.json</span> and restart. Wording of reasons is configurable there too.</p>
      <p class="label" style="margin-top:14px">Demo data</p><p class="small muted">Restores the synthetic cases and clears everything else, including the audit log.</p><button class="btn danger sm" data-act="reset">Reset demo data</button></section></div>
    <section class="panel" style="margin-top:22px"><p class="label">Warning-sign rules <span class="r">illustrative · not clinically validated · can escalate, never lower · independent of the model</span></p>
      <div class="grid2">${S.rules.map((r) => `<div style="border-bottom:1px solid var(--rule2);padding:6px 0"><b class="small">${esc(r.label)}</b> <span class="cat ${r.level}">${r.level}</span><br><span class="tiny mono faint" style="word-break:break-all">${r.patterns.map((p) => esc(p.s)).join('  |  ')}</span></div>`).join('')}</div></section>`));
}
ACTS.recheck = () => viewSystem();
ACTS.reset = async () => { if (!confirm('Reset all data to the synthetic demo cases?')) return; await api('POST', '/admin/reset-demo', {}); toast('Demo data reset.'); go('#/queue'); };
