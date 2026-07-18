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
    modelDiscovery: true,
  },
  codex: {
    model: null,
    reasoningEffort: null,
  },
});
