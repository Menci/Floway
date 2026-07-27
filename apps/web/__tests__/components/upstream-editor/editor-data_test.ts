import { describe, expect, it } from 'vitest';

import { migrateLegacyFlagOverrides } from '../../../src/components/upstream-editor/editor-data';

describe('legacy flag override migration', () => {
  it('renames the pre-5289ba35 developer-role flag', () => {
    const source = { 'downgrade-developer-role': true, 'vendor-kimi': false };

    expect(migrateLegacyFlagOverrides(source)).toEqual({
      'demote-developer-to-system': true,
      'vendor-kimi': false,
    });
    expect(source).toHaveProperty('downgrade-developer-role', true);
  });

  it('keeps an explicit current value when both ids are present', () => {
    expect(migrateLegacyFlagOverrides({
      'downgrade-developer-role': true,
      'demote-developer-to-system': false,
    })).toEqual({ 'demote-developer-to-system': false });
  });
});
