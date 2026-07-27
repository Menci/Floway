import { describe, expect, it } from 'vitest';

import { renderMultipart } from '../../../src/components/dump/multipart.ts';

const buildBody = (parts: Array<{ name: string; filename?: string; contentType?: string; body: Uint8Array | string }>, boundary: string): Uint8Array => {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const filenamePart = p.filename === undefined ? '' : `; filename="${p.filename}"`;
    const ctPart = p.contentType === undefined ? '' : `\r\nContent-Type: ${p.contentType}`;
    const headers = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${filenamePart}${ctPart}\r\n\r\n`;
    chunks.push(enc.encode(headers));
    chunks.push(typeof p.body === 'string' ? enc.encode(p.body) : p.body);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
};

const toBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

describe('renderMultipart', () => {
  it('returns null when content-type has no boundary parameter', () => {
    const result = renderMultipart('YWJj', 'multipart/form-data');
    expect(result).toBeNull();
  });

  it('returns null when the body has fewer than two delimiter occurrences', () => {
    const result = renderMultipart(toBase64(new TextEncoder().encode('just plain text')), 'multipart/form-data; boundary=XYZ');
    expect(result).toBeNull();
  });

  it('renders a text-only multipart payload verbatim', () => {
    const boundary = 'boundary123';
    const bytes = buildBody([
      { name: 'model', body: 'gpt-image-2' },
      { name: 'prompt', body: 'Make it shine' },
    ], boundary);
    const out = renderMultipart(toBase64(bytes), `multipart/form-data; boundary=${boundary}`);
    expect(out).not.toBeNull();
    expect(out!).toContain('Content-Disposition: form-data; name="model"');
    expect(out!).toContain('gpt-image-2');
    expect(out!).toContain('Make it shine');
  });

  it('collapses a binary part to a placeholder followed by its base64', () => {
    const boundary = 'b';
    // 8 bytes: a fake PNG signature.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = buildBody([
      { name: 'model', body: 'gpt-image-2' },
      { name: 'image', filename: 'blank.png', contentType: 'image/png', body: png },
    ], boundary);
    const out = renderMultipart(toBase64(bytes), `multipart/form-data; boundary=${boundary}`);
    expect(out).not.toBeNull();
    expect(out!).toContain('Content-Disposition: form-data; name="model"');
    expect(out!).toContain('gpt-image-2');
    expect(out!).toContain('Content-Disposition: form-data; name="image"; filename="blank.png"');
    expect(out!).toContain('Content-Type: image/png');
    expect(out!).toContain('[binary, 8 bytes, content-type=image/png]');
    // The base64 of the 8-byte PNG signature must appear right after the
    // placeholder; the raw bytes themselves must not leak into the text.
    expect(out!).toContain(toBase64(png));
    expect(out!).not.toContain('\x89PNG');
  });

  it('wraps long base64 to MIME-style 76-char lines', () => {
    const boundary = 'b';
    // 200 bytes ascending — base64 is ~268 chars, must wrap at 76.
    const blob = new Uint8Array(Array.from({ length: 200 }, (_, i) => i & 0xff));
    const bytes = buildBody([
      { name: 'image', filename: 'x.bin', contentType: 'application/octet-stream', body: blob },
    ], boundary);
    const out = renderMultipart(toBase64(bytes), `multipart/form-data; boundary=${boundary}`);
    expect(out).not.toBeNull();
    const lines = out!.split('\n');
    const placeholderIdx = lines.findIndex(l => l.startsWith('[binary,'));
    const b64Lines = [];
    for (let i = placeholderIdx + 1; i < lines.length && /^[A-Za-z0-9+/=]+$/.test(lines[i]!); i++) {
      b64Lines.push(lines[i]!);
    }
    expect(b64Lines.length).toBeGreaterThan(1);
    for (const line of b64Lines.slice(0, -1)) {
      // Every line except the last is exactly 76 chars.
      expect(line.length).toBe(76);
    }
  });

  it('accepts a quoted boundary attribute', () => {
    const boundary = 'AaBb';
    const bytes = buildBody([{ name: 'k', body: 'v' }], boundary);
    const out = renderMultipart(toBase64(bytes), `multipart/form-data; boundary="${boundary}"`);
    expect(out).not.toBeNull();
    expect(out!).toContain('name="k"');
    expect(out!).toContain('v');
  });
});
