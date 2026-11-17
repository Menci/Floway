import { describe, expect, it } from 'vitest';

import { renderBody } from '../../../src/components/requests/body-render';

// The dump carries bodies as they went over the wire, so a base64 fixture is
// built from bytes rather than from a string literal.
const base64 = (bytes: string) => btoa(bytes);

const withoutTypedArrayBase64 = <T>(run: () => T): T => {
  const fromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, 'fromBase64');
  const toBase64 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64');
  Object.defineProperty(Uint8Array, 'fromBase64', { configurable: true, value: undefined });
  Object.defineProperty(Uint8Array.prototype, 'toBase64', { configurable: true, value: undefined });
  try {
    return run();
  } finally {
    if (fromBase64) Object.defineProperty(Uint8Array, 'fromBase64', fromBase64);
    else Reflect.deleteProperty(Uint8Array, 'fromBase64');
    if (toBase64) Object.defineProperty(Uint8Array.prototype, 'toBase64', toBase64);
    else Reflect.deleteProperty(Uint8Array.prototype, 'toBase64');
  }
};

describe('body rendering', () => {
  it('pretty-prints JSON and says that is what it is', () => {
    const rendered = renderBody({ data: '{"model":"gpt-5","stream":true}', encoding: 'utf8' }, 'application/json');

    expect(rendered.isJson).toBe(true);
    expect(rendered.text).toBe('{\n  "model": "gpt-5",\n  "stream": true\n}');
    expect(rendered.copyText).toBe(rendered.text);
  });

  // A body that is not text at all keeps its base64 on screen rather than
  // becoming replacement characters, and says why.
  it('reports a body it cannot decode instead of showing mojibake', () => {
    const data = base64('ÿþý');

    const rendered = renderBody({ data, encoding: 'base64' }, 'application/octet-stream');

    expect(rendered.decodeError).toBeTruthy();
    expect(rendered.text).toBe(data);
    expect(rendered.copyText).toBe(data);
    expect(rendered.isJson).toBe(false);
  });
});

describe('multipart body rendering', () => {
  const boundary = 'floway-boundary';
  const bytes = (...values: number[]) => String.fromCharCode(...values);
  const part = (headers: string, body: string) => `${headers}\r\n\r\n${body}`;
  const multipart = (parts: string[]) =>
    [`--${boundary}`, parts.join(`\r\n--${boundary}\r\n`), `--${boundary}--`, ''].join('\r\n');

  const jsonPart = part('content-disposition: form-data; name="model"\r\ncontent-type: Application/Vnd.Floway+JSON; charset=utf-8', '{"id":1}');
  const textWire = multipart([jsonPart, part('content-disposition: form-data; name="note"', 'hello')]);
  const render = (wire: string, contentType = `multipart/form-data; boundary=${boundary}`) =>
    renderBody({ data: base64(wire), encoding: 'base64' }, contentType);

  // Bytes no textual decoding could survive, so a render that reached the
  // placeholder cannot have come from the plain-body fallback.
  const image = bytes(0x00, 0x01, 0xFF);
  const binaryWire = multipart([jsonPart, part('content-disposition: form-data; name="file"\r\ncontent-type: image/png', image)]);

  it('renders binary parts directly through the legacy-browser fallback', () => {
    const rendered = withoutTypedArrayBase64(() => render(binaryWire));

    expect(rendered.text).toContain('[binary, 3 bytes, content-type=image/png]');
    expect(rendered.text).toContain(base64(image));
  });

  it('copies the body as it arrived rather than as it is shown', () => {
    const data = base64(textWire);

    expect(renderBody({ data, encoding: 'base64' }, `multipart/form-data; boundary=${boundary}`).copyText).toBe(data);
    expect(renderBody({ data, encoding: 'base64' }, `multipart/form-data; boundary=${boundary}`).text).not.toBe(data);
  });

  // A PNG signature leads with 0x89, inside the 0x80-0x9F range where the
  // windows-1252 decoder the Encoding Standard resolves latin1 to
  // (https://encoding.spec.whatwg.org/#names-and-labels) is not byte-transparent.
  // Reading the wire through any text encoding loses those bytes and abandons
  // the whole multipart render, so every PNG upload arrives as a raw blob.
  const png = bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A);
  const pngWire = multipart([jsonPart, part('content-disposition: form-data; name="file"\r\ncontent-type: image/png', png)]);

  it('round-trips a PNG signature rather than losing it to the encoding', () => {
    const rendered = render(pngWire);

    expect(rendered.text).toContain('{"id":1}');
    expect(rendered.text).toContain('[binary, 8 bytes, content-type=image/png]');
    expect(rendered.text).toContain(base64(png));
    expect(rendered.decodeError).toBeNull();
  });
});
