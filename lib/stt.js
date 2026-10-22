// Optional LOCAL speech-to-text via a Whisper-compatible HTTP server (whisper.cpp server, faster-whisper-server, …).
// Raw audio is only sent to a loopback endpoint unless PRIVACY_ALLOW_REMOTE_RAW=1. Nothing is sent anywhere if WHISPER_URL is unset.
import { cfg } from './env.js';
import { endpointKind } from './slm.js';

export class SttError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const LANG = { English: 'en', Hindi: 'hi', Hinglish: 'hi', Bengali: 'bn', Marathi: 'mr', Tamil: 'ta', Telugu: 'te', Gujarati: 'gu', Kannada: 'kn', Malayalam: 'ml', Punjabi: 'pa' };

export const sttStatus = () => ({ configured: !!cfg.whisperUrl, endpoint: cfg.whisperUrl ? new URL(cfg.whisperUrl).host : null, endpointKind: cfg.whisperUrl ? endpointKind(cfg.whisperUrl) : null });

export async function transcribe({ buf, mime, lang }) {
  if (!cfg.whisperUrl) throw new SttError('not_configured', 'No local speech-to-text service is configured (WHISPER_URL). Please type your symptoms, or use the optional browser speech-to-text.');
  if (endpointKind(cfg.whisperUrl) !== 'loopback' && !cfg.allowRemoteRaw) throw new SttError('privacy_blocked', 'Raw audio is only sent to a speech service on this machine.');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), mime.includes('wav') ? 'audio.wav' : 'audio.bin');
  fd.append('model', cfg.whisperModel); fd.append('response_format', 'json'); fd.append('temperature', '0');
  if (LANG[lang]) fd.append('language', LANG[lang]);
  let res;
  try { res = await fetch(cfg.whisperUrl + cfg.whisperPath, { method: 'POST', body: fd, signal: AbortSignal.timeout(cfg.whisperTimeoutMs) }); }
  catch (e) { throw new SttError(e?.name === 'TimeoutError' ? 'timeout' : 'unreachable', e?.name === 'TimeoutError' ? 'Speech-to-text timed out.' : 'The local speech-to-text service is not reachable.'); }
  if (!res.ok) throw new SttError('http', `Speech-to-text returned HTTP ${res.status}.`);
  let j; try { j = await res.json(); } catch { throw new SttError('bad_json', 'Unreadable speech-to-text response.'); }
  const text = String(j.text ?? '').trim();
  return { text, language: LANG[lang] ? lang : 'Auto-detected', confidence: null, uncertain: [] };
}
