// Browser audio: record, or convert any audio file to 16 kHz mono WAV (the format local Whisper-style servers accept).
export const MAX_SECONDS = 180;

export class Recorder {
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mt = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    this.chunks = [];
    this.mr = new MediaRecorder(this.stream, mt ? { mimeType: mt } : undefined);
    this.mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.mr.start(250);
    this.t0 = Date.now();
  }
  stop() {
    return new Promise((res) => {
      this.mr.onstop = () => { this.stream.getTracks().forEach((t) => t.stop()); res({ blob: new Blob(this.chunks, { type: this.mr.mimeType }), seconds: (Date.now() - this.t0) / 1000 }); };
      this.mr.stop();
    });
  }
}

export async function toWav16k(blob) {
  const ab = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const buf = await new Promise((ok, no) => ctx.decodeAudioData(ab, ok, no));
  ctx.close?.();
  const sr = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * sr)), sr);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return { blob: new Blob([out], { type: 'audio/wav' }), seconds: buf.duration };
}

export const toB64 = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(blob); });
