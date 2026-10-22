// Shared UI helpers, state and (small) i18n.
export const S = { me: null, rules: [], health: null, lang: localStorage.getItem('cf_lang') || 'en' };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 1) return 'just now'; if (m < 60) return `${m} min`; const h = Math.round(m / 60); return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
export const fmt = (iso) => new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

let tt;
export function toast(msg, err = false) {
  const el = $('#toast'); el.textContent = msg; el.className = 'toast' + (err ? ' err' : ''); el.hidden = false;
  clearTimeout(tt); tt = setTimeout(() => (el.hidden = true), err ? 6000 : 3000);
}

export const CAT = { urgent: 'Urgent', priority: 'Priority', clarification: 'Needs clarification', routine: 'Routine' };
export const catTag = (c, suggested) => `<span class="cat ${c}">${CAT[c]}${suggested === true ? ' <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:400">· suggested</span>' : ''}</span>`;
export const ticks = (pct) => `<span class="ticks" title="${pct}% of key fields present">${Array.from({ length: 7 }, (_, i) => `<i class="${i < Math.round(pct / 100 * 7) ? 'on' : ''}"></i>`).join('')}</span>`;

export function srcChip(s, c) {
  if (!s) return '';
  const lbl = s.kind === 'report' ? `rpt${s.page ? ' p' + s.page : ''}` : s.kind === 'answer' ? `ans ${String(s.ref || '').replace('q', '')}` : (c?.message?.voice ? 'voice' : 'msg');
  const cls = `src${s.verified ? '' : ' unv'}${s.translated ? ' tr' : ''}`;
  const tip = s.verified ? `Source: “${s.quote}”` : `Quote could not be matched exactly to the original — check evidence: “${s.quote}”`;
  return `<button type="button" class="${cls}" data-act="focus-src" data-kind="${esc(s.kind)}" data-ref="${esc(s.ref || '')}" data-quote="${esc(s.quote)}" title="${esc(tip)}">${lbl}${s.verified ? '' : ' ?'}</button>`;
}
export const finding = (f, c) => (f ? `<span class="fnd">${esc(f.text)}${f.detail ? ` <span class="faint">(${esc(f.detail)})</span>` : ''} ${srcChip(f.source, c)}</span>` : '<span class="faint">Not reported</span>');

export const DISCLAIMER = 'Decision-support content only. Not a diagnosis. The priority is a preliminary suggestion, not a validated risk score. Requires review by a qualified healthcare professional.';
// provenance labels: who produced this content?
export const MODE = { model: ['Local model draft', 'ai'], fallback: ['Rule-based fallback', 'warn'], demo: ['Synthetic demo · rule-based', ''] };
export const modeChip = (mode, model) => { const [l, cls] = MODE[mode] || MODE.fallback; return `<span class="chip ${cls}" title="${mode === 'model' ? 'Produced by a small language model; every quote re-checked against the original text' : mode === 'demo' ? 'Invented demo case, built by the rules engine — no model was used' : 'Keyword rules only — no language model was used'}">${l}${mode === 'model' && model ? ` · ${esc(model)}` : ''}</span>`; };
export const humanChip = (txt = 'Clinician-confirmed') => `<span class="chip human">${esc(txt)}</span>`;
export function fmtWait(ms) {
  const m = Math.floor(ms / 60000); if (m < 1) return '< 1 min'; if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')} min`; return `${Math.floor(h / 24)} d ${h % 24} h`;
}
export const disclaimer = () => `<p class="disclaimer">${DISCLAIMER}</p>`;

