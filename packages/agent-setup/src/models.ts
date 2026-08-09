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

// `max_tokens` is the model's CONTEXT WINDOW — the field says so, and Zed
// derives the prompt budget from it by subtracting the output reservation:
// `max_token_count().saturating_sub(max_output_tokens)`. (`max_input_tokens`
// inside anthropic::Model is a misnomer; it is only what `max_token_count()`
// returns.) The subtraction is why a bare prompt limit cannot go here: below
// 80_000 of derived headroom Zed switches auto-compaction off entirely and just
// warns, so a 216k/128k/64k model sent its prompt limit would leave 64k and
// lose compaction on a model that has room for it. Zed has nothing to fall back
// to either — a model without this fails deserialization and takes the whole
// provider down — so the absent case is ours to state.
// Refs: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/settings_content/src/language_model.rs#L56-L57
//       https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent/src/thread.rs#L4383-L4390
//       https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent/src/thread.rs#L124
const ZED_FALLBACK_CONTEXT_TOKENS = 200_000;

// Zed asks this threshold twice, of two different numbers. Auto-compaction is
// enabled when `max_tokens - max_output_tokens` reaches it; the small-context
// warning is suppressed when the RAW `max_tokens` reaches it. Between them lies
// a band where a model gets neither — no compaction, and no callout saying why.
// Refs: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent/src/thread.rs#L4383-L4390
//       https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent_ui/src/conversation_view/thread_view.rs#L11841-L11847
const ZED_MIN_COMPACTION_CONTEXT_WINDOW = 80_000;

// Anthropic rejects a thinking budget below this, so a smaller one is not a
// budget Zed can use — and `budget_tokens.min` is only a lower bound an
// operator may legitimately record as 0, meaning "no lower bound stated".
// Ref: https://docs.claude.com/en/docs/build-with-claude/extended-thinking
const ANTHROPIC_MIN_THINKING_BUDGET = 1024;

// The `max_tokens` Zed sends when a model announces no output limit. The budget
// has to stay under whatever Zed puts there, and Zed neither clamps the budget
// nor derives max_tokens from it.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/language_models/src/provider/anthropic_compatible.rs#L72
const ZED_FALLBACK_MAX_OUTPUT_TOKENS = 4096;

// Thinking mode carries a usable budget or is not written at all: Zed
// serializes `Thinking::Enabled.budget_tokens` with no skip_serializing_if, so
// a mode without one puts `"budget_tokens": null` on the Messages request and
// every call 400s — and a mode with an unusable one 400s just as reliably, with
// nothing in Zed's UI to say why.
//
// Usable means both bounds Anthropic states: at least its minimum, and strictly
// below the `max_tokens` Zed will send, which is the model's own output limit
// or 4096 when it declares none. The floor is preferred over the ceiling
// because Zed sends the value verbatim on every request; a floor that does not
// qualify falls through to the ceiling, and a model with neither stays in
// Default mode, which the picker still offers.
// Refs: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/anthropic/src/anthropic.rs#L750-L755
//       https://docs.claude.com/en/docs/build-with-claude/extended-thinking
const zedThinkingMode = (
  reasoning: ChatModelInfo['reasoning'],
  maxOutputTokens: number | undefined,
): ZedModel['mode'] => {
  if (reasoning === undefined) return undefined;
  if (reasoning.adaptive === true) return { type: 'adaptive' };
  const ceiling = maxOutputTokens ?? ZED_FALLBACK_MAX_OUTPUT_TOKENS;
  const usable = [reasoning.budget_tokens?.min, reasoning.budget_tokens?.max]
    .find(budget => budget !== undefined && budget >= ANTHROPIC_MIN_THINKING_BUDGET && budget < ceiling);
  return usable === undefined ? undefined : { type: 'thinking', budget_tokens: usable };
};

// Chat models only, and selected by `kind` rather than by `endpoints`: the
// endpoint map is the upstream wire surface, while translation lets any chat
// model serve a Messages request. Unlisted rows are dropped because they are
// addressable but absent from the catalog a setup run is meant to mirror.
const chatModels = (models: readonly PublicModel[]): PublicModel[] =>
  models.filter(model => model.kind === 'chat' && model.unlisted !== true);

// Zed subtracts its output reservation from this to get the prompt budget, so a
// catalog stating a prompt limit gets that limit plus the reservation back. The
// stated window is not usable in its place: on a live Copilot catalog the
// window equals prompt + output for most rows and is smaller for a third of
// them, and where it is larger it is often a merged 1M Claude variant the
// editors cannot reach — all of which would have Zed plan against headroom the
// upstream will not honour.
//
// Except below the compaction threshold, where adding the reservation would
// carry the raw value over it while the derived value stays under: compaction
// off AND the warning suppressed, which is the silent degradation this whole
// reconstruction exists to avoid. There the stated prompt limit goes out alone,
// so the callout fires. The budget is then conservative by the reservation,
// which costs nothing — compaction is already unavailable at that size.
const zedContextWindow = (limits: PublicModel['limits']): number => {
  const prompt = limits.max_prompt_tokens;
  if (prompt === undefined) return limits.max_context_window_tokens ?? ZED_FALLBACK_CONTEXT_TOKENS;
  if (prompt < ZED_MIN_COMPACTION_CONTEXT_WINDOW) return prompt;
  return prompt + (limits.max_output_tokens ?? ZED_FALLBACK_MAX_OUTPUT_TOKENS);
};

export const projectZedModels = (models: readonly PublicModel[]): ZedModel[] =>
  chatModels(models).map(model => {
    const mode = zedThinkingMode(model.chat?.reasoning, model.limits.max_output_tokens);
    return {
      name: model.id,
      display_name: model.display_name,
      max_tokens: zedContextWindow(model.limits),
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
