export const agentSetupPlatforms = ['unix', 'windows'] as const;
export type AgentSetupPlatform = typeof agentSetupPlatforms[number];

export const detectAgentSetupPlatform = (
  platform: string,
  userAgent: string,
): AgentSetupPlatform => /windows|win32|win64|wince/i.test(`${platform} ${userAgent}`)
  ? 'windows'
  : 'unix';
