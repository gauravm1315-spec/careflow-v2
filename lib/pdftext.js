// Minimal, dependency-free PDF text-layer reader (Flate + plain streams, simple fonts).
// It reads TEXT-BASED PDFs only. Scanned PDFs, custom-encoded fonts and encrypted PDFs yield `ok:false` — callers then ask for a photo or typed values.
import zlib from 'node:zlib';

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (m, c) => {
    if (c === 'n') return '\n'; if (c === 'r') return '\r'; if (c === 't') return '\t'; if (c === 'b' || c === 'f') return ' ';
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8)); if (/^\r?\n$/.test(c)) return ''; return c;
  });
}

export function extractPdfText(buf) {
  const raw = buf.toString('latin1');
  if (!raw.startsWith('%PDF')) return { ok: false, text: '', reason: 'Not a PDF file.' };
  if (/\/Encrypt\b/.test(raw)) return { ok: false, text: '', reason: 'The PDF is encrypted.' };
  const lines = [];
  const re = /(<<[^>]*?>>)\s*stream\r?\n/g; let m;
  while ((m = re.exec(raw))) {
    const start = re.lastIndex, end = raw.indexOf('endstream', start); if (end < 0) break;
    let data = Buffer.from(raw.slice(start, end), 'latin1');
    if (/\/FlateDecode/.test(m[1])) { try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateRawSync(data); } catch { continue; } } }
    const c = data.toString('latin1'); if (!/\bBT\b/.test(c)) continue;
    for (const bt of c.matchAll(/BT([\s\S]*?)ET/g)) {
      let line = '';
      for (const op of bt[1].matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ|\(((?:\\.|[^()\\])*)\)\s*(?:Tj|'|")|(T\*|-?\d*\.?\d+\s+-?\d*\.?\d+\s+T[dD]|(?:-?\d*\.?\d+\s+){6}Tm)/g)) {
        if (op[3]) { if (line.trim()) lines.push(line.trim()); line = ''; continue; }
        if (op[1] !== undefined) { for (const s of op[1].matchAll(/\(((?:\\.|[^()\\])*)\)|(-?\d+\.?\d*)/g)) { if (s[1] !== undefined) line += unescapePdf(s[1]); else if (+s[2] < -200) line += ' '; } }
        else if (op[2] !== undefined) line += unescapePdf(op[2]) + ' ';
      }
      if (line.trim()) lines.push(line.trim());
    }
  }
  const text = lines.join('\n').trim();
  const printable = text ? (text.match(/[\x20-\x7E\n\u0900-\u097F]/g) || []).length / text.length : 0;
  if (text.length < 20 || printable < 0.9) return { ok: false, text: '', reason: 'No readable text layer (likely a scanned PDF).' };
  return { ok: true, text: `[Page 1]\n${text}`.slice(0, 20000), reason: '' };
}
