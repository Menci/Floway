// The persisted Agent Setup preference: which Floway API key a setup URL serves
// and how each agent CLI is configured. This schema is the single source of
// truth for the shape stored in `agent_setup.configuration_json` and for the
// request bodies that carry it across the control plane.
//
// Optional model/effort slots are nullable, never empty strings: `null` means
// "leave this override unset" (the installer removes the managed key), while ""
// would ambiguously ask to write an empty value. Per the gateway's
// protocol-opacity rule the schema rejects only the two characters an opaque
// value cannot survive as a shell/PowerShell literal — empty and NUL — never a
// vendor family.

import { z } from 'zod';

const opaqueOptionalString = z.string()
  .min(1)
  .refine(value => !value.includes('\0'), { message: 'must not contain a NUL character' })
  .nullable();

export const agentSetupConfigurationSchema = z.object({
  apiKeyId: z.string().min(1),
  claudeCode: z.object({
    model: opaqueOptionalString,
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
    modelDiscovery: z.boolean(),
  }).strict(),
  codex: z.object({
    model: opaqueOptionalString,
    reasoningEffort: opaqueOptionalString,
  }).strict(),
}).strict();

export type AgentSetupConfiguration = z.infer<typeof agentSetupConfigurationSchema>;

// First-use configuration enables Claude model discovery and leaves every
// model and effort override unset, so creating a lease needs no model catalog.
export const defaultAgentSetupConfiguration = (apiKeyId: string): AgentSetupConfiguration => ({
  apiKeyId,
  claudeCode: {
    model: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    cleanupPeriodDays: null,
    optOutAiAttribution: false,
    modelDiscovery: true,
  },
  codex: {
    model: null,
    reasoningEffort: null,
  },
});
