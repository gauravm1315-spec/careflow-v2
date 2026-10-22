import { api } from './api.js';
import { S, $, esc, t, ago, fmt, liveScreen, disclaimer, toast, modeChip } from './ui.js';
import { ACTS, INPUTS, CHANGES, leave, go, mount, shell, pageHead } from './core.js';
import { Recorder, toWav16k, toB64, MAX_SECONDS } from './audio.js';

const LANGS = ['Auto-detect', 'English', 'Hindi', 'Hinglish', 'Bengali', 'Marathi', 'Tamil', 'Telugu', 'Gujarati', 'Kannada', 'Malayalam', 'Punjabi'];
const fresh = () => ({ consent: false, agree: false, text: '', lang: 'Auto-detect', audio: null, reports: [], busy: '', browserStt: false, voiceMode: '' });
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const BCP = { English: 'en-IN', Hindi: 'hi-IN', Hinglish: 'hi-IN', Bengali: 'bn-IN', Marathi: 'mr-IN', Tamil: 'ta-IN', Telugu: 'te-IN', Gujarati: 'gu-IN', Kannada: 'kn-IN', Malayalam: 'ml-IN', Punjabi: 'pa-IN', 'Auto-detect': 'en-IN' };
let I = fresh();
let REC = null; // { r: Recorder, t: interval, s: seconds }

// ================= intake =================
export function viewIntake() {
  leave.fn = () => { if (REC) { clearInterval(REC.t); REC.sr?.stop?.(); REC.r?.stream?.getTracks().forEach((x) => x.stop()); REC = null; } };
  draw();
}

function alertBlock(flags, title) {
  if (!flags.length) return '';
  const urgent = flags.some((f) => f.level === 'urgent');
  return `<section class="alert ${urgent ? '' : 'priority'}" role="alert"><h3>${esc(title)}</h3>
    <ul>${flags.map((f) => `<li><b>${esc(f.label)}</b>${f.evidence ? ` — <q>${esc(f.evidence)}</q>` : ''}</li>`).join('')}</ul>
    <p class="adv">${S.lang === 'hi' ? 'अगर लक्षण गंभीर हैं तो अभी 112 / 108 पर कॉल करें — इस फ़ॉर्म का इंतज़ार न करें।' : 'If symptoms are severe, call 112 / 108 now — do not wait for this form.'}</p></section>`;
}

