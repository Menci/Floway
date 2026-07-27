import { expect, test } from 'vitest';

interface VueInputTag {
  path: string;
  tag: string;
}

interface PasswordDeclaration {
  path: string;
  line: number;
  text: string;
}

const sources = import.meta.glob('../src/**/*.vue', {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>;

const findInputTags = (): VueInputTag[] => Object
  .entries(sources)
  .flatMap(([path, source]) => [...source.matchAll(/<Input\b[\s\S]*?\/>/g)]
    .map(match => ({ path, tag: match[0] })));

const passwordInputs = () => findInputTags()
  .filter(input => /\btype="password"/.test(input.tag));

const passwordDeclarations = (): PasswordDeclaration[] => Object
  .entries(sources)
  .flatMap(([path, source]) => source
    .split('\n')
    .flatMap((line, index) => line.includes('type="password"')
      ? [{ path, line: index + 1, text: line.trim() }]
      : []));

test('the login password field remains eligible for credential autofill', () => {
  const loginPasswordInputs = passwordInputs()
    .filter(input => input.path === '../src/pages/login.vue');

  expect(loginPasswordInputs).toHaveLength(1);
  expect(loginPasswordInputs[0]!.tag).toContain('autocomplete="current-password"');
});

test('secret inputs outside login use the autofill-suppressed control', () => {
  const nonLoginPasswordInputs = passwordDeclarations()
    .filter(input => input.path !== '../src/pages/login.vue' && input.path !== '../src/components/shared/SecretInput.vue');

  expect(nonLoginPasswordInputs).toEqual([]);
});

test('the secret input control suppresses browser and password-manager autofill', () => {
  const secretInputSource = sources['../src/components/shared/SecretInput.vue'];

  expect(secretInputSource).toBeDefined();
  expect(secretInputSource).toContain('autocomplete="new-password"');
  expect(secretInputSource).toContain('data-1p-ignore="true"');
  expect(secretInputSource).toContain('data-lpignore="true"');
  expect(secretInputSource).toContain('data-bwignore="true"');
  expect(secretInputSource).toContain('data-form-type="other"');
  expect(secretInputSource).toContain(':readonly="readonly"');
});
