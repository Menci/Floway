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

// Both opaque ids describe a channel, so neither may leak into a published id.
test.each([
  ['kimi-for-coding', 'K2.8 Preview', 'kimi-k2.8-preview'],
  ['kimi-for-coding-highspeed', 'K2.7 Code Highspeed', 'kimi-k2.7-code-highspeed'],
  ['kimi-for-coding-highspeed', 'K9.9', 'kimi-k9.9-highspeed'],
  ['kimi-for-coding-highspeed', 'K9.9 Preview', 'kimi-k9.9-preview-highspeed'],
  ['kimi-for-coding-highspeed', 'unrecognized', null],
])('opaque id %s with display name %s derives public id %s', (upstreamModelId, displayName, expected) => {
  expect(publicKimiCodeModelId(upstreamModelId, displayName)).toBe(expected);
});

test.each([
  ['k3', 'kimi-k3'],
  ['k3-256k', 'kimi-k3-256k'],
  ['k3.1-pro', 'kimi-k3.1-pro'],
  ['k3.1-pro-highspeed', 'kimi-k3.1-pro-highspeed'],
  ['arbitrary-model', 'kimi-arbitrary-model'],
])('catalog id %s is published as %s without parsing its display name', (upstreamModelId, expected) => {
  expect(publicKimiCodeModelId(upstreamModelId, 'a name with no version')).toBe(expected);
});
