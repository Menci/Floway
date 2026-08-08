// Editor model projections. Zed's `anthropic_compatible` provider and VS Code's
// `customendpoint` vendor both take a snapshot of the catalog at setup time —
// neither can discover models at runtime — so the gateway projects the catalog
// once here and embeds the result in the script it serves.
//
// This is deliberately the only implementation. It previously existed three
// times over: a jq program, a PowerShell loop, and a dashboard preview builder,
// which had to agree byte for byte and repeatedly did not — a stated limit of
// `0` became a fallback under PowerShell truthiness, an empty effort list was
// dropped, and key order drifted. One projection cannot disagree with itself.
//
// Two values are deliberately absent from what this produces. The endpoint URL
// is not here because the gateway never renders its own public origin — the
// dashboard injects it into the executing shell, and the installer's merge
// supplies it. The API key is not here because it already appears once in the
// script, and copying it into every model entry would multiply the credential
// through a file for no gain. The installer's merge supplies both.

import type { ChatModelInfo, PublicModel } from '@floway-dev/protocols/common';

// One entry of Zed's `available_models`. `name` and `max_tokens` are required by
// Zed; `capabilities` is `#[serde(default)]` but its three booleans carry no
// per-field default, so a partial object fails the whole provider.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/settings_content/src/language_model.rs#L49-L87
export interface ZedModel {
  name: string;
  display_name: string;
  max_tokens: number;
  max_output_tokens?: number;
  capabilities: { tools: boolean; images: boolean; prompt_caching: boolean };
  mode?: { type: 'adaptive' } | { type: 'thinking'; budget_tokens: number };
}

// Zed requires `max_tokens` and does no token counting of its own, so a model
// whose catalog states no window still needs a number. This is the window Zed's
// own Anthropic-compatible provider assumes for an unknown model.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/anthropic/src/anthropic.rs#L60-L74
const ZED_FALLBACK_CONTEXT_TOKENS = 200_000;

// Anthropic rejects a thinking budget below this, so a smaller one is not a
// budget Zed can use — and `budget_tokens.min` is only a lower bound an
// operator may legitimately record as 0, meaning "no lower bound stated".
// Ref: https://docs.claude.com/en/docs/build-with-claude/extended-thinking
const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

// Thinking mode carries a usable budget or is not written at all: Zed
// serializes `Thinking::Enabled.budget_tokens` with no skip_serializing_if, so
// a mode without one puts `"budget_tokens": null` on the Messages request and
// every call 400s — and a mode with an unusable one 400s just as reliably, with
// nothing in Zed's UI to say why. The floor is preferred over the ceiling
// because Zed sends the value verbatim on every request and Anthropic requires
// it below max_tokens; a floor too small to use falls through to the ceiling.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/anthropic/src/anthropic.rs#L750-L755
const zedThinkingMode = (reasoning: ChatModelInfo['reasoning']): ZedModel['mode'] => {
  if (reasoning === undefined) return undefined;
  if (reasoning.adaptive === true) return { type: 'adaptive' };
  const usable = [reasoning.budget_tokens?.min, reasoning.budget_tokens?.max]
    .find(budget => budget !== undefined && budget >= ANTHROPIC_MIN_THINKING_BUDGET);
  return usable === undefined ? undefined : { type: 'thinking', budget_tokens: usable };
};

// Chat models only, and selected by `kind` rather than by `endpoints`: the
// endpoint map is the upstream wire surface, while translation lets any chat
// model serve a Messages request. Unlisted rows are dropped because they are
// addressable but absent from the catalog a setup run is meant to mirror.
const chatModels = (models: readonly PublicModel[]): PublicModel[] =>
  models.filter(model => model.kind === 'chat' && model.unlisted !== true);

export const projectZedModels = (models: readonly PublicModel[]): ZedModel[] =>
  chatModels(models).map(model => {
    const mode = zedThinkingMode(model.chat?.reasoning);
    return {
      name: model.id,
      display_name: model.display_name,
      max_tokens: model.limits.max_context_window_tokens
        ?? model.limits.max_prompt_tokens
        ?? ZED_FALLBACK_CONTEXT_TOKENS,
      capabilities: {
        // A chat model that cannot call tools is not one anyone routes here.
        tools: true,
        images: model.chat?.modalities?.input.includes('image') ?? false,
        // Zed defaults this off, which suppresses cache_control breakpoints
        // entirely; on, it marks where the stable prefix ends.
        prompt_caching: true,
      },
      ...(model.limits.max_output_tokens === undefined ? {} : { max_output_tokens: model.limits.max_output_tokens }),
      ...(mode === undefined ? {} : { mode }),
    };
  });

// The three API paths `customendpoint` resolves a bare base URL to. Floway
// serves all of them for every model, so this is one group-wide preference
// rather than something derived per model.
// Ref: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/vscode-node/customEndpointProvider.ts#L22-L59
export type VSCodeApiType = 'chat-completions' | 'responses' | 'messages';

// One entry of a VS Code `customendpoint` group's `models`. `id`, `name`,
// `url`, `toolCalling`, `vision` and `maxOutputTokens` are required, and one of
// `maxInputTokens` or `contextWindow` must be present. `url` is absent here and
// supplied by the installer's merge, for the reason given at the top of this
// file. Output tokens are clamped to the context window by VS Code itself.
// Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/package.json#L2190-L2209
//       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/common/byokProvider.ts#L125-L134
export interface VSCodeModel {
  id: string;
  name: string;
  toolCalling: boolean;
  vision: boolean;
  maxOutputTokens: number;
  contextWindow: number;
  thinking?: boolean;
  supportsReasoningEffort?: string[];
  reasoningEffortFormat?: VSCodeApiType;
}

// VS Code reconciles these against each other, clamping output to the window,
// so a model announcing neither still needs both.
const VSCODE_FALLBACK_CONTEXT_TOKENS = 128_000;
const VSCODE_FALLBACK_OUTPUT_TOKENS = 8192;

export const projectVSCodeModels = (
  models: readonly PublicModel[],
  apiType: VSCodeApiType,
): VSCodeModel[] =>
  chatModels(models).map(model => {
    const reasoning = model.chat?.reasoning;
    const supportedEfforts = reasoning?.effort?.supported;
    return {
      id: model.id,
      name: model.display_name,
      // A chat model that cannot call tools is not one anyone routes here, and
      // without this VS Code drops it from agent mode and inline chat.
      // Refs: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/common/languageModels.ts#L342-L346
      //       https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/src/vs/workbench/contrib/chat/browser/widget/input/chatInputModelUtils.ts#L63-L72
      toolCalling: true,
      vision: model.chat?.modalities?.input.includes('image') ?? false,
      maxOutputTokens: model.limits.max_output_tokens ?? VSCODE_FALLBACK_OUTPUT_TOKENS,
      contextWindow: model.limits.max_context_window_tokens
        ?? model.limits.max_prompt_tokens
        ?? VSCODE_FALLBACK_CONTEXT_TOKENS,
      ...(reasoning === undefined ? {} : { thinking: true }),
      ...(supportedEfforts === undefined
        ? {}
        : { supportsReasoningEffort: [...supportedEfforts], reasoningEffortFormat: apiType }),
    };
  });
