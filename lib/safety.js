// Deterministic safety layer. Runs with or without AI, on the server and (via /api/rules) in the browser.
// ILLUSTRATIVE rules only — not clinically validated. They can ESCALATE a case, never lower it.

export const EMERGENCY_ADVICE =
  'Seek immediate professional assessment. If symptoms are severe or worsening, contact local emergency services (India: 112 / 108).';

// matches "chest pain" and "pain / tightness in my chest"
const CHEST = /chest\s+(pain|tightness|pressure|heaviness)|(pain|tightness|pressure|heaviness|discomfort)\s+(in|on|across|around)\s+(my\s+|the\s+|his\s+|her\s+)?chest/i;
const R = (id, level, label, patterns, requiresAny) => ({ id, level, label, patterns, requiresAny, advice: EMERGENCY_ADVICE });

export const RULES = [
  R('breathing_severe', 'urgent', 'Severe breathing difficulty', [
    /(severe|can'?t|cannot|unable to|struggling to|trouble|difficulty|hard to)\s+(breath|breathe|breathing)/i,
    /(short(ness)? of breath|breathless).{0,40}(severe|at rest|worse|talk|sudden|can'?t)/i,
    /saans\s+(nahi|nahin|lene\s+me|lene\s+mein|phool|fool)/i,
    /सांस\s*(नहीं|लेने\s*में|फूल)|साँस\s*(नहीं|लेने\s*में|फूल)/,
  ]),
  R('breathing', 'priority', 'Breathlessness reported', [/short(ness)? of breath|breathless|wheez/i, /saans|सांस|साँस/i]),
  R('chest_assoc', 'urgent', 'Chest pain with associated concerning symptoms', [
    CHEST, /seen[ae]\s+(me|mein)\s+dard/i, /सीने\s*में\s*(दर्द|जकड़न)/,
  ], [/sweat|arm|jaw|breath|faint|dizz|nausea|pasina|पसीना|बाँह|बाएं हाथ|बायें हाथ|चक्कर/i]),
  R('chest', 'priority', 'Chest pain reported', [CHEST, /seen[ae]\s+(me|mein)\s+dard/i, /सीने\s*में\s*(दर्द|जकड़न)/]),
  R('stroke', 'urgent', 'Possible stroke signs (face / arm / speech)', [
    /face\s+(droop|drooping|is drooping)|drooping\s+face/i,
    /(slurred|unclear|difficulty with|trouble with)\s+speech/i,
    /(sudden|one[- ]sided)\s+(weakness|numbness)/i,
    /can'?t\s+(lift|move)\s+(my|his|her)\s+(arm|leg)/i,
    /लकवा|चेहरा\s*टेढ़ा|बोलने\s*में\s*(दिक्कत|तकलीफ)/,
  ]),
  R('bleeding', 'urgent', 'Severe or uncontrolled bleeding', [
    /(heavy|severe|uncontrolled|won'?t stop|not stopping)\s+bleed/i, /bleeding\s+(won'?t|will not|doesn'?t|is not)\s+stop/i,
    /vomit(ing)?\s+blood|blood\s+in\s+(vomit|stool)|coughing\s+(up\s+)?blood/i, /khoon\s+(ki\s+ulti|nahi\s+ruk)/i, /खून\s*(की\s*उल्टी|नहीं\s*रुक)/,
  ]),
  R('consciousness', 'urgent', 'Loss of consciousness / unresponsiveness', [
    /(passed out|fainted|lost consciousness|unconscious|unresponsive|blacked out)/i, /behosh/i, /बेहोश/,
  ]),
  R('seizure', 'urgent', 'Seizure reported', [/seizure|convulsion|had a fit\b|daura\b/i, /दौरा|मिर्गी/]),
  R('selfharm', 'urgent', 'Possible thoughts of self-harm', [
    /(want to|going to|thinking (of|about)|plan to)\s+(die|kill myself|end my life|end it all)/i, /suicid/i, /khudkushi|jeena\s+nahi/i, /आत्महत्या|मरना\s*चाहत|जीना\s*नहीं/,
  ]),
  R('allergic', 'urgent', 'Possible severe allergic reaction', [
    /(swelling|swollen)\s+(of\s+)?(the\s+)?(face|lips|tongue|throat)/i, /(lips|tongue|throat)\s+(is|are)?\s*swell/i,
  ]),
  R('overdose', 'urgent', 'Possible poisoning / overdose', [/overdose|swallowed\s+(poison|pills|kerosene|phenyl)|took\s+too\s+many\s+(pills|tablets)/i, /zeher\s+(kha|pi)/i, /ज़हर|जहर\s*(खा|पी)/]),
];

export const publicRules = () =>
  RULES.map((r) => ({ id: r.id, level: r.level, label: r.label, patterns: r.patterns.map((p) => ({ s: p.source, f: p.flags })),
    requiresAny: (r.requiresAny || []).map((p) => ({ s: p.source, f: p.flags })) }));

export const splitSentences = (t) =>
  String(t || '').split(/(?<=[.!?।])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

const EN_NEG = /\b(no|not|denies|denied|without|never)\b[^.]{0,20}$/i;

/** Screen free text. Returns one flag per rule (urgent supersedes priority twin). */
export function screen(text, kind = 'message', ref = null, { translated = false } = {}) {
  const sentences = splitSentences(text);
  const out = [];
  for (const rule of RULES) {
    for (const s of sentences) {
      let hit = false;
      for (const p of rule.patterns) {
        const m = p.exec(s);
        if (!m) continue;
        if (EN_NEG.test(s.slice(Math.max(0, m.index - 24), m.index))) continue; // "no chest pain"
        hit = true; break;
      }
      if (!hit) continue;
      if (rule.requiresAny && !rule.requiresAny.some((p) => p.test(text))) continue;
      out.push({ ruleId: rule.id, level: rule.level, label: rule.label, evidence: s, why: '',
        source: { kind, ref, quote: s, verified: !translated, translated }, advice: rule.advice, origin: 'rule' });
      break;
    }
  }
  const ids = new Set(out.map((f) => f.ruleId));
  return out.filter((f) => !(f.ruleId === 'chest' && ids.has('chest_assoc')) && !(f.ruleId === 'breathing' && ids.has('breathing_severe')));
}

// ---- prompt-injection / suspicious instruction detection -------------------------------------
const INJECTION = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(the\s+|all\s+|your\s+)?(instructions?|rules?|prompt|guidelines)/i,
  /(system|developer)\s+prompt/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /(mark|set|classify|label|rate)\s+(this|me|my case|the case|it)\s+(as\s+)?(routine|low|not urgent|non[- ]urgent|normal|safe)/i,
  /do\s+not\s+(flag|alert|escalate|mention|tell)/i,
  /(override|bypass)\s+(the\s+)?(triage|priority|safety|rules?|filters?)/i,
  /reveal\s+(your|the)\s+(prompt|instructions|rules)/i,
  /\bjailbreak\b|\bDAN mode\b/i,
  /पिछले\s*निर्देश\s*(अनदेखा|भूल)/,
];
export function detectInjection(text, kind = 'message', ref = null) {
  const out = [];
  for (const s of splitSentences(text)) {
    if (INJECTION.some((p) => p.test(s))) {
      out.push({ quote: s.slice(0, 300), note: 'Text resembles an instruction to the system rather than a symptom description. It was not followed.',
        source: { kind, ref, quote: s.slice(0, 300), verified: true }, origin: 'rule' });
    }
  }
  return out;
}

// ---- source verification ---------------------------------------------------------------------
export const norm = (s) =>
  String(s || '').toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Is `quote` (really) present in `text`? Tolerates minor punctuation / ASR whitespace differences. */
export function quoteFound(quote, text) {
  const q = norm(quote), t = norm(text);
  if (!q || !t) return false;
  if (t.includes(q)) return true;
  const qt = q.split(' ');
  if (qt.length < 4) return false;
  const tt = new Set(t.split(' '));
  return qt.filter((w) => tt.has(w)).length / qt.length >= 0.85;
}

export const LEVEL_RANK = { urgent: 0, priority: 1, clarification: 2, routine: 3 };
export const maxLevel = (...levels) =>
  levels.filter((l) => l in LEVEL_RANK).sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b])[0] || 'routine';
