import { expect, test } from 'vitest';

import { kimiCodeModelLabel, parseKimiCodeModelName, publicKimiCodeModelId } from '../src/public-model-id.ts';

const versions = ['K3', 'K4.2'];

test.each(versions.flatMap(version => ['', 'Preview', 'Code', 'Pro'].map(family => [version, family])))('opaque display names accept open version %s with closed family %s', (version, family) => {
  const displayName = `${version}${family === '' ? '' : ` ${family}`}`;
  const id = `kimi-${version.toLowerCase()}${family === '' ? '' : `-${family.toLowerCase()}`}`;
  expect(publicKimiCodeModelId('kimi-for-coding', displayName)).toBe(id);
  expect(parseKimiCodeModelName(displayName)).toEqual({ version: version.toLowerCase(), ...(family === '' ? {} : { family: family.toLowerCase() }) });
});

test.each([
  ['  K9.9 pReViEw  ', 'kimi-k9.9-preview'],
  ['K3.1 Pro Highspeed (2x Usage Cost)', 'kimi-k3.1-pro'],
])('opaque display-name derivation recognizes %s as %s', (displayName, expected) => {
  expect(publicKimiCodeModelId('kimi-for-coding-highspeed', displayName)).toBe(expected);
});

test.each([
  'a name with no version', 'K9.9 Experimental', 'K3 Preview Highspeed', 'K3 Code extra prose', 'K3.1Pro', '',
])('opaque derivation and shared identity parsing reject the unrecognized shape %s', displayName => {
  expect(publicKimiCodeModelId('kimi-for-coding', displayName)).toBeNull();
  expect(parseKimiCodeModelName(displayName)).toBeNull();
});

test.each([
  ['k3', 'kimi-k3'],
  ['k3.1-pro-highspeed', 'kimi-k3.1-pro'],
])('non-opaque raw catalog id %s publishes %s independently of the display-name grammar', (upstreamModelId, expected) => {
  expect(publicKimiCodeModelId(upstreamModelId, 'a name with no version')).toBe(expected);
});

test.each(versions.flatMap(version => ['', 'Preview', 'Code', 'Pro'].map(family => [version, family])))('presentation normalizes version %s and family %s independently of identity', (version, family) => {
  const expected = `Kimi ${version}${family === '' ? '' : ` ${family}`}`;
  const name = `${version}${family === '' ? '' : ` ${family}`}`;
  for (const variant of [name, `Kimi ${name}`, `kImI ${name.toLowerCase()}`, name.toLowerCase().replace(' ', '-'), name.replace('Pro', 'pRo'), `  ${name.toLowerCase().replace(' ', '   ')}  `]) {
    for (const suffix of ['', ' hIgHsPeEd 2x Usage Cost', ' (Highspeed 2x Usage Cost)']) {
      expect(kimiCodeModelLabel(`${variant}${suffix}`)).toBe(expected);
    }
  }
});

test.each([
  ['k9.9 eXpErImEnTaL', 'Kimi K9.9 eXpErImEnTaL'],
  ['Kimi K3 Mini (Highspeed 2x Usage Cost)', 'Kimi K3 Mini'],
  ['Kimiko Ultra', 'Kimi Kimiko Ultra'],
  ['K3 HighspeedX', 'Kimi K3 HighspeedX'],
])('presentation labels %s as %s without broadening model identity', (name, expected) => {
  expect(kimiCodeModelLabel(name)).toBe(expected);
  expect(parseKimiCodeModelName(name)).toBeNull();
});

test.each(['   ', ' KIMI ', 'Kimi (Highspeed 2x Usage Cost)'])('presentation rejects empty or marker-only name %j', name => {
  expect(() => kimiCodeModelLabel(name)).toThrow(TypeError);
});
