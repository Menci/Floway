import { describe, expect, it } from 'vitest';

import { autoGroupName, foldModelSeries, OTHER_SERIES_ID } from '../../../src/components/usage/model-groups';
import type { DisplayUsageRecord } from '../../../src/components/usage/types';

const record = (group: string, inputTokens: number): DisplayUsageRecord =>
  ({ bucket: 'b', group, requests: 1, metrics: { input_tokens: String(inputTokens) }, cost: null });

const fold = (records: DisplayUsageRecord[], { autoGroup = false, autoFold = false }) => foldModelSeries({
  records, models: [...new Set(records.map(item => item.group))], autoGroup, autoFold, metric: 'total', otherLabel: count => `Other (${count})`,
});

describe('automatic model grouping', () => {
  it('drops everything up to the last / and every trailing tier suffix, in any case', () => {
    expect(autoGroupName('cline-pass/deepseek-v4-pro-high')).toBe('deepseek-v4-pro');
    expect(autoGroupName('a/b/gpt-6-sol-xhigh-fast')).toBe('gpt-6-sol');
    expect(autoGroupName('moonshotai/Kimi-K2.7-Code-Highspeed')).toBe('Kimi-K2.7-Code');
    expect(autoGroupName('mimo-v2.6-pro-ultraspeed')).toBe('mimo-v2.6-pro-ultraspeed');
  });

  it('keeps a name the rule would empty', () => {
    expect(autoGroupName('high')).toBe('high');
    expect(autoGroupName('vendor/')).toBe('vendor/');
  });

  it('merges variants into one series labelled as the first one spells it', () => {
    const folded = fold([record('zai-org/GLM-5', 10), record('glm-5-fast', 5), record('codex/glm-5', 1)], { autoGroup: true });
    expect(folded.options).toEqual([{ value: 'glm-5', label: 'GLM-5' }]);
    expect(folded.members.get('glm-5')).toEqual(['zai-org/GLM-5', 'glm-5-fast', 'codex/glm-5']);
  });
});

describe('automatic folding', () => {
  it('folds series below the fixed share into Other, but never a lone one', () => {
    const records = [record('big', 1000), record('small-a', 3), record('small-b', 2)];
    const folded = fold(records, { autoFold: true });
    expect(folded.options.map(option => option.value)).toEqual(['big', OTHER_SERIES_ID]);
    expect(folded.members.get(OTHER_SERIES_ID)).toEqual(['small-a', 'small-b']);
    expect(fold(records.slice(0, 2), { autoFold: true }).options.map(option => option.value)).toEqual(['big', 'small-a']);
  });
});
