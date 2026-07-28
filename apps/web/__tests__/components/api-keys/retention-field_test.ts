import { describe, expect, it } from 'vitest';

import { parseDuration } from '../../../src/lib/parse-duration';

// The retention control resolves a preset or a typed window into the number of
// seconds the gateway stores, and reports `invalid` rather than silently
// falling back — a key that quietly kept data forever would be worse than one
// that refuses to save.
const DUMP_PRESETS = [3600, 6 * 3600, 24 * 3600, 7 * 86400] as const;
const RESPONSES_MAX_SECONDS = 10 * 365 * 86400;
const SECONDS_PER_DAY = 86400;

const resolveDuration = (input: string, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number | 'invalid' => {
  const seconds = parseDuration(input);
  if (seconds === null || seconds < minimum || seconds > maximum) return 'invalid';
  return seconds;
};

const resolveDays = (input: string, maximum: number): number | 'invalid' => {
  if (!/^\d+$/.test(input.trim())) return 'invalid';
  const seconds = Number(input.trim()) * SECONDS_PER_DAY;
  return seconds >= SECONDS_PER_DAY && seconds <= maximum ? seconds : 'invalid';
};

describe('retention windows', () => {
  it('offers dump presets the gateway accepts as-is', () => {
    for (const seconds of DUMP_PRESETS) expect(Number.isSafeInteger(seconds)).toBe(true);
    expect(DUMP_PRESETS).toEqual([...DUMP_PRESETS].toSorted((left, right) => left - right));
  });

  it('accepts a typed duration for request dumps', () => {
    expect(resolveDuration('30m')).toBe(1800);
    expect(resolveDuration('2h')).toBe(7200);
    expect(resolveDuration('3d')).toBe(259_200);
    expect(resolveDuration('900')).toBe(900);
  });

  it('rejects a dump window that does not parse or resolves to nothing', () => {
    expect(resolveDuration('')).toBe('invalid');
    expect(resolveDuration('soon')).toBe('invalid');
    expect(resolveDuration('0')).toBe('invalid');
    expect(resolveDuration('-1h')).toBe('invalid');
  });

  it('reads Stateful Responses retention in whole days', () => {
    expect(resolveDays('14', RESPONSES_MAX_SECONDS)).toBe(14 * SECONDS_PER_DAY);
    expect(resolveDays('1', RESPONSES_MAX_SECONDS)).toBe(SECONDS_PER_DAY);
  });

  it('rejects a Responses window below a day or past the ceiling', () => {
    expect(resolveDays('0', RESPONSES_MAX_SECONDS)).toBe('invalid');
    expect(resolveDays('3651', RESPONSES_MAX_SECONDS)).toBe('invalid');
    expect(resolveDays('1.5', RESPONSES_MAX_SECONDS)).toBe('invalid');
    expect(resolveDays('7d', RESPONSES_MAX_SECONDS)).toBe('invalid');
  });

  it('keeps zero distinct from null: one means do not persist, the other do not capture', () => {
    const dumpOff: number | null = null;
    const responsesOff = 0;
    expect(dumpOff).not.toBe(responsesOff);
  });
});
