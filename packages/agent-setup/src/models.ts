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
//
// It is also the reservation the compaction check subtracts, which is a
// different call site: `thread.rs` reads `max_output_tokens().unwrap_or(0)`, so
// the arithmetic below would be wrong were it not that the provider resolves
// the default to 4096 before the thread ever asks.
// Refs: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/language_models/src/provider/anthropic_compatible.rs#L72
//       https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent/src/thread.rs#L4383-L4390
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

// Zed subtracts its output reservation from `max_tokens` to get the prompt
// budget, and asks the 80_000 threshold of both numbers: compaction of the
// derived budget, the small-context warning of the raw window. A model must
// never land between them — compaction off with the callout suppressed is a
// silent degradation with nothing on screen to explain it.
//
// Which lever closes the band depends on whether the catalog states a prompt
// limit, because that decides whether the budget is ours to move:
//
//   - Stated. `max_tokens` is that limit plus the reservation, so the budget
//     comes back exactly as stated. Inside the band the window goes out one
//     token under the threshold with the reservation shrunk to fit beneath it,
//     which raises the callout and still leaves the budget at the stated limit;
//     raising the budget instead would have Zed plan against headroom the
//     upstream refuses. Where too little room remains under the threshold to
//     state a reservation worth stating, the limit goes alone and Zed's own
//     4096 applies. Below the band nothing is adjusted: the callout fires
//     either way.
//   - Not stated. The window is the only bound the catalog gave, so how it
//     splits is ours. In the band the reservation shrinks until the budget
//     reaches the threshold, which turns compaction on and leaves the total
//     untouched. This can take the reservation below a stated output limit —
//     responses get capped under what the upstream allows — which is the better
//     half of the trade: the alternative is losing compaction on a long thread
//     with nothing on screen saying why. Below Zed's own 4096 default the split
//     stops being worth stating — such a window is within a rounding error of
//     the threshold either way — so the window is lowered to raise the callout
//     instead. (A split does exist there: an 82_000 window reserving 2_000
//     compacts and stays quiet. It is not taken because a reservation that
//     small is a worse answer than the callout.)
//
// Refs: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent/src/thread.rs#L4383-L4390
//       https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent_ui/src/conversation_view/thread_view.rs#L11845
//
// A stated 0 is a value everywhere else in the catalog and no bound at all
// here. Zed's fields are required `u64`s it sends verbatim, with no encoding
// for "unknown": a 0 window is a 0-token context whose callout is suppressed by
// the ratio guard below — neither compaction nor warning, the band reached from
// the other side — and a 0 output limit becomes a Messages `max_tokens` of 0,
// which Anthropic rejects on every request. Negative and fractional values fail
// Zed's `u64` deserialization and take the whole settings document down with
// them, so they are refused here as well.
// Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/acp_thread/src/acp_thread.rs#L2042-L2043
const usableLimit = (value: number | undefined): number | undefined =>
  value === undefined || !Number.isInteger(value) || value <= 0 ? undefined : value;

