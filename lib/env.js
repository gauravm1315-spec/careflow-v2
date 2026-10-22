// Tiny .env loader (no dependencies) + central configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = root;

try {
  const raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch { /* no .env — fine */ }

const flag = (v, dflt) => (v === undefined || v === '' ? dflt : !/^(0|false|no|off)$/i.test(v));

// NOTE: plain mutable object on purpose — tests adjust endpoints at runtime.
export const cfg = {
  port: Number(process.env.PORT) || 3000,
  staffPin: process.env.STAFF_PIN || '2468',
  demoMode: flag(process.env.DEMO_MODE, true),
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),

  // ---- local small language model (Ollama) ----
  slmEnabled: flag(process.env.SLM_ENABLED, true),            // 0 = force deterministic fallback
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''), // 127.0.0.1, not "localhost" (Windows resolves to IPv6 first)
  ollamaModel: process.env.OLLAMA_MODEL || 'gemma3:4b',
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || 180_000, // CPU-only laptops are slow
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE || '30m',
  ollamaVision: flag(process.env.OLLAMA_VISION, true),         // read report photos with the model (needs a vision-capable model)

  // ---- optional local speech-to-text (whisper.cpp server / faster-whisper-server / any OpenAI-compatible endpoint) ----
  whisperUrl: (process.env.WHISPER_URL || '').replace(/\/+$/, ''),
  whisperPath: process.env.WHISPER_PATH || '/v1/audio/transcriptions',
  whisperModel: process.env.WHISPER_MODEL || 'whisper-1',
  whisperTimeoutMs: Number(process.env.WHISPER_TIMEOUT_MS) || 180_000,

  // ---- privacy policy ----
  // Raw audio / images are only ever sent to a loopback endpoint unless you explicitly opt in.
  allowRemoteRaw: flag(process.env.PRIVACY_ALLOW_REMOTE_RAW, false),
};
