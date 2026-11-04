import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('nanoid');
  vi.resetModules();
});

test('generated API keys retain the public token shape', async () => {
  const { generateApiKeyToken } = await import('../../src/shared/api-key-tokens.ts');

  const token = generateApiKeyToken();

  expect(token).toHaveLength(51);
  expect(token).toMatch(/^sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}$/);
});
