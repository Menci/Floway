// This schema owns the selected API key and agent preferences stored in
// `agent_setup.configuration_json` and carried by control-plane requests.
// Null model overrides clear managed selections; null Pi thinking and Pi/OMP
// retry preferences preserve the existing agent-wide settings.
//
// Model identifiers and Codex effort strings remain vendor-independent opaque
// values. Empty model and effort strings cannot stand in for null, and NUL
// cannot pass through the native shell argument boundary.

import { z } from 'zod';

import { piThinkingLevels } from './pi-thinking.ts';

const opaqueOptionalString = z.string()
  .min(1)
  .refine(value => !value.includes('\0'), { message: 'must not contain a NUL character' })
  .nullable();

export const resolveAgentSetupProvider = (provider: string): string => provider || 'floway';

export const agentSetupProviderSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/);

const retrySchema = z.object({ enabled: z.boolean().nullable(), maxRetries: z.number().int().nonnegative().nullable() }).strict();

export const agentSetupConfigurationSchema = z.object({
  apiKeyId: z.string().min(1),
  claudeCode: z.object({
    model: opaqueOptionalString,
    defaultFableModel: opaqueOptionalString,
    defaultOpusModel: opaqueOptionalString,
    defaultSonnetModel: opaqueOptionalString,
    defaultHaikuModel: opaqueOptionalString,
    // Claude Code's reasoning effort is a closed Floway-side enum the installer
    // maps to the top-level `effortLevel` setting, unlike Codex's open,
    // upstream-owned effort string.
    // Ref: https://docs.claude.com/en/docs/claude-code/settings
    effortLevel: z.enum(['low', 'medium', 'high', 'xhigh']).nullable(),
    // cleanupPeriodDays is a numeric top-level Claude setting. Floway offers
    // long-lived presets while null means the managed setting is omitted.
    // Ref: https://code.claude.com/docs/en/settings#available-settings
    cleanupPeriodDays: z.union([z.literal(180), z.literal(365), z.literal(99999)]).nullable(),
    // When enabled, the installer writes Claude's documented attribution
    // opt-out values; false omits every managed attribution key.
    // Ref: https://code.claude.com/docs/en/settings#attribution-settings
    optOutAiAttribution: z.boolean(),
    // Claude enables auto memory and the agent view by default, so Floway
    // models both as opt-outs: true writes the documented disabling value,
    // false omits the managed key and leaves Claude's default in force.
    // Ref: https://code.claude.com/docs/en/settings#available-settings
    disableAutoMemory: z.boolean(),
    disableAgentView: z.boolean(),
    modelDiscovery: z.boolean(),
  }).strict(),
  codex: z.object({
    model: opaqueOptionalString,
    reasoningEffort: opaqueOptionalString,
  }).strict(),
  pi: z.object({ model: opaqueOptionalString, provider: agentSetupProviderSchema.or(z.literal('')), thinkingLevel: z.enum(piThinkingLevels).nullable(), retry: retrySchema }).strict(),
  omp: z.object({ model: opaqueOptionalString, provider: agentSetupProviderSchema.or(z.literal('')), retry: retrySchema }).strict(),
}).strict();

export type AgentSetupConfiguration = z.infer<typeof agentSetupConfigurationSchema>;

// First-use configuration enables Claude model discovery and leaves every
// model and effort override unset, so creating a lease needs no model catalog.
export const defaultAgentSetupConfiguration = (apiKeyId: string): AgentSetupConfiguration => ({
  apiKeyId,
  claudeCode: {
    model: null,
    defaultFableModel: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    cleanupPeriodDays: null,
    optOutAiAttribution: false,
    disableAutoMemory: false,
    disableAgentView: false,
    modelDiscovery: true,
  },
  codex: {
    model: null,
    reasoningEffort: null,
  },
  pi: { model: null, provider: '', thinkingLevel: null, retry: { enabled: null, maxRetries: null } },
  omp: { model: null, provider: '', retry: { enabled: null, maxRetries: null } },
});
