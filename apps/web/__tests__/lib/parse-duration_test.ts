import { describe, expect, it } from 'vitest';

import { parseDuration } from '../../src/lib/parse-duration';

describe('parseDuration', () => {
  it('parses seconds with the s suffix', () => {
    expect(parseDuration('45s')).toBe(45);
  });

  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60);
  });

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(2 * 3600);
  });

  it('parses days', () => {
    expect(parseDuration('3d')).toBe(3 * 86400);
  });

  it('parses a bare integer as seconds', () => {
    expect(parseDuration('1800')).toBe(1800);
  });

  it('trims surrounding whitespace', () => {
    expect(parseDuration(' 24h ')).toBe(24 * 3600);
  });

  it('accepts the 7d preset spelling', () => {
    expect(parseDuration('7d')).toBe(7 * 86400);
  });

  it('is case-insensitive on the unit', () => {
    expect(parseDuration('5H')).toBe(5 * 3600);
  });

  it('rejects an empty string', () => {
    expect(parseDuration('')).toBeNull();
  });

  it('rejects garbage input', () => {
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('5x')).toBeNull();
    expect(parseDuration('1h30m')).toBeNull();
    expect(parseDuration('-5m')).toBeNull();
    expect(parseDuration('3.5h')).toBeNull();
  });

  it('rejects zero-valued inputs so the dialog surfaces them rather than passing to the backend', () => {
    expect(parseDuration('0')).toBeNull();
    expect(parseDuration('0s')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('0h')).toBeNull();
    expect(parseDuration('0d')).toBeNull();
  });
});
