import { describe, expect, it } from 'vitest';

import { filterModelOptions } from '../../src/lib/model-query';

describe('model combobox filtering', () => {
  const ids = ['openai/gpt-5.6', 'claude-opus-4.6', 'Claude-Haiku-4.5'];

  it('matches a bare id list case-insensitively', () => {
    expect(filterModelOptions(ids, 'CLAUDE')).toEqual(['claude-opus-4.6', 'Claude-Haiku-4.5']);
    expect(filterModelOptions(ids, 'gpt')).toEqual(['openai/gpt-5.6']);
  });

  // The id an operator pastes carries the whitespace the copy picked up, and a
  // catalog that filtered on it would answer an id it holds with an empty list.
  it('trims the query before matching', () => {
    expect(filterModelOptions(ids, ' claude-opus-4.6 ')).toEqual(['claude-opus-4.6']);
  });

  it('answers an empty query with every option', () => {
    expect(filterModelOptions(ids, '   ')).toEqual(ids);
  });
});
