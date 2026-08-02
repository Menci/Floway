import type { InferResponseType } from 'hono/client';

import type { api } from '../../api/client';

export type AgentSetupLease = Extract<InferResponseType<typeof api.api.setup.$put>, { status: 'ok' }>;
export type AgentSetupConfiguration = AgentSetupLease['configuration'];

export const defaultAgentSetupConfiguration = (): AgentSetupConfiguration => ({
  apiKeyId: '',
  claudeCode: {
    model: null,
    defaultFableModel: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    cleanupPeriodDays: null,
    optOutAiAttribution: false,
    modelDiscovery: true,
  },
  codex: { model: null, reasoningEffort: null },
});

export const cloneAgentSetupConfiguration = (
  configuration: AgentSetupConfiguration,
): AgentSetupConfiguration => structuredClone(configuration);

export type AgentSetupPlatform = 'unix' | 'windows';

export const detectAgentSetupPlatform = (
  platform: string,
  userAgent: string,
): AgentSetupPlatform => /windows|win32|win64|wince/i.test(`${platform} ${userAgent}`)
  ? 'windows'
  : 'unix';

const copyChangedFields = <T extends object>(target: T, current: T, baseline: T) => {
  for (const key of Object.keys(current) as (keyof T)[]) {
    if (!Object.is(current[key], baseline[key])) target[key] = current[key];
  }
};

export const applyLocalAgentSetupChanges = (
  server: AgentSetupConfiguration,
  local: AgentSetupConfiguration,
  baseline: AgentSetupConfiguration,
  apiKeyId: string,
): AgentSetupConfiguration => {
  const merged = cloneAgentSetupConfiguration(server);
  copyChangedFields(merged.claudeCode, local.claudeCode, baseline.claudeCode);
  copyChangedFields(merged.codex, local.codex, baseline.codex);
  merged.apiKeyId = apiKeyId;
  return merged;
};

export const codexUnixCredentialSnippet = (apiKey: string) => {
  const quoted = `'${apiKey.replaceAll("'", `'"'"'`)}'`;
  return [
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home" && \\',
    `  printf '%s' ${quoted} > "$codex_home/floway-token" && \\`,
    '  chmod 600 "$codex_home/floway-token"',
  ].join('\n');
};

export const codexWindowsCredentialSnippet = (apiKey: string) => {
  const quoted = `'${apiKey.replaceAll("'", "''")}'`;
  return [
    '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
    'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
    `[IO.File]::WriteAllText((Join-Path $codexHome "floway-token"), ${quoted}, (New-Object Text.UTF8Encoding($false)))`,
  ].join('\n');
};
