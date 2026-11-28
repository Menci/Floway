import { describe, expect, test } from 'vitest';

import {
  defaultUserPreferences,
  parseStoredUserPreferences,
  parseUserPreferences,
} from '../../src/common/preferences.ts';

describe('user preferences parsing', () => {
  test('defaults absent telemetry grouping preferences to false for older stored records', () => {
    const parsed = parseStoredUserPreferences(
      JSON.stringify({ quotaDisplay: 'used', language: 'zh-Hans', uiTextEditor: true }),
      'user 1',
    );
    expect(parsed).toEqual({
      quotaDisplay: 'used',
      language: 'zh-Hans',
      uiTextEditor: true,
      mergeModelVariants: false,
      foldSmallSeries: false,
    });
  });

  test('reads explicit telemetry grouping booleans and defaults empty input', () => {
    expect(parseUserPreferences(undefined)).toEqual(defaultUserPreferences);
    expect(parseUserPreferences({ mergeModelVariants: true, foldSmallSeries: true })).toEqual({
      ...defaultUserPreferences,
      mergeModelVariants: true,
      foldSmallSeries: true,
    });
  });

  test('rejects a non-boolean telemetry preference', () => {
    const invalid = { mergeModelVariants: 'true' };
    expect(() => parseUserPreferences(invalid)).toThrow(TypeError);
    expect(() => parseStoredUserPreferences(JSON.stringify(invalid), 'user 1')).toThrow(TypeError);
  });
});
