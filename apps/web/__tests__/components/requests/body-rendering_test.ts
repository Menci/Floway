import { describe, expect, it } from 'vitest';

import { contentTypeOf, renderBody, renderWireBody } from '../../../src/components/requests/body-render';
import { formatDecodedJson, formatDiffPath, formatErrorValue } from '../../../src/components/requests/format-value';

// The dump carries bodies as they went over the wire, so a base64 fixture is
// built from bytes rather than from a string literal.
const base64 = (bytes: string) => btoa(bytes);

describe('body rendering', () => {
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
    expect(rendered.text).toContain(base64(png));
    expect(rendered.decodeError).toBeNull();
  });
});

describe('wire body rendering', () => {
  it('finds content type only when the Dump V2 header value is a string', () => {
    expect(contentTypeOf([['content-type', { $secret: { length: 1, hash: 'h', redacted: '*' } }], ['Content-Type', 'text/plain']])).toBe('text/plain');
  });

  it('formats tagged JSON, raw bytes, and multipart parts without losing binary data', () => {
    expect(renderWireBody({ kind: 'json', value: { input: 'hello' } }, [])).toMatchObject({
      text: '{\n  "input": "hello"\n}',
      isJson: true,
    });
    expect(renderWireBody({ kind: 'raw', bytes: new TextEncoder().encode('hello'), contentType: 'text/plain' }, [])).toMatchObject({
      text: 'hello',
      copyText: 'hello',
    });
    const rendered = renderWireBody({
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'model', value: 'm' },
        { kind: 'file', name: 'image', filename: 'a.png', contentType: 'image/png', bytes: new Uint8Array([0x89, 0x50]) },
      ],
    }, []);
    expect(rendered.text).toContain('name="model"');
    expect(rendered.text).toContain('[binary, 2 bytes, content-type=image/png]');
  });

  it('keeps invalid UTF-8 visible as base64 and rejects stream references as bodies', () => {
    const bytes = new Uint8Array([0xff, 0xfe]);
    expect(renderWireBody(bytes, [])).toMatchObject({ text: '//4=', copyText: '//4=', isJson: false });
    expect(renderWireBody({ $stream: 4 }, []).text).toBe('');
  });
});

describe('decoded value formatting', () => {
  it('redacts secrets and converts non-JSON scalars for display', () => {
    expect(formatDecodedJson({ token: { $secret: { length: 9, hash: 'abcdef0123456789', redacted: 'secret-val' } }, count: 12n }))
      .toContain('"$secret": "secret-val (len=9, sha256=abcdef012345)"');
    expect(formatDecodedJson(12n)).toBe('"12n"');
  });

  it('formats structural paths and readable errors', () => {
    expect(formatDiffPath([])).toBe('$');
    expect(formatDiffPath(['request.payload', 'tools', 0, 'name'])).toBe('["request.payload"].tools[0].name');
    expect(formatDiffPath(['', 'key with space'])).toBe('[""]["key with space"]');
    expect(formatErrorValue({ $error: { name: 'TypeError', message: 'bad input', stack: 'TypeError: bad input' } })).toBe('TypeError: bad input');
  });
});
