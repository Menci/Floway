import { describe, expect, it } from 'vitest';

import { foldModelSeries, modelGroupMatcher, OTHER_SERIES_ID } from '../../../src/components/usage/model-groups';
import type { DisplayUsageRecord } from '../../../src/components/usage/types';

const record = (group: string, inputTokens: number): DisplayUsageRecord =>
  ({ bucket: 'b', group, requests: 1, metrics: { input_tokens: String(inputTokens) }, cost: null });

const fold = (records: DisplayUsageRecord[], groups: Array<{ pattern: string; name: string }>, otherShare = 0) => foldModelSeries({
  records, models: [...new Set(records.map(item => item.group))], groups, otherShare, metric: 'total', otherLabel: count => `Other (${count})`,
});

describe('model group patterns', () => {
  it('treats only * as a wildcard, ignores case, and lets the first matching group claim a model', () => {
    const match = modelGroupMatcher([{ pattern: 'claude-opus-*', name: 'Opus' }, { pattern: '*claude*', name: 'Claude' }, { pattern: 'gpt-6.1', name: 'GPT' }]);
    expect(match('Claude-Opus-5')).toBe(0);
    expect(match('cline-pass/claude-sonnet-5')).toBe(1);
    expect(match('gpt-6.1')).toBe(2);
    expect(match('gpt-6x1')).toBe(-1);
  });
});

describe('model folding', () => {
  it('joins a group named like an existing model into that model series', () => {
    const folded = fold([record('gpt-6-sol', 10), record('codex/gpt-6-sol', 5)], [{ pattern: '*/gpt-6-sol', name: 'gpt-6-sol' }]);
    expect(folded.options).toEqual([{ value: 'gpt-6-sol', label: 'gpt-6-sol' }]);
    expect(folded.members.get('gpt-6-sol')).toEqual(['gpt-6-sol', 'codex/gpt-6-sol']);
    expect(folded.records.map(item => item.group)).toEqual(['gpt-6-sol', 'gpt-6-sol']);
  });

  it('folds series below the share into Other, but never a lone one', () => {
    const records = [record('big', 1000), record('small-a', 3), record('small-b', 2)];
    const folded = fold(records, [], 1);
    expect(folded.options.map(option => option.value)).toEqual(['big', OTHER_SERIES_ID]);
    expect(folded.members.get(OTHER_SERIES_ID)).toEqual(['small-a', 'small-b']);
    expect(fold(records.slice(0, 2), [], 1).options.map(option => option.value)).toEqual(['big', 'small-a']);
  });
});
