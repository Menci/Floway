import { test, vi } from 'vitest';

import { unwrapCustomToolInput } from '../../src/protocols/custom-tool-unwrap.ts';
import { assertEquals } from '@floway-dev/test-utils';

// ── unwrapCustomToolInput ──

test('unwrapCustomToolInput returns empty string for empty input', () => {
  assertEquals(unwrapCustomToolInput(''), '');
});

test('unwrapCustomToolInput extracts the input field from a valid wrapped JSON blob', () => {
  assertEquals(unwrapCustomToolInput('{"input":"hello world"}'), 'hello world');
});

test('unwrapCustomToolInput preserves freeform newlines and quotes in the extracted input', () => {
  const wrapped = JSON.stringify({ input: '*** Begin Patch\n*** Update File: "foo.py"\n*** End Patch' });
  assertEquals(unwrapCustomToolInput(wrapped), '*** Begin Patch\n*** Update File: "foo.py"\n*** End Patch');
});

test('unwrapCustomToolInput falls back to the raw blob when JSON parse fails', () => {
  assertEquals(unwrapCustomToolInput('not json'), 'not json');
  assertEquals(unwrapCustomToolInput('{"input":"unterminated'), '{"input":"unterminated');
});

test('unwrapCustomToolInput falls back to the raw blob when input field is missing', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    assertEquals(unwrapCustomToolInput('{"other":"value"}'), '{"other":"value"}');
    assertEquals(warning.mock.calls, [['Custom tool wrapper has no string input; returning the entire JSON value as freeform input.']]);
  } finally {
    warning.mockRestore();
  }
});

test('unwrapCustomToolInput falls back to the raw blob when input field is not a string', () => {
  assertEquals(unwrapCustomToolInput('{"input":42}'), '{"input":42}');
  assertEquals(unwrapCustomToolInput('{"input":null}'), '{"input":null}');
  assertEquals(unwrapCustomToolInput('{"input":{"nested":"obj"}}'), '{"input":{"nested":"obj"}}');
});

test('unwrapCustomToolInput ignores extra wrapper properties', () => {
  assertEquals(unwrapCustomToolInput('{"input":"value","extra":1}'), 'value');
});
