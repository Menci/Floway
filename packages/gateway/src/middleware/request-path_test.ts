import { expect, test } from 'vitest';

import { isPublicSetupScriptRequest, redactSetupTokenPath } from './request-path.ts';

const TOKEN = 'A'.repeat(43);

test('isPublicSetupScriptRequest matches only GET/HEAD on an exact 43-char token', () => {
  expect(isPublicSetupScriptRequest('GET', `/api/setup/${TOKEN}/setup.sh`)).toBe(true);
  expect(isPublicSetupScriptRequest('HEAD', `/api/setup/${TOKEN}/setup.ps1`)).toBe(true);
});

test('isPublicSetupScriptRequest rejects other methods', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    expect(isPublicSetupScriptRequest(method, `/api/setup/${TOKEN}/setup.sh`)).toBe(false);
  }
});

test('isPublicSetupScriptRequest rejects a token of the wrong length or alphabet', () => {
  expect(isPublicSetupScriptRequest('GET', `/api/setup/${'A'.repeat(42)}/setup.sh`)).toBe(false);
  expect(isPublicSetupScriptRequest('GET', `/api/setup/${'A'.repeat(44)}/setup.sh`)).toBe(false);
  expect(isPublicSetupScriptRequest('GET', `/api/setup/${'A'.repeat(42)}./setup.sh`)).toBe(false);
});

test('isPublicSetupScriptRequest rejects other filenames and extra path segments', () => {
  expect(isPublicSetupScriptRequest('GET', `/api/setup/${TOKEN}/setup.txt`)).toBe(false);
  expect(isPublicSetupScriptRequest('GET', `/api/setup/${TOKEN}/setup.sh/extra`)).toBe(false);
  expect(isPublicSetupScriptRequest('GET', `/api/setup/${TOKEN}`)).toBe(false);
});

test('redactSetupTokenPath scrubs the token segment', () => {
  expect(redactSetupTokenPath(`/api/setup/${TOKEN}/setup.sh`)).toBe('/api/setup/[redacted]/setup.sh');
  expect(redactSetupTokenPath(`/api/setup/${TOKEN}/setup.ps1`)).toBe('/api/setup/[redacted]/setup.ps1');
});

test('redactSetupTokenPath scrubs a malformed token too, never echoing it', () => {
  expect(redactSetupTokenPath('/api/setup/short-token/setup.sh')).toBe('/api/setup/[redacted]/setup.sh');
});

test('redactSetupTokenPath leaves unrelated paths untouched', () => {
  expect(redactSetupTokenPath('/api/keys')).toBe('/api/keys');
  expect(redactSetupTokenPath('/api/setup')).toBe('/api/setup');
  expect(redactSetupTokenPath('/api/setup/heartbeat')).toBe('/api/setup/heartbeat');
});
