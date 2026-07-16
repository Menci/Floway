import { describe, expect, it } from 'vitest';

import { detectAgentSetupPlatform } from './agent-setup-platform.ts';

describe('detectAgentSetupPlatform', () => {
  it('selects Windows from either navigator signal', () => {
    expect(detectAgentSetupPlatform('Win32', '')).toBe('windows');
    expect(detectAgentSetupPlatform('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
  });

  it('uses the Unix command for macOS, Linux, and unknown clients', () => {
    expect(detectAgentSetupPlatform('MacIntel', 'Mozilla/5.0 (Macintosh)')).toBe('unix');
    expect(detectAgentSetupPlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe('unix');
    expect(detectAgentSetupPlatform('', '')).toBe('unix');
  });
});
