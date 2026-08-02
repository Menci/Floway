import { describe, expect, it } from 'vitest';

import { formatDurationInput, parseDuration } from '../../../src/components/api-keys/duration-input';

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

describe('formatDurationInput', () => {
  it('spells a window in the coarsest whole unit the grammar has', () => {
    expect(formatDurationInput(7 * 86400)).toBe('7d');
    expect(formatDurationInput(6 * 3600)).toBe('6h');
    expect(formatDurationInput(30 * 60)).toBe('30m');
    expect(formatDurationInput(45)).toBe('45s');
  });

  it('round-trips back through the parser', () => {
    for (const seconds of [1, 45, 90, 1800, 3600, 5400, 86400, 7 * 86400]) {
      expect(parseDuration(formatDurationInput(seconds))).toBe(seconds);
    }
  });
});
