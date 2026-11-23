import { describe, expect, it } from 'vitest';

import { contentTypeOf, renderWireBody } from '../../../src/components/requests/body-render';
import { formatDecodedJson, formatDiffPath, formatErrorValue } from '../../../src/components/requests/format-value';
import { createDumpDecoder } from '@floway-dev/dump/browser';
import { Bytes } from '@floway-dev/pipeline/browser';

// The dump carries bodies as they went over the wire, so a base64 fixture is
// built from bytes rather than from a string literal.
const base64 = (bytes: string) => btoa(bytes);
const binary = (bytes: string) => Bytes.copy(Uint8Array.from(bytes, c => c.charCodeAt(0)));

describe('body rendering', () => {
  // A body that is not text at all keeps its base64 on screen rather than
  // becoming replacement characters, and says why.
  it('reports a body it cannot decode instead of showing mojibake', () => {
    const data = base64('ÿþý');

    const rendered = renderWireBody(binary('ÿþý'), [['content-type', 'application/octet-stream']]);

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
    renderWireBody(binary(wire), [['content-type', contentType]]);

  it('copies the body as it arrived rather than as it is shown', () => {
    const data = base64(textWire);

    expect(render(textWire).copyText).toBe(data);
    expect(render(textWire).text).not.toBe(data);
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
  it('finds content type only when the decoded header value is a string', () => {
    expect(contentTypeOf([['content-type', { $secret: { length: 1, hash: 'h', redacted: '*' } }], ['Content-Type', 'text/plain']])).toBe('text/plain');
  });

  it('formats JSON wire bytes and raw text', () => {
    expect(renderWireBody(Bytes.fromUtf8('{"input":"hello"}'), [])).toMatchObject({
      text: '{\n  "input": "hello"\n}',
      isJson: true,
    });
    expect(renderWireBody(Bytes.fromUtf8('hello'), [['content-type', 'text/plain']])).toMatchObject({
      text: 'hello',
      copyText: 'hello',
    });
  });

  it('keeps invalid UTF-8 visible as base64 and rejects stream references as bodies', () => {
    const bytes = Bytes.copy(new Uint8Array([0xff, 0xfe]));
    expect(renderWireBody(bytes, [])).toMatchObject({ text: '//4=', copyText: '//4=', isJson: false });
    expect(renderWireBody({ $stream: 4 }, []).text).toBe('');
  });
});

describe('decoded value formatting', () => {
  it('redacts secrets and converts non-JSON scalars for display', () => {
    const decoder = createDumpDecoder();
    expect(formatDecodedJson(decoder.resolve({ token: { $secret: { length: 9, hash: 'abcdef0123456789', redacted: 'secret-val' } }, count: { $bigint: '12' } })))
      .toContain('"$secret": "secret-val (len=9, sha256=abcdef012345)"');
    expect(formatDecodedJson(12n)).toBe('"12n"');
  });

  it('keeps decoded raw JSON exact and leaves ordinary rawJSON-shaped objects alone', () => {
    const decoder = createDumpDecoder();
    expect(formatDecodedJson(decoder.resolve({ id: { $rawJson: '9007199254740993' } }))).toBe('{\n  "id": 9007199254740993\n}');
    expect(formatDecodedJson({ rawJSON: 'literal' })).toBe('{\n  "rawJSON": "literal"\n}');
  });

  it('formats structural paths and readable errors', () => {
    expect(formatDiffPath([])).toBe('$');
    expect(formatDiffPath(['request.payload', 'tools', 0, 'name'])).toBe('["request.payload"].tools[0].name');
    expect(formatDiffPath(['', 'key with space'])).toBe('[""]["key with space"]');
    expect(formatErrorValue({ name: 'TypeError', message: 'bad input', stack: 'TypeError: bad input' })).toBe('TypeError: bad input');
  });
});
