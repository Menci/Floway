import { describe, expect, it } from 'vitest';

import { parseStoredUserPreferences, parseUserPreferences } from '../../src/common/preferences.ts';

describe('user preferences', () => {
  it('loads preferences stored before the Usage model groups existed', () => {
    expect(parseStoredUserPreferences('{"quotaDisplay":"used","language":"en","uiTextEditor":true}', 'test')).toEqual({
      quotaDisplay: 'used', language: 'en', uiTextEditor: true, usageModelGroups: [], usageOtherShare: 0,
    });
  });

  it('rejects a model group or Other share this build cannot apply', () => {
    expect(() => parseUserPreferences({ usageModelGroups: [{ pattern: ' ', name: 'GPT' }] })).toThrow('pattern must not be blank');
    expect(() => parseUserPreferences({ usageModelGroups: [{ pattern: 'gpt-*', name: 'GPT', regex: true }] })).toThrow('unknown field regex');
    expect(() => parseUserPreferences({ usageOtherShare: 3 })).toThrow('usageOtherShare');
  });
});