const zedTokenPlan = (limits: PublicModel['limits']): { maxTokens: number; maxOutputTokens: number | undefined } => {
  const stated = usableLimit(limits.max_output_tokens);
  const reserved = stated ?? ZED_FALLBACK_MAX_OUTPUT_TOKENS;
  const prompt = usableLimit(limits.max_prompt_tokens);

  if (prompt !== undefined) {
    const inBand = prompt < ZED_MIN_COMPACTION_CONTEXT_WINDOW
      && prompt + reserved >= ZED_MIN_COMPACTION_CONTEXT_WINDOW;
    if (!inBand) return { maxTokens: prompt + reserved, maxOutputTokens: stated };
    // In the band the window goes out one token under the threshold so the
    // callout fires, and the reservation shrinks to fit beneath it — which
    // leaves the budget at exactly the stated prompt limit. Sending the limit
    // alone with the reservation untouched would instead subtract one from the
    // other: Copilot's o3-mini states a 64k prompt limit beside a 100k output
    // limit, and that arithmetic left it with no room to prompt at all.
    const shrunk = ZED_MIN_COMPACTION_CONTEXT_WINDOW - 1 - prompt;
    return shrunk >= ZED_FALLBACK_MAX_OUTPUT_TOKENS
      ? { maxTokens: ZED_MIN_COMPACTION_CONTEXT_WINDOW - 1, maxOutputTokens: shrunk }
      // Too little room left under the threshold to state a reservation worth
      // stating, so the limit goes alone and Zed subtracts its own 4096. The
      // budget is short by that much, on a prompt limit already within 4096 of
      // the threshold.
      : { maxTokens: prompt, maxOutputTokens: undefined };
  }

  const window = usableLimit(limits.max_context_window_tokens) ?? ZED_FALLBACK_CONTEXT_TOKENS;

  // Here the reservation and the prompt come out of one total, so it is bounded
  // against the window: a stated one to half, because past that the prompt gets
  // the smaller share of a budget it is supposed to dominate, and an unstated
  // one only where Zed's own 4096 would take more than a quarter — an Ollama
  // model with a 2048-token context would otherwise reserve twice its window
  // and reach the picker with a negative budget.
  const quotient = stated === undefined
    ? (Math.floor(window / 4) < ZED_FALLBACK_MAX_OUTPUT_TOKENS ? Math.floor(window / 4) : undefined)
    : Math.min(stated, Math.floor(window / 2));
  // At least one token, so a window of three does not reserve zero. No upper
  // clamp is needed: both quotients are already under the window, and a window
  // of one leaves nothing for the prompt, which the projection drops below.
  const bounded = quotient === undefined ? undefined : Math.max(quotient, 1);
  const carried = bounded ?? ZED_FALLBACK_MAX_OUTPUT_TOKENS;

  if (window < ZED_MIN_COMPACTION_CONTEXT_WINDOW) return { maxTokens: window, maxOutputTokens: bounded };
  if (window - carried >= ZED_MIN_COMPACTION_CONTEXT_WINDOW) return { maxTokens: window, maxOutputTokens: bounded };

  const shrunk = window - ZED_MIN_COMPACTION_CONTEXT_WINDOW;
  return shrunk >= ZED_FALLBACK_MAX_OUTPUT_TOKENS
    ? { maxTokens: window, maxOutputTokens: shrunk }
    : { maxTokens: ZED_MIN_COMPACTION_CONTEXT_WINDOW - 1, maxOutputTokens: bounded };
};

export const projectZedModels = (models: readonly PublicModel[]): ZedModel[] =>
  chatModels(models).flatMap(model => {
    const plan = zedTokenPlan(model.limits);
    // Zed subtracts its reservation from the window and prompts with the rest,
    // so a window that cannot carry both is a model it would list and refuse on
    // every request. Better absent from the picker than present and broken.
    if (plan.maxTokens - (plan.maxOutputTokens ?? ZED_FALLBACK_MAX_OUTPUT_TOKENS) <= 0) return [];
    // The ceiling is the reservation Zed will actually send, which the band may
    // have shrunk — a budget under the stated limit but over the shrunk one is
    // still one Anthropic rejects on every request.
    const mode = zedThinkingMode(model.chat?.reasoning, plan.maxOutputTokens);
    return [{
      name: model.id,
      display_name: model.display_name,
      max_tokens: plan.maxTokens,
      capabilities: {
        // A chat model that cannot call tools is not one anyone routes here.
        tools: true,
        images: model.chat?.modalities?.input.includes('image') ?? false,
        // Zed defaults this off, which suppresses cache_control breakpoints
        // entirely; on, it marks where the stable prefix ends.
        prompt_caching: true,
      },
      ...(plan.maxOutputTokens === undefined ? {} : { max_output_tokens: plan.maxOutputTokens }),
      ...(mode === undefined ? {} : { mode }),
    }];
  });
