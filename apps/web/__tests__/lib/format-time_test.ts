import { describe, expect, it } from 'vitest';

import { dateTime, relativeTime, shortDate } from '../../src/lib/format-time';
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

  it('reads an epoch reading and an ISO string as the same instant', () => {
    expect(shortDate(INSTANT_EPOCH, 'en')).toBe(shortDate(INSTANT_ISO, 'en'));
    expect(dateTime(INSTANT_EPOCH, 'en')).toBe(dateTime(INSTANT_ISO, 'en'));
  });

  it('adds a time of day to the date it shares with the short form', () => {
    const long = dateTime(INSTANT_ISO, 'en');
    expect(long.startsWith(shortDate(INSTANT_ISO, 'en'))).toBe(true);
    expect(long.length).toBeGreaterThan(shortDate(INSTANT_ISO, 'en').length);
  });

  it('spells the date the way the locale does', () => {
    expect(shortDate(INSTANT_ISO, 'zh-Hans')).toContain('年');
    expect(shortDate(INSTANT_ISO, 'en')).not.toContain('年');
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

  it('says the same distance forwards as backwards', () => {
    expect(at(3_600)).toBe('in 1 hour');
    expect(at(86_400)).toBe('tomorrow');
  });

  it('narrows on request and follows the locale', () => {
    expect(relativeTime(INSTANT_EPOCH - 3_600_000, 'en', { now: INSTANT_EPOCH, style: 'narrow' })).toBe('1h ago');
    expect(relativeTime(INSTANT_EPOCH - 3_600_000, 'zh-Hans', { now: INSTANT_EPOCH })).toBe('1小时前');
  });
});
