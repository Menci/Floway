// The persisted Agent Setup preference: which existing Floway API key a setup
// URL serves, and how each downstream agent CLI should be configured. This
// schema is the single source of truth for the shape stored in the
// `agent_setup` row's `configuration_json` and for the request bodies that
// carry it across the control plane.
//
// Optional model / effort slots are nullable, never empty strings: `null`
// means "leave this override unset" and the installer removes the managed key,
// while an empty string would ambiguously ask to write "". Model IDs and the
// Codex reasoning-effort value stay opaque per the gateway's protocol-opacity
// rule — the schema only rejects the two characters that cannot survive
// shell/PowerShell literal rendering (empty and NUL), never a vendor family.

import { z } from 'zod';

// A model ID or Codex reasoning-effort value: opaque, non-empty, and free of
// NUL so it renders into a single-quoted shell/PowerShell literal. `null`
// carries the "no override" meaning.
const opaqueOptionalString = z.string()
  .min(1)
  .refine(value => !value.includes('\0'), { message: 'must not contain a NUL character' })
  .nullable();

// Claude Code's reasoning-effort control is a closed Floway-side enum the
// installer maps to the top-level `effortLevel` setting; unlike Codex's open
// effort string it is not an upstream-owned protocol slot.
const claudeEffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh']).nullable();

export const agentSetupConfigurationSchema = z.object({
  apiKeyId: z.string().min(1),
  claudeCode: z.object({
    enabled: z.boolean(),
    model: opaqueOptionalString,
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
// API key. The route surface turns this into a typed "create a key first"
// response rather than fabricating a lease against a key that cannot serve.
export class AgentSetupNoSelectableKeyError extends Error {
  constructor() {
    super('No selectable API key is available for agent setup');
    this.name = 'AgentSetupNoSelectableKeyError';
  }
}

// First-use configuration: select the first selectable key, enable both
// agents, enable Claude gateway model discovery, and leave every model / effort
// override unset. Model defaults are a dashboard presentation concern chosen
// from the native-first sorted catalog; the persisted first-use row carries no
// model, so creating a lease never needs the model catalog. The caller decides
// which keys are selectable (active, owned) and passes them in order.
export const defaultAgentSetupConfiguration = (
  keys: readonly { id: string }[],
): AgentSetupConfiguration => {
  const first = keys[0];
  if (first === undefined) throw new AgentSetupNoSelectableKeyError();
  return {
    apiKeyId: first.id,
    claudeCode: {
      enabled: true,
      model: null,
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
