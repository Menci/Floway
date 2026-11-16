import { expect, test } from 'vitest';

import { parseKimiCodeModelName, publicKimiCodeModelId } from '../src/public-model-id.ts';

const versions = ['K2.7', 'K2.8', 'K3', 'K3.1', 'K4', 'K4.2'];

test.each(versions.flatMap(version => ['', 'Preview', 'Code', 'Pro'].map(family => [version, family])))('opaque display names accept open version %s with closed family %s', (version, family) => {
  const displayName = `${version}${family === '' ? '' : ` ${family}`}`;
  const id = `kimi-${version.toLowerCase()}${family === '' ? '' : `-${family.toLowerCase()}`}`;
  expect(publicKimiCodeModelId('kimi-for-coding', displayName)).toBe(id);
  expect(parseKimiCodeModelName(displayName)).toEqual({ version: version.toLowerCase(), ...(family === '' ? {} : { family: family.toLowerCase() }) });
});

test.each(versions.flatMap(version => ['', 'Code', 'Pro'].map(family => [version, family])))('opaque Highspeed names retain version %s and family %s without the lane marker', (version, family) => {
  const displayName = `${version}${family === '' ? '' : ` ${family}`} Highspeed`;
  const id = `kimi-${version.toLowerCase()}${family === '' ? '' : `-${family.toLowerCase()}`}`;
  expect(publicKimiCodeModelId('kimi-for-coding-highspeed', displayName)).toBe(id);
});

test.each([
  ['  K9.9 pReViEw  ', 'kimi-k9.9-preview'],
  ['K3.1 Pro Highspeed 2x Usage Cost', 'kimi-k3.1-pro'],
  ['K3.1 Pro Highspeed (2x Usage Cost)', 'kimi-k3.1-pro'],
  ['K4.2 Code Highspeed new advertising copy', 'kimi-k4.2-code'],
])('opaque display-name derivation recognizes %s as %s', (displayName, expected) => {
  expect(publicKimiCodeModelId('kimi-for-coding-highspeed', displayName)).toBe(expected);
});

test.each([
  'a name with no version', 'K9.9 Experimental', 'K4.2 Mini', 'Other K9.9',
  'K3 Preview Highspeed', 'K3.1 Preview Highspeed 2x Usage Cost', 'K3 Pro Preview',
  'K3 Code extra prose', 'K3 Pro 2x Usage Cost', 'K3-Highspeed', 'K3.1Pro',
  'K3.1 HighspeedX', 'Highspeed K3', '3.1 Pro', '',
])('opaque derivation and shared identity parsing reject the unrecognized shape %s', displayName => {
  expect(publicKimiCodeModelId('kimi-for-coding', displayName)).toBeNull();
  expect(parseKimiCodeModelName(displayName)).toBeNull();
});

test.each([
  ['k3', 'kimi-k3'],
  ['k3-256k', 'kimi-k3-256k'],
  ['k3.1-pro', 'kimi-k3.1-pro'],
  ['k3.1-pro-highspeed', 'kimi-k3.1-pro'],
  ['arbitrary-model', 'kimi-arbitrary-model'],
])('non-opaque raw catalog id %s publishes %s independently of the display-name grammar', (upstreamModelId, expected) => {
  expect(publicKimiCodeModelId(upstreamModelId, 'a name with no version')).toBe(expected);
});

test('the live non-opaque Highspeed row derives its id from the raw catalog id', () => {
  expect(publicKimiCodeModelId('k3.1-pro-highspeed', 'K3.1 Pro Highspeed 2x Usage Cost')).toBe('kimi-k3.1-pro');
});
