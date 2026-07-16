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

// Claude Code's reasoning effort is a closed Floway-side enum the installer maps
// to the top-level `effortLevel` setting, unlike Codex's open, upstream-owned
// effort string.
const claudeEffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh']).nullable();

export const agentSetupConfigurationSchema = z.object({
  apiKeyId: z.string().min(1),
  claudeCode: z.object({
    enabled: z.boolean(),
    model: opaqueOptionalString,
    defaultOpusModel: opaqueOptionalString,
    defaultSonnetModel: opaqueOptionalString,
    defaultHaikuModel: opaqueOptionalString,
    effortLevel: claudeEffortLevelSchema,
    modelDiscovery: z.boolean(),
  }).strict(),
  codex: z.object({
    enabled: z.boolean(),
    model: opaqueOptionalString,
    reasoningEffort: opaqueOptionalString,
  }).strict(),
}).strict();

export type AgentSetupConfiguration = z.infer<typeof agentSetupConfigurationSchema>;

// Thrown when a first-use default is requested but the user has no selectable
// API key, so the route can return a typed "create a key first" response
// instead of leasing against a key that cannot serve.
export class AgentSetupNoSelectableKeyError extends Error {
  constructor() {
    super('No selectable API key is available for agent setup');
    this.name = 'AgentSetupNoSelectableKeyError';
  }
}

// First-use configuration: select the first selectable key, enable both agents
// and Claude model discovery, and leave every model/effort override unset. The
// caller decides which key ids are selectable (active, owned) and passes them
// in priority order; the persisted row carries no model, so creating a lease
// never needs the model catalog.
export const defaultAgentSetupConfiguration = (
  selectableKeyIds: readonly string[],
): AgentSetupConfiguration => {
  const first = selectableKeyIds[0];
  if (first === undefined) throw new AgentSetupNoSelectableKeyError();
  return {
    apiKeyId: first,
    claudeCode: {
      enabled: true,
      model: null,
      defaultOpusModel: null,
      defaultSonnetModel: null,
      defaultHaikuModel: null,
      effortLevel: null,
      modelDiscovery: true,
    },
    codex: {
      enabled: true,
      model: null,
      reasoningEffort: null,
    },
  };
};
