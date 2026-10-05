import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import * as cbor from 'cbor-x';
import mapObject from 'map-obj';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('cbor-x/package.json'));
const sample = '{"__proto__":{"preserved":true},"__proto_":"distinct","nested":{"__proto__":null,"__proto_":false},"constructor":{"prototype":{"value":1}},"\\ud800":"\\udc00"}';

const browser = (file: string): typeof cbor => {
  const exports = {};
  runInNewContext(readFileSync(join(packageRoot, 'dist', file), 'utf8'), { exports, module: { exports }, TextEncoder, TextDecoder });
  return exports as typeof cbor;
};

const runtimes = [
  ['ESM', cbor, true],
  ['CommonJS', require('cbor-x') as typeof cbor, true],
  ['no-eval', require('cbor-x/index-no-eval') as typeof cbor, false],
  ['decode-no-eval', require('cbor-x/decode-no-eval') as typeof cbor, false],
  ['browser', browser('index.js'), true],
  ['browser-minified', browser('index.min.js'), true],
  ['browser-no-eval-minified', browser('index-no-eval.min.js'), false],
] as const;

test('recursive mapping preserves literal JSON property names without changing prototypes', () => {
  const input = JSON.parse(sample) as Record<string, unknown>;
  const result = mapObject(input, (key, value) => [key, value], { deep: true });
  expect(result).toEqual(input);
  expect(Object.hasOwn(result, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(Object.prototype, 'preserved')).toBe(false);
});

test.each(runtimes)('%s CBOR preserves property names in map and record decoding', (_name, runtime, evaluates) => {
  const input = JSON.parse(sample) as Record<string, unknown>;
  const encoder = new cbor.Encoder({ useRecords: false });
  const bytes = encoder.encode(input);
  const decoder = new runtime.Decoder({ mapsAsObjects: true, structures: [] });
  const decoded = decoder.decode(bytes) as Record<string, unknown>;
  expect(JSON.stringify(decoded)).toBe(sample);
  expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
  expect(Object.hasOwn(Object.getPrototypeOf(decoded), 'preserved')).toBe(false);

  expect([...bytes.subarray(0, 3)]).toEqual([0xb9, 0, 5]);
  const indefinite = Uint8Array.from([0xbf, ...bytes.subarray(3), 0xff]);
  expect(JSON.stringify(decoder.decode(indefinite))).toBe(sample);

  const records = Array.from({ length: 12 }, () => JSON.parse(sample) as Record<string, unknown>);
  const recordDecoder = new runtime.Decoder({ mapsAsObjects: true, structures: [] });
  const recordBytes = new cbor.Encoder({ useRecords: true }).encode(records);
  expect(JSON.stringify(recordDecoder.decode(recordBytes))).toBe(JSON.stringify(records));
  const { structures } = recordDecoder as unknown as { structures: Array<{ compiledReader?: unknown }> };
  expect(structures.some(structure => structure?.compiledReader !== undefined)).toBe(evaluates);

  const keyMap = JSON.parse('{"__proto__":1,"__proto_":2}') as Record<string, number>;
  const keyedEncoder = new cbor.Encoder({ useRecords: false, keyMap });
  const keyedDecoder = new runtime.Decoder({ mapsAsObjects: true, keyMap });
  const mapped = JSON.parse('{"__proto__":"original","__proto_":"distinct"}') as Record<string, unknown>;
  expect(JSON.stringify(keyedDecoder.decode(keyedEncoder.encode(mapped)))).toBe(JSON.stringify(mapped));

  const legacy = new cbor.Tag([0xe000, ['__proto__', '__proto_'], 'original', 'distinct'], 105);
  expect(JSON.stringify(decoder.decode(encoder.encode(legacy)))).toBe(JSON.stringify(mapped));

  const cyclic = JSON.parse(sample) as Record<string, unknown>;
  cyclic.self = cyclic;
  const restored = decoder.decode(new cbor.Encoder({ structuredClone: true, useRecords: false }).encode(cyclic)) as Record<string, unknown>;
  expect(restored.self).toBe(restored);
  expect(Object.hasOwn(restored, '__proto__')).toBe(true);
  expect(restored.__proto__).toEqual({ preserved: true });
});
