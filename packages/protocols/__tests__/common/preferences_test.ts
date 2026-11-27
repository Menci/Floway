import { describe, expect, test } from 'vitest';

import {
  defaultUserPreferences,
  parseStoredUserPreferences,
  parseUserPreferences,
} from '../../src/common/preferences.ts';

describe('user preferences parsing', () => {
  test('defaults absent foldSmallSeries preference to false for older stored records', () => {
    const parsed = parseStoredUserPreferences(
      JSON.stringify({ quotaDisplay: 'used', language: 'zh-Hans', uiTextEditor: true }),
      'user 1',
    );
    expect(parsed).toEqual({
      quotaDisplay: 'used',
      language: 'zh-Hans',
      uiTextEditor: true,
      foldSmallSeries: false,
    });
  });

  test('reads explicit foldSmallSeries boolean and defaults empty input', () => {
    expect(parseUserPreferences(undefined)).toEqual(defaultUserPreferences);
    expect(parseUserPreferences({ foldSmallSeries: true })).toEqual({
      ...defaultUserPreferences,
      foldSmallSeries: true,
    });
  });

  test('rejects a non-boolean foldSmallSeries preference', () => {
    const invalid = { foldSmallSeries: 1 };
    expect(() => parseUserPreferences(invalid)).toThrow(TypeError);
    expect(() => parseStoredUserPreferences(JSON.stringify(invalid), 'user 1')).toThrow(TypeError);
  });
});
