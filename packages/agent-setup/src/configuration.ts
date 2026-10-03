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

// Zed and VS Code address a Floway instance by a display name the operator
// chooses. Zed keys its `language_models.anthropic_compatible` map by it and
// VS Code names a `chatLanguageModels.json` group with it, so one value serves
// both. Neither derives behavior from it — Zed indexes stored credentials by
// `api_url` and VS Code keys groups by `${vendor}:${name}` — so it stays an
// opaque label. Control characters are rejected here rather than
// flattened at render time because, unlike the API key label, this value is the
// operator's own input and a silent rewrite would misname their provider.
const editorProviderName = z.string()
  .min(1)
  .max(120)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), { message: 'must not contain control characters' })
  .refine(value => value.trim() === value, { message: 'must not have leading or trailing whitespace' });

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
  // Zed snapshots the model catalog at install time rather than discovering it
  // at runtime — its `anthropic_compatible` provider has no fetch path — so the
  // only persisted state is which instance the entry is named after.
  zed: z.object({
    providerName: editorProviderName,
  }).strict(),
  // VS Code snapshots for the same reason: `customendpoint` reads only `id`
  // from a `/models` response and drops every model it cannot type, so its
  // group enumerates the catalog instead.
  // Ref: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts#L145-L163
  vscode: z.object({
    providerName: editorProviderName,
    // `customendpoint` resolves a bare base URL to one of three API paths.
    // Floway serves all three for every model, so nothing about reachability
    // narrows the choice — but the paths do not carry the same request. The
    // reasoning effort an operator picks in VS Code rides the wire on
    // `chat-completions` and `responses`, and is dropped on `messages`, where
    // it is emitted only inside a thinking config built from budget
    // capabilities this vendor never forwards.
    // Ref: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L22-L59
    apiType: z.enum(['chat-completions', 'responses', 'messages']),
  }).strict(),
}).strict();

export type AgentSetupConfiguration = z.infer<typeof agentSetupConfigurationSchema>;

// The product name reads naturally as an editor provider label and is what a
// first-time operator expects to see in the model picker.
const DEFAULT_EDITOR_PROVIDER_NAME = 'Floway';

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
  zed: {
    providerName: DEFAULT_EDITOR_PROVIDER_NAME,
  },
  vscode: {
    providerName: DEFAULT_EDITOR_PROVIDER_NAME,
    // Anthropic Messages, because `customendpoint` reaches it without the
    // experiment flag the Copilot-hosted models need. It carries no thinking
    // budget — that config is built from capabilities `customendpoint` never
    // forwards — and, because the effort level is emitted only inside that
    // same config, no reasoning effort either: the picker VS Code renders from
    // `supportsReasoningEffort` still records a choice, and this path does not
    // send it. `chat-completions` sends it whenever the model declares the
    // levels, with no thinking gate at all.
    // Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L156-L171
    //       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/platform/endpoint/node/messagesApi.ts#L204-L246
    //       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/platform/endpoint/node/chatEndpoint.ts#L225-L228
    //       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/common/byokProvider.ts#L146-L176
    apiType: 'messages',
  },
});
