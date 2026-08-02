import { describe, expect, it } from 'vitest';

import { detectAgentSetupPlatform } from '../../../src/components/api-keys/agent-setup';

describe('Agent Setup platform detection', () => {
  it('detects Windows from either browser signal', () => {
    expect(detectAgentSetupPlatform('Win32', '')).toBe('windows');
    expect(detectAgentSetupPlatform('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectAgentSetupPlatform('MacIntel', 'Mozilla/5.0 (Macintosh)')).toBe('unix');
  });
});
