import { expect, test } from 'vitest';

import { publicKimiCodeModelId } from '../src/public-model-id.ts';

test.each([
  ['K9.9', 'kimi-k9.9'],
  ['  K9.9 pReViEw  ', 'kimi-k9.9-preview'],
  [' K12.34 Code ', 'kimi-k12.34-code'],
  ['a name with no version', null],
  ['K9.9 Experimental', null],
  ['K9', null],
  ['Other K9.9', null],
])('the coding alias display name %s derives public id %s', (displayName, expected) => {
  expect(publicKimiCodeModelId('kimi-for-coding', displayName)).toBe(expected);
});

test('other catalog ids are prefixed without parsing their display name', () => {
  expect(publicKimiCodeModelId('arbitrary-model', 'a name with no version')).toBe('kimi-arbitrary-model');
});
