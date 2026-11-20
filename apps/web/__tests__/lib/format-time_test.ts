import { describe, expect, it } from 'vitest';

import { formatDate, formatDateParts, relativeTime } from '../../src/lib/format-time';

const INSTANT_EPOCH = Date.parse('2024-01-15T12:00:00.000Z');

describe('relative timestamps', () => {
  const at = (deltaSeconds: number) => relativeTime(INSTANT_EPOCH + deltaSeconds * 1000, 'en', { now: INSTANT_EPOCH });

  it('promotes a unit only once the distance reaches it', () => {
    expect(at(0)).toBe('now');
    expect(at(-59)).toBe('59 seconds ago');
    expect(at(-60)).toBe('1 minute ago');
    expect(at(-3_599)).toBe('60 minutes ago');
    expect(at(-3_600)).toBe('1 hour ago');
    expect(at(-86_399)).toBe('24 hours ago');
    expect(at(-86_400)).toBe('yesterday');
  });

  it('gives up past thirty days in either direction', () => {
    expect(at(-2_591_999)).toBe('30 days ago');
    expect(at(-2_592_000)).toBeNull();
    expect(at(2_591_999)).toBe('in 30 days');
    expect(at(2_592_000)).toBeNull();
  });
});

const calendarDay = new Date(2026, 9, 10, 8, 30);

it('spaces Chinese range parts and preserves English date punctuation', () => {
  const formatter = new Intl.DateTimeFormat('zh-Hans', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const label = formatDateParts(formatter.formatRangeToParts(calendarDay, new Date(2026, 9, 10, 9, 30)));
  expect(label).not.toMatch(/\d[年月日]|[年月日]\d/);
  expect(label).toContain('08:30');
  expect(label).toContain('09:30');
  expect(formatDate(calendarDay, 'en', { year: 'numeric', month: 'short', day: 'numeric' })).toBe('Oct 10, 2026');
});
