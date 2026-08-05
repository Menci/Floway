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

test('API key segments use the complete base62 alphabet through Nano ID', async () => {
  const randomBase62 = vi.fn()
    .mockReturnValueOnce('ABCDEFGHIJKLMNOPQRST')
    .mockReturnValueOnce('uvwxyz0123456789ABCD');
  const customAlphabet = vi.fn(() => randomBase62);
  vi.doMock('nanoid', () => ({ customAlphabet }));

  const { generateApiKeyToken } = await import('../../src/shared/api-key-tokens.ts');

  expect(customAlphabet).toHaveBeenCalledOnce();
  expect(customAlphabet).toHaveBeenCalledWith('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 20);
  const token = generateApiKeyToken();
  expect(token.slice(3, 23)).toBe('ABCDEFGHIJKLMNOPQRST');
  expect(token.slice(23, 31)).toBe('T3BlbkFJ');
  expect(token.slice(31)).toBe('uvwxyz0123456789ABCD');
  expect(randomBase62).toHaveBeenCalledTimes(2);
});
