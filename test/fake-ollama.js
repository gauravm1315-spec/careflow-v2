// Controllable fake of the Ollama HTTP API (+ an OpenAI-style Whisper endpoint) for tests. Records everything it receives.
import http from 'node:http';

const sentences = (m) => m.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

function analysis(msg, st) {
  const S = sentences(msg), first = S[0] || msg.slice(0, 60);
  const out = {
    language: { detected: /mujhe|bukhar/i.test(msg) ? 'Hinglish' : 'English', confidence: 0.9 }, english_text: msg, translation: { confidence: 0.85, uncertain_terms: [] },
    chief_complaint: 'Symptoms described',
    symptoms: [{ name: 'Main symptom', quote: first, source: 'message', confidence: 0.9 }, { name: 'Invented symptom', quote: 'this quote is not in the message at all', source: 'message', confidence: 0.9 }],
    denied_symptoms: [], onset: null, progression: null, severity: null, history: [], medications: [], allergies: [],
    missing: [{ field: 'Progression', why_it_matters: 'trend' }], conflicts: [], uncertain: [], suspicious_instructions: [],
    red_flags: st.redFlags(msg), ai_priority: { level: st.aiPriority, rationale: 'fake model rationale', confidence: 0.8 },
    follow_up_questions: [
      { question: 'Is it getting worse?', question_local: 'Kya yeh badh raha hai?', reason: 'progression', answer_type: 'yes_no', options: [], priority: 1 },
      { question: 'Any allergies?', question_local: 'Koi allergy?', reason: 'allergy unknown', answer_type: 'text', options: [], priority: 2 }],
  };
  return out;
}

export async function startFakeOllama() {
  const st = {
    tags: ['gemma3:4b'], chatMode: 'ok',          // ok | bad-json-once | bad-json-always | hang | http500 | model-missing
    aiPriority: 'routine', redFlags: () => [], calls: [], tagCalls: 0, whisperCalls: [], badOnceDone: false,
  };
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (req.url === '/api/tags') { st.tagCalls++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ models: st.tags.map((name) => ({ name })) })); }
    if (req.url.startsWith('/v1/audio/transcriptions')) { st.whisperCalls.push({ bytes: raw.length, type: req.headers['content-type'] }); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: 'Mujhe 3 din se bukhar hai' })); }
    if (req.url !== '/api/chat') { res.writeHead(404); return res.end('{}'); }
    const body = JSON.parse(raw.toString() || '{}');
    const system = body.messages[0].content, user = body.messages[1].content, images = body.messages[1].images || [];
    const task = /TASK: (\w+)/.exec(system)?.[1];
    st.calls.push({ task, system, user, images: images.length, model: body.model, format: body.format });
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: typeof obj === 'string' ? obj : JSON.stringify(obj) }, done: true })); };
    if (st.chatMode === 'hang') return undefined;
    if (st.chatMode === 'http500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'boom' })); }
    if (st.chatMode === 'model-missing') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: `model '${body.model}' not found` })); }
    if (st.chatMode === 'bad-json-always') return reply('Sure! Here is the summary: {not json');
    if (st.chatMode === 'bad-json-once' && !st.badOnceDone) { st.badOnceDone = true; return reply('```json\n{"oops": ');}
    const msg = (/<patient_message>\n([\s\S]*?)\n<\/patient_message>/.exec(user) || [])[1] || '';
    if (task === 'analyze_intake') return reply(analysis(msg, st));
    if (task === 'finalize_summary') {
      const a = /<answer qid="q1"[^>]*>([^<]*)<\/answer>/.exec(user)?.[1] || '';
      return reply({ ...analysis(msg, st), progression: a ? { text: 'Per patient answer', quote: a, source: 'answer:q1', confidence: 0.9 } : null,
        narrative: 'Neutral overview of the case.', patient_recap: { text: 'You told us about your symptoms.', needs_confirmation: [] }, clinician_questions: ['Travel history?'] });
    }
    if (task === 'extract_report') return reply({ is_medical_document: true, doc_type: 'Lab report', report_date: '2026-10-01', raw_text: '[Page 1] HbA1c 7.1 % (4.0-5.6) H', values: [{ name: 'HbA1c', value: '7.1', unit: '%', reference_range: '4.0-5.6', flag: 'high', page: 1, confidence: 0.9, quote: 'HbA1c 7.1 %' }], unreadable: [], overall_confidence: 0.9 });
    res.writeHead(400); return res.end(JSON.stringify({ error: 'unknown task' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, st, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } };
}
