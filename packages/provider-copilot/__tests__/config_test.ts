import { expect, test } from 'vitest';

import { parseCopilotUpstreamConfig } from '../src/config.ts';

const fieldError = (field: string, expected: string): Error => new TypeError(`${field} must be ${expected}`);

test('parseCopilotUpstreamConfig canonicalizes credential fields without rewriting GitHub identity data', () => {
  expect(parseCopilotUpstreamConfig({
    githubHost: ' OCTOCORP.GHE.COM ',
    githubToken: '  ghu_test  ',
    user: { login: 'octo', avatar_url: '', name: null, id: 42 },
  }, fieldError)).toEqual({
    githubHost: 'octocorp.ghe.com',
    githubToken: 'ghu_test',
    user: { login: 'octo', avatar_url: '', name: null, id: 42 },
  });
});

test.each([
  ['a scalar config', null, 'config must be an object'],
  ['a blank token', { githubHost: 'github.com', githubToken: '  ', user: { login: 'octo', avatar_url: '', name: null, id: 42 } }, 'githubToken must be a non-empty string'],
  ['an array user', { githubHost: 'github.com', githubToken: 'ghu', user: [] }, 'user must be an object'],
  ['an unsafe integer id', { githubHost: 'github.com', githubToken: 'ghu', user: { login: 'octo', avatar_url: '', name: null, id: Number.MAX_SAFE_INTEGER + 1 } }, 'user.id must be an integer'],
  ['an invalid host', { githubHost: 'api.github.com', githubToken: 'ghu', user: { login: 'octo', avatar_url: '', name: null, id: 42 } }, 'githubHost must be github.com or a tenant hostname ending in .ghe.com'],
] as const)('parseCopilotUpstreamConfig rejects %s', (_label, value, message) => {
  expect(() => parseCopilotUpstreamConfig(value, fieldError)).toThrow(message);
});
