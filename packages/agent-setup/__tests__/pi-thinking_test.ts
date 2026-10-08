import { expect, test } from 'vitest';

import { piThinkingLevelMap, piThinkingLevels } from '../src/pi-thinking.ts';

test('maps upstream open effort strings into the same native slots used by discovery and setup', () => {
  const mapped = piThinkingLevelMap({ effort: { supported: ['fast', 'balanced', 'deep'], default: 'balanced' }, mandatory: true }, 'custom-model');
  expect(mapped).toEqual({ supported: true, map: { off: null, minimal: null, low: 'fast', medium: 'balanced', high: 'deep', xhigh: null, max: null } });
  expect(piThinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('represents unsupported effort counts as an explicit result and keeps uncontrollable reasoning honest', () => {
  expect(piThinkingLevelMap({ effort: { supported: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], default: 'a' } }, 'model')).toEqual({ supported: false, message: 'Pi cannot represent all reasoning efforts for model model' });
  const mandatory = piThinkingLevelMap({ mandatory: true }, 'model');
  expect(mandatory.supported && Object.values(mandatory.map).every(value => value === null)).toBe(true);
  const adaptive = piThinkingLevelMap({ adaptive: true }, 'model');
  expect(adaptive.supported && adaptive.map.high).toBe('high');
});