function draw() {
  if (!I.consent) {
    return mount(shell(`<div class="narrow">${pageHead(t('consentT'), t('consentSub'))}
      <ul class="checklist"><li>${t('c1')}</li><li>${t('c2')}</li><li>${t('c3')}</li><li>${t('c4')}</li></ul>
      <label class="consent"><input type="checkbox" data-in="agree" ${I.agree ? 'checked' : ''}><span>${t('agree')}</span></label>
      <button class="btn lg" id="goBtn" data-act="consent-go" ${I.agree ? '' : 'disabled'}>${t('cont')} →</button></div>`));
  }
  const rec = !!REC;
  const a = I.audio;
  const localStt = !!S.health?.stt?.configured;
  mount(shell(`<div class="narrow">${pageHead(t('introT'), t('introSub'))}
    <div id="live"></div>
    <section class="panel">
      <div class="row between" style="margin-bottom:8px"><p class="label" style="margin:0;flex:1">${t('typeL')}</p>
        <label class="small row" style="gap:6px">${t('langL')}<select data-ch="lang" style="width:auto">${LANGS.map((l) => `<option ${l === I.lang ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <textarea id="txt" data-in="txt" rows="8" placeholder="${esc(t('typePh'))}" ${I.busy ? 'disabled' : ''}>${esc(I.text)}</textarea>
      <div class="recbar" style="margin-top:12px">
        <button class="btn ${rec ? 'danger' : 'ghost'}" data-act="rec-toggle" ${I.busy === 'tx' || (!rec && !localStt && !I.browserStt) ? 'disabled' : ''}>${rec ? `■ ${t('stop')}` : `● ${t('speak')}`}</button>
        ${rec ? `<span class="row" style="gap:8px"><span class="rec"></span><span class="mono" id="rectime">00:00</span></span>` : ''}
        ${I.busy === 'tx' ? `<span class="small"><span class="spin"></span> Transcribing on this machine…</span>` : ''}
        ${localStt ? `<label class="btn link small" style="cursor:pointer">${t('upAudio')}<input class="sr" type="file" accept="audio/*" data-ch="audio-file"></label>` : ''}
      </div>
      ${!localStt ? `<p class="small muted" style="margin:8px 0 0">${S.lang === 'hi' ? 'इस सर्वर पर लोकल स्पीच-टू-टेक्स्ट सेट नहीं है।' : 'Local speech-to-text is not set up on this server, so voice is off by default. You can type, or opt in below.'}</p>` : ''}
      ${SR ? `<label class="small row" style="gap:8px;margin-top:8px;align-items:flex-start"><input type="checkbox" data-in="bstt" ${I.browserStt ? 'checked' : ''} ${rec ? 'disabled' : ''} style="margin-top:3px">
        <span><b>Use my browser’s speech-to-text (optional).</b> <span class="muted">Your browser vendor (for example Google in Chrome) processes the audio on its own servers — it is <u>not</u> private and not masked. Leave off if unsure.</span></span></label>` : ''}
      ${a ? `<div style="margin-top:12px"><p class="small"><b>${t('transcriptCheck')}</b></p>
        <div class="row small" style="margin:6px 0"><audio controls src="${a.url}" style="height:34px;max-width:100%"></audio>
        <span class="chip">Local transcript · please check</span><span class="chip">${esc(a.language || '')}${a.confidence != null ? ` · ${Math.round(a.confidence * 100)}%` : ''}</span></div>
        ${a.uncertain?.length ? `<p class="notice small">Unclear audio: ${a.uncertain.map((u) => `<b>${esc(u.text)}</b>${u.reason ? ` (${esc(u.reason)})` : ''}`).join(', ')}. Please correct them in the box above if you can.</p>` : ''}</div>` : ''}
    </section>
    <section class="panel" style="margin-top:18px"><p class="label">${t('repT')}</p>
      <label class="drop"><input class="sr" type="file" accept="application/pdf,image/*" data-ch="report-file" ${I.busy ? 'disabled' : ''}>
        ${I.busy === 'rp' ? '<span class="spin"></span> Reading the report on this machine…' : `＋ ${t('repUp')}<br><span class="tiny faint">PDF · JPG · PNG — max 12 MB</span>`}</label>
      ${I.reports.map((r, i) => reportCard(r, i)).join('')}
    </section>
    <div class="row" style="margin-top:22px"><button class="btn lg" data-act="submit" ${I.busy ? 'disabled' : ''}>${t('submit')} →</button></div>
    <div style="margin-top:18px">${disclaimer()}</div></div>`));
  updateLive();
}

function reportCard(r, i) {
  const low = r.values.filter((v) => v.lowConfidence).length;
  return `<div style="border:1px solid var(--rule);margin-top:12px;padding:12px;background:#fffdf8">
    <div class="row between"><b>${esc(r.fileName)}</b><span>${r.mode === 'model' ? '<span class="chip ai">Read by local model</span>' : r.mode === 'rule-based' ? '<span class="chip">Read by keyword rules</span>' : '<span class="chip warn">Not machine-read</span>'} <button class="btn link small" data-act="rm-report" data-i="${i}">remove</button></span></div>
    <p class="small muted" style="margin:2px 0 8px">${esc(r.docType)}${r.date ? ' · ' + esc(r.date) : ''}${r.confidence != null ? ` · reading confidence ${Math.round(r.confidence * 100)}%` : ''}</p>
    ${!r.isMedical ? '<p class="notice small">This does not look like a medical document. Remove it if it was attached by mistake.</p>' : ''}
    ${r.values.length ? `<table class="small"><thead><tr><th>Test</th><th>Value</th><th>Range</th></tr></thead><tbody>${r.values.slice(0, 8).map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.value)} ${esc(v.unit || '')}${v.lowConfidence ? ' <span class="chip warn">unsure</span>' : ''}</td><td class="muted">${esc(v.range || '—')}</td></tr>`).join('')}</tbody></table>${r.values.length > 8 ? `<p class="tiny faint">+ ${r.values.length - 8} more values</p>` : ''}` : '<p class="small faint">No values extracted.</p>'}
    ${r.unreadable.length || low ? `<p class="notice small" style="margin-top:8px">Some parts were hard to read (${esc(r.unreadable.join('; ') || low + ' value(s) low confidence')}). A clinician will check the original.</p>` : ''}</div>`;
}

function updateLive() {
  const el = $('#live'); if (!el) return;
  el.innerHTML = alertBlock(liveScreen(I.text), t('urgentT'));
}
INPUTS.txt = (el) => { I.text = el.value; updateLive(); };
INPUTS.agree = (el) => { I.agree = el.checked; $('#goBtn').disabled = !I.agree; };
INPUTS.bstt = (el) => { I.browserStt = el.checked; draw(); };
CHANGES.lang = (el) => { I.lang = el.value; };
ACTS['consent-go'] = () => { I.consent = true; draw(); };
ACTS['rm-report'] = (el) => { I.reports.splice(Number(el.dataset.i), 1); draw(); };

async function sendAudio(blob, mime) {
  I.busy = 'tx'; draw();
  try {
    const res = await api('POST', '/transcribe', { mime, data: await toB64(blob), lang: I.lang });
    I.audio = { ...res, url: URL.createObjectURL(blob) };
    I.text = (I.text.trim() ? I.text.trim() + '\n' : '') + res.text;
  } catch (e) { toast(e.message, true); }
  I.busy = ''; draw();
}

function startBrowserStt() {
  const r = new SR(); r.lang = BCP[I.lang] || 'en-IN'; r.continuous = true; r.interimResults = false;
  r.onresult = (e) => { let add = ''; for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) add += e.results[i][0].transcript + ' '; if (add) { I.text = (I.text.trim() ? I.text.trim() + ' ' : '') + add.trim(); I.voiceMode = 'browser-stt'; const ta = $('#txt'); if (ta) ta.value = I.text; updateLive(); } };
  r.onerror = () => toast('Browser speech recognition stopped. You can type instead.', true);
  r.onend = () => { if (REC?.sr) { clearInterval(REC.t); REC = null; draw(); } };
  r.start();
  REC = { sr: r, s: 0, r: { stream: null }, t: setInterval(() => { REC.s++; const el = $('#rectime'); if (el) el.textContent = `${String(Math.floor(REC.s / 60)).padStart(2, '0')}:${String(REC.s % 60).padStart(2, '0')}`; if (REC.s >= MAX_SECONDS) ACTS['rec-toggle'](); }, 1000) };
  draw();
}
ACTS['rec-toggle'] = async () => {
  if (REC?.sr) { const r = REC.sr; clearInterval(REC.t); REC = null; r.stop(); draw(); return undefined; }
  if (!REC && I.browserStt && SR && !S.health?.stt?.configured) { startBrowserStt(); return undefined; }
  if (REC) {
    clearInterval(REC.t);
    const r = REC.r; REC = null;
    const { blob, seconds } = await r.stop();
    draw();
    if (seconds < 1) return toast('Recording too short.', true);
    try { const w = await toWav16k(blob); await sendAudio(w.blob, 'audio/wav'); } catch { await sendAudio(blob, blob.type.split(';')[0] || 'audio/webm'); }
    return undefined;
  }
  try {
    const r = new Recorder(); await r.start();
    REC = { r, s: 0, t: setInterval(() => {
      REC.s++; const el = $('#rectime'); if (el) el.textContent = `${String(Math.floor(REC.s / 60)).padStart(2, '0')}:${String(REC.s % 60).padStart(2, '0')}`;
      if (REC.s >= MAX_SECONDS) ACTS['rec-toggle']();
    }, 1000) };
    draw();
  } catch { toast('Microphone unavailable or permission denied. You can type instead.', true); }
  return undefined;
};

CHANGES['audio-file'] = async (el) => {
  const f = el.files[0]; if (!f) return;
  try { const w = await toWav16k(f); if (w.seconds > MAX_SECONDS) return toast('Audio is longer than 3 minutes.', true); await sendAudio(w.blob, 'audio/wav'); }
  catch { if (f.size > 9e6) return toast('Could not read this audio file.', true); await sendAudio(f, f.type || 'audio/mpeg'); }
  return undefined;
};

CHANGES['report-file'] = async (el) => {
  const f = el.files[0]; if (!f) return;
  if (f.size > 12e6) return toast('File must be under 12 MB.', true);
  if (I.reports.length >= 5) return toast('Up to 5 reports per case.', true);
  I.busy = 'rp'; draw();
  try { I.reports.push(await api('POST', '/extract-report', { mime: f.type, fileName: f.name, data: await toB64(f) })); }
  catch (e) { toast(e.message, true); }
  I.busy = ''; draw();
  return undefined;
};

// processing overlay: honest generic steps while the server works
function overlay(title, steps) {
  mount(shell(`<div class="narrow">${pageHead(title)}<section class="panel"><ul class="proc" id="proc" style="list-style:none;padding:0;margin:0">${steps.map((s, i) => `<li data-i="${i}">${esc(s)}</li>`).join('')}</ul>
    <p class="small faint" style="margin-top:12px">This can take 10–30 seconds.</p></section></div>`));
  let i = 0;
  const tick = () => { document.querySelectorAll('#proc li').forEach((li, k) => { li.className = k < i ? 'ok' : k === i ? 'on' : ''; li.textContent = (k < i ? '✓ ' : k === i ? '… ' : '') + steps[k]; }); };
  tick();
  const iv = setInterval(() => { if (i < steps.length - 1) { i++; tick(); } }, 4500);
  return () => clearInterval(iv);
}

ACTS.submit = async () => {
  if (!I.text.trim() && !I.reports.length) return toast('Please describe your symptoms or attach a report first.', true);
  const stop = overlay('Preparing your questions', ['Screening for warning signs', 'Masking personal identifiers', 'Organising what you told us', 'Choosing the questions a clinician needs answered']);
  try {
    const c = await api('POST', '/cases', { consent: true, text: I.text, uiLang: S.lang, audioToken: I.audio?.token, voiceMode: I.voiceMode || undefined, reportTokens: I.reports.map((r) => r.token) });
    stop(); I = fresh(); Q = null; go(`#/case/${c.id}`);
  } catch (e) { stop(); toast(e.message, true); draw(); }
};

// ================= my cases =================
export async function viewCases() {
  const list = await api('GET', '/cases');
  const lbl = { needs_answers: 'Questions waiting', ready_for_review: 'With care team', in_review: 'Being reviewed', approved: 'Reviewed' };
  mount(shell(`${pageHead(t('mycases'))}${list.length ? `<div class="panel"><table><thead><tr><th>Case</th><th>Submitted</th><th>Status</th><th></th></tr></thead><tbody>${list.map((c) => `<tr><td class="mono">${c.id}</td><td>${fmt(c.createdAt)}</td><td>${lbl[c.stage]}</td><td><a href="#/case/${c.id}">Open →</a></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty">${t('emptyCases')}<br><a href="#/intake">${t('intake')} →</a></div>`}`));
}

// ================= one case: questions -> final summary =================
let Q = null; // { id, i, ans: { qid: { answer, skipped } } }
let CASE = null;

export async function viewCase(id) {
  CASE = await api('GET', `/cases/${id}`);
  if (!Q || Q.id !== id) Q = { id, i: 0, ans: {} };
  drawCase();
}

const stepBar = (c) => {
  const st = c.stage; const idx = st === 'needs_answers' ? 1 : st === 'approved' ? 3 : 2;
  return `<div class="steps">${[t('stepSent'), t('stepQ'), t('stepSum'), t('stepRev')].map((s, i) => `<div class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${i < idx ? '✓ ' : ''}${s}</div>`).join('')}</div>`;
};

function drawCase() {
  const c = CASE;
  const head = pageHead(`Case <span class="mono">${c.id}</span>`, `${fmt(c.createdAt)}${c.language ? ' · ' + esc(c.language) : ''}`);
  const urgent = alertBlock(c.urgent, t('urgentT'));
  const aiNote = c.ai.mode !== 'model' ? `<div class="notice">${S.lang === 'hi' ? 'इस केस में भाषा मॉडल इस्तेमाल नहीं हुआ; सरल कीवर्ड नियमों से सारांश बना है और चिकित्सक सीधे आपका संदेश पढ़ेंगे। आप नीचे के सरल प्रश्नों के उत्तर दे सकते हैं।' : 'A language model was not used for this case. A simple keyword-based summary was prepared and a clinician will read your message directly. You can still answer the basic questions below.'}</div>` : '';
  if (c.stage === 'needs_answers') {
    return mount(shell(`<div class="narrow">${head}${stepBar(c)}${urgent}${aiNote}<div id="qwrap">${qCard()}</div></div>`));
  }
  mount(shell(`<div class="narrow">${head}${stepBar(c)}${urgent}${finalView(c)}</div>`));
}

function qCard() {
  const qs = CASE.followUps, n = qs.length, q = qs[Q.i], a = Q.ans[q.id] || {};
  const showEn = q.local && q.local !== q.q;
  let input = '';
  if (q.type === 'yes_no') {
    const v = (a.answer || '').split(' — ')[0];
    input = `<div class="opts">${[['Yes', t('yes')], ['No', t('no')], ['Not sure', t('unsure')]].map(([k, l]) => `<button data-act="q-pick" data-v="${k}" aria-pressed="${v === k}">${l}</button>`).join('')}</div>
      <input type="text" data-in="q-note" placeholder="${S.lang === 'hi' ? 'कुछ और बताना हो तो लिखें (वैकल्पिक)' : 'Add details (optional)'}" value="${esc((a.answer || '').split(' — ')[1] || '')}">`;
  } else if (q.type === 'choice') {
    input = `<div class="opts">${q.options.map((o) => `<button data-act="q-pick" data-v="${esc(o)}" aria-pressed="${a.answer === o}">${esc(o)}</button>`).join('')}</div>`;
  } else if (q.type === 'scale_0_10') {
    const v = a.answer !== undefined && !a.skipped ? a.answer : '5';
    input = `<div class="scalev" id="sv">${esc(v)}</div><input type="range" min="0" max="10" value="${esc(v)}" data-in="q-scale" aria-label="0 to 10"><div class="row between tiny faint"><span>0</span><span>10</span></div>`;
  } else {
    input = `<textarea rows="4" data-in="q-text" placeholder="${esc(t('ansPh'))}">${esc(a.answer || '')}</textarea>`;
  }
  const last = Q.i === n - 1;
  return `<div class="qdots">${qs.map((_, i) => `<i class="${i < Q.i ? 'done' : i === Q.i ? 'now' : ''}"></i>`).join('')}</div>
    <div class="qcard"><p class="stat-line">${t('qOf', Q.i + 1, n)}</p>
      <h2>${esc(q.local || q.q)}</h2>${showEn ? `<p class="small faint" style="margin:0 0 8px">${esc(q.q)}</p>` : ''}
      <p class="small muted"><b>${t('whyAsk')}:</b> ${esc(q.reason)}</p>${input}
      <div class="row between" style="margin-top:18px"><div class="row"><button class="btn ghost" data-act="q-back" ${Q.i === 0 ? 'disabled' : ''}>← ${t('back')}</button>
        <button class="btn link small" data-act="q-skip">${t('skip')}</button></div>
        <button class="btn" data-act="${last ? 'q-finish' : 'q-next'}" id="qnext" ${a.answer || a.skipped ? '' : 'disabled'}>${last ? t('finish') : t('next') + ' →'}</button></div></div>
    <p style="margin-top:14px"><button class="btn link small" data-act="q-finish-all">${S.lang === 'hi' ? 'बिना जवाब दिए भेज दें' : 'Send without answering'}</button></p>`;
}

const cur = () => CASE.followUps[Q.i];
const setAns = (v) => { Q.ans[cur().id] = { answer: v, skipped: false }; const b = $('#qnext'); if (b) b.disabled = !String(v).trim(); };
INPUTS['q-text'] = (el) => setAns(el.value);
INPUTS['q-scale'] = (el) => { $('#sv').textContent = el.value; setAns(el.value); };
INPUTS['q-note'] = (el) => { const base = (Q.ans[cur().id]?.answer || '').split(' — ')[0]; if (base) Q.ans[cur().id] = { answer: el.value.trim() ? `${base} — ${el.value.trim()}` : base, skipped: false }; };
ACTS['q-pick'] = (el) => { const note = $('[data-in="q-note"]')?.value.trim(); setAns(note ? `${el.dataset.v} — ${note}` : el.dataset.v); $('#qwrap').innerHTML = qCard(); };
ACTS['q-back'] = () => { Q.i = Math.max(0, Q.i - 1); $('#qwrap').innerHTML = qCard(); };
ACTS['q-next'] = () => { Q.i++; $('#qwrap').innerHTML = qCard(); };
ACTS['q-skip'] = () => { Q.ans[cur().id] = { answer: '', skipped: true }; if (Q.i === CASE.followUps.length - 1) return ACTS['q-finish'](); Q.i++; $('#qwrap').innerHTML = qCard(); return undefined; };
ACTS['q-finish-all'] = () => { if (confirm(S.lang === 'hi' ? 'क्या आप बिना जवाब दिए भेजना चाहते हैं?' : 'Send without answering the questions?')) { Q.ans = {}; ACTS['q-finish'](); } };
ACTS['q-finish'] = async () => {
  const answers = CASE.followUps.map((q) => ({ qid: q.id, answer: Q.ans[q.id]?.answer || '', skipped: !!Q.ans[q.id]?.skipped || !Q.ans[q.id]?.answer }));
  const stop = overlay('Preparing your summary', ['Saving your answers', 'Combining everything you told us', 'Re-checking for warning signs', 'Writing the summary for the care team']);
  try { CASE = await api('POST', `/cases/${CASE.id}/answers`, { answers }); stop(); Q = null; drawCase(); }
  catch (e) { stop(); toast(e.message, true); drawCase(); }
};

function finalView(c) {
  const s = c.summary || {}, f = (x) => (x ? esc(x.text) : '<span class="faint">Not reported</span>'), l = (a) => (a?.length ? a.map((x) => esc(x.text)).join('; ') : '<span class="faint">Not reported</span>');
  const answered = c.answers.filter((a) => !a.skipped);
  return `<section class="panel"><p class="label">${t('recapT')}</p>
      ${c.patientRecap?.text ? `<p class="recap">${esc(c.patientRecap.text)}</p>` : `<p class="muted">${esc(s.chiefComplaint || '')}</p>`}
      ${c.patientRecap?.needsConfirmation?.length ? `<ul class="small">${c.patientRecap.needsConfirmation.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </section>
    <section class="panel" style="margin-top:18px"><p class="label">Summary <span class="r">${modeChip(c.ai.final === 'ok' ? 'model' : 'fallback')}</span></p>
      <dl class="kv"><dt>Main problem</dt><dd>${esc(s.chiefComplaint || '')}</dd><dt>Symptoms</dt><dd>${l(s.symptoms)}</dd><dt>Started</dt><dd>${f(s.onset)}</dd><dt>Trend</dt><dd>${f(s.progression)}</dd>
      <dt>Severity</dt><dd>${f(s.severity)}</dd><dt>Conditions</dt><dd>${l(s.history)}</dd><dt>Medicines</dt><dd>${l(s.medications)}</dd><dt>Allergies</dt><dd>${l(s.allergies)}</dd></dl>
      ${answered.length ? `<p class="label" style="margin-top:18px">Your answers</p>${answered.map((a) => `<p class="small" style="margin:4px 0"><span class="muted">${esc(a.local || a.q)}</span><br><b>${esc(a.answer)}</b></p>`).join('')}` : ''}
    </section>
    <div class="notice" style="margin-top:18px;background:${c.approved ? 'var(--routine-bg)' : 'var(--paper2)'};border-color:${c.approved ? 'var(--routine)' : 'var(--rule)'}">${c.approved ? t('approvedMsg') : t('waiting')}</div>
    <section class="panel" style="margin-top:18px"><p class="label">${t('privacy')}</p><p class="small muted">Consent given ${fmt(c.consent.at)}.</p>
      <button class="btn danger sm" data-act="withdraw">${t('withdraw')}</button></section>
    <div style="margin-top:18px">${disclaimer()}</div>`;
}
ACTS.withdraw = async () => {
  if (!confirm('Delete this case, your recordings, reports and summaries? An entry that the deletion happened is kept in the audit log.')) return;
  try { await api('POST', `/cases/${CASE.id}/withdraw`, {}); toast('Consent withdrawn and data deleted.'); go('#/cases'); } catch (e) { toast(e.message, true); }
};
