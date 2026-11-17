import { describe, expect, it } from 'vitest';

import { dateTime, formatDate, formatDateParts, relativeTime, shortDate } from '../../src/lib/format-time';
import { NO_READING } from '../../src/lib/no-reading';

// A fixed instant, read as both an ISO string and an epoch reading. The
// rendered wording depends on the machine's zone, so what is asserted about
// the absolute formats is the relationship between them rather than a literal
// that only holds in one zone.
const INSTANT_ISO = '2024-01-15T12:00:00.000Z';
const INSTANT_EPOCH = Date.parse(INSTANT_ISO);

describe('absolute timestamps', () => {
  it('writes the shared no-reading dash for an absent timestamp', () => {
    expect(shortDate(null, 'en')).toBe(NO_READING);
    expect(shortDate(undefined, 'en')).toBe(NO_READING);
    expect(dateTime(null, 'en')).toBe(NO_READING);
    expect(dateTime(undefined, 'en')).toBe(NO_READING);
  });
});

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

  it('narrows on request and follows the locale', () => {
    expect(relativeTime(INSTANT_EPOCH - 3_600_000, 'en', { now: INSTANT_EPOCH, style: 'narrow' })).toBe('1h ago');
    expect(relativeTime(INSTANT_EPOCH - 3_600_000, 'zh-Hans', { now: INSTANT_EPOCH, style: 'narrow' })).toBe('1 小时前');
    expect(relativeTime(INSTANT_EPOCH - 3_600_000, 'zh-Hans', { now: INSTANT_EPOCH })).toBe('1 小时前');
    expect(relativeTime(INSTANT_EPOCH - 90_000, 'zh-Hans', { now: INSTANT_EPOCH })).toBe('1 分钟前');
  });
});

const calendarDay = new Date(2026, 9, 10, 8, 30);

it('writes Chinese dates numerically across full dates and times of day', () => {
  expect(shortDate(calendarDay.getTime(), 'zh-Hans')).toBe('2026/10/10');
  expect(dateTime(calendarDay.getTime(), 'zh-Hans')).toBe('2026/10/10 08:30:00');
});

it('leaves calendar headings, month cells, and weekdays to Intl in Chinese', () => {
  expect(formatDate(calendarDay, 'zh-Hans', { year: 'numeric', month: 'long' })).toBe('2026 年 10 月');
  expect(formatDate(calendarDay, 'zh-Hans', { month: 'short' })).toBe('10 月');
  expect(formatDate(calendarDay, 'zh-Hans', { weekday: 'long' })).toBe('星期六');
  const sunday = new Date(2026, 9, 11);
  expect(formatDate(sunday, 'zh-Hans', { weekday: 'long' })).toBe('星期日');
});

it('spaces Chinese range parts and preserves English date punctuation', () => {
  const formatter = new Intl.DateTimeFormat('zh-Hans', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const label = formatDateParts(formatter.formatRangeToParts(calendarDay, new Date(2026, 9, 10, 9, 30)));
  expect(label).not.toMatch(/\d[年月日]|[年月日]\d/);
  expect(label).toContain('08:30');
  expect(label).toContain('09:30');
  expect(formatDate(calendarDay, 'en', { year: 'numeric', month: 'short', day: 'numeric' })).toBe('Oct 10, 2026');
});