// ---- tiny i18n (patient-facing strings; staff UI stays English) ----
const D = {
  en: { intake: 'Describe symptoms', mycases: 'My cases', signout: 'Sign out',
    consentT: 'Before we begin', consentSub: 'We need your explicit consent before any information is processed.',
    c1: 'Your words and reports are used to prepare a structured summary for a healthcare professional. If a small language model is running on this hospital computer it may help; names, phone numbers and similar identifiers are masked before it sees your text. If it is not available, simple keyword rules are used instead.',
    c2: 'The software does not diagnose. A qualified clinician reviews every case and makes the final decision.',
    c3: 'Warning signs may be flagged for faster review. If you feel very unwell, call 112 / 108 now — do not wait for this form.',
    c4: 'You can withdraw consent and delete everything at any time from your case page.',
    agree: 'I understand and give my consent.', cont: 'Continue',
    introT: 'Tell us what is wrong', introSub: 'Speak, type, or attach a report. You can use any language, including Hindi–English mixed.',
    langL: 'Language', typeL: 'Describe your symptoms', typePh: 'What are you feeling, since when, is it getting better or worse, any medicines, allergies or conditions…',
    speak: 'Speak instead', rec: 'Record', stop: 'Stop', upAudio: 'Upload audio', repT: 'Medical reports (optional)', repUp: 'Add a PDF or photo of a report',
    transcriptCheck: 'Check the transcript below and correct anything that is wrong before sending.', submit: 'Send for review',
    qOf: (i, n) => `Question ${i} of ${n}`, back: 'Back', next: 'Next', skip: 'Skip', yes: 'Yes', no: 'No', unsure: 'Not sure', finish: 'Finish and see summary',
    whyAsk: 'Why we ask', ansPh: 'Type your answer…', cantSay: 'Can’t say',
    recapT: 'What we understood', waiting: 'Sent to the care team. A clinician will review it — you do not need to do anything else.',
    approvedMsg: 'A clinician has reviewed this case.', privacy: 'Privacy', withdraw: 'Withdraw consent & delete my data',
    stepSent: 'Sent', stepQ: 'Questions', stepSum: 'Summary', stepRev: 'Clinician review', urgentT: 'This may need prompt attention',
    emptyCases: 'You have not submitted anything yet.' },
  hi: { intake: 'लक्षण बताएँ', mycases: 'मेरे केस', signout: 'साइन आउट',
    consentT: 'शुरू करने से पहले', consentSub: 'कोई भी जानकारी प्रोसेस करने से पहले हमें आपकी स्पष्ट सहमति चाहिए।',
    c1: 'आपके शब्दों और रिपोर्ट से स्वास्थ्य पेशेवर के लिए सारांश बनाया जाएगा। यदि इस अस्पताल के कंप्यूटर पर कोई छोटा भाषा मॉडल चल रहा हो तो वह मदद कर सकता है; उसे आपका टेक्स्ट दिखने से पहले नाम, फ़ोन नंबर जैसी पहचान छिपा दी जाती है। यदि वह उपलब्ध नहीं है तो सरल कीवर्ड नियम इस्तेमाल होते हैं।',
    c2: 'यह सॉफ़्टवेयर निदान नहीं करता। हर केस की समीक्षा योग्य चिकित्सक करते हैं और अंतिम निर्णय वही लेते हैं।',
    c3: 'चेतावनी संकेत होने पर केस जल्दी समीक्षा के लिए चिह्नित हो सकता है। बहुत तबीयत खराब हो तो अभी 112 / 108 पर कॉल करें।',
    c4: 'आप कभी भी सहमति वापस लेकर अपना सारा डेटा हटा सकते हैं।',
    agree: 'मैं समझता/समझती हूँ और अपनी सहमति देता/देती हूँ।', cont: 'आगे बढ़ें',
    introT: 'बताइए क्या तकलीफ है', introSub: 'बोलकर, लिखकर या रिपोर्ट जोड़कर बताएँ। हिंदी, अंग्रेज़ी या मिली-जुली भाषा चलेगी।',
    langL: 'भाषा', typeL: 'अपने लक्षण लिखें', typePh: 'क्या महसूस हो रहा है, कब से, बढ़ रहा है या घट रहा है, कोई दवा, एलर्जी या बीमारी…',
    speak: 'बोलकर बताएँ', rec: 'रिकॉर्ड', stop: 'रोकें', upAudio: 'ऑडियो अपलोड', repT: 'मेडिकल रिपोर्ट (वैकल्पिक)', repUp: 'रिपोर्ट का PDF या फोटो जोड़ें',
    transcriptCheck: 'नीचे लिखा टेक्स्ट जाँचें और गलती हो तो सुधारें, फिर भेजें।', submit: 'समीक्षा के लिए भेजें',
    qOf: (i, n) => `प्रश्न ${i} / ${n}`, back: 'पीछे', next: 'आगे', skip: 'छोड़ें', yes: 'हाँ', no: 'नहीं', unsure: 'पता नहीं', finish: 'पूरा करें और सारांश देखें',
    whyAsk: 'हम क्यों पूछ रहे हैं', ansPh: 'अपना उत्तर लिखें…', cantSay: 'बता नहीं सकता',
    recapT: 'हमने क्या समझा', waiting: 'केयर टीम को भेज दिया गया है। चिकित्सक इसकी समीक्षा करेंगे — आपको और कुछ करने की ज़रूरत नहीं।',
    approvedMsg: 'चिकित्सक ने इस केस की समीक्षा कर ली है।', privacy: 'गोपनीयता', withdraw: 'सहमति वापस लें और मेरा डेटा हटाएँ',
    stepSent: 'भेजा गया', stepQ: 'प्रश्न', stepSum: 'सारांश', stepRev: 'चिकित्सक समीक्षा', urgentT: 'इसपर जल्दी ध्यान देना ज़रूरी हो सकता है',
    emptyCases: 'आपने अभी तक कुछ नहीं भेजा है।' },
};
export const t = (k, ...a) => { const v = D[S.lang][k] ?? D.en[k]; return typeof v === 'function' ? v(...a) : v; };

/** Client-side live screening using the SAME rules the server uses (/api/rules). Instant — no AI wait. */
export function liveScreen(text) {
  const out = [];
  const sentences = text.split(/(?<=[.!?।])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const re = (p) => new RegExp(p.s, p.f);
  for (const r of S.rules) {
    if (r.requiresAny.length && !r.requiresAny.some((p) => re(p).test(text))) continue;
    const hit = sentences.find((s) => r.patterns.some((p) => { const m = re(p).exec(s); return m && !/\b(no|not|denies|without|never)\b[^.]{0,20}$/i.test(s.slice(Math.max(0, m.index - 24), m.index)); }));
    if (hit) out.push({ id: r.id, level: r.level, label: r.label, evidence: hit });
  }
  const ids = new Set(out.map((o) => o.id));
  return out.filter((o) => !(o.id === 'chest' && ids.has('chest_assoc')) && !(o.id === 'breathing' && ids.has('breathing_severe')));
}
