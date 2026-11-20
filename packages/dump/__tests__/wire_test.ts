import { expect, test } from 'vitest';

import { metadata } from './fixtures.ts';
import { dumpRecordToWire } from '../src/index.ts';

test('wire conversion preserves NDJSON content verbatim and shares its metadata', () => {
  const meta = metadata();
  const events = '{"text":"中"}\n{"text":"β"}\n';
  const wire = dumpRecordToWire({ meta, events: new TextEncoder().encode(events) });
  expect(wire.meta).toBe(meta);
  expect(wire.events).toBe(events);
});

test('wire conversion exposes corrupted UTF-8 instead of changing the recorded bytes', () => {
  expect(() => dumpRecordToWire({ meta: metadata(), events: new Uint8Array([0xc3, 0x28]) })).toThrow(TypeError);
});
