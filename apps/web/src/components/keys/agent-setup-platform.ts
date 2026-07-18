export const AGENT_SETUP_PLATFORMS = ['unix', 'windows'] as const;
export type AgentSetupPlatform = typeof AGENT_SETUP_PLATFORMS[number];

export const detectAgentSetupPlatform = (
  platform: string,
  userAgent: string,
): AgentSetupPlatform => /windows|win32|win64|wince/i.test(`${platform} ${userAgent}`)
  ? 'windows'
  : 'unix';
