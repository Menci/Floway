import { describe, expect, test } from 'vitest';

import { generateAgentSetupToken } from '../src/token.ts';

describe('generateAgentSetupToken', () => {
  test('emits 256 bits as RFC 4648 unpadded base64url', () => {
    const token = generateAgentSetupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain('=');
  });
});
