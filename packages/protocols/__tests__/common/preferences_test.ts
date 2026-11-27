import { describe, expect, it } from 'vitest';

import { parseStoredUserPreferences, parseUserPreferences } from '../../src/common/preferences.ts';

describe('user preferences', () => {
  it('loads preferences stored before the Usage grouping switches existed', () => {
    expect(parseStoredUserPreferences('{"quotaDisplay":"used","language":"en","uiTextEditor":true}', 'test')).toEqual({
      quotaDisplay: 'used', language: 'en', uiTextEditor: true, usageAutoGroup: false, usageAutoFold: false,
    });
  });

  it('rejects a Usage grouping switch that is not a boolean', () => {
    expect(() => parseUserPreferences({ usageAutoGroup: 'true' })).toThrow('preferences.usageAutoGroup must be a boolean');
  });
});
