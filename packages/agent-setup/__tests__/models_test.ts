import { describe, expect, it } from 'vitest';

import { catalogModel } from './model-fixture.ts';
import { projectZedModels } from '../src/models.ts';

describe('Zed available_models projection', () => {
  it('keeps chat models and drops other kinds', () => {
    expect(projectZedModels([
      catalogModel('chat-a', { contextWindow: 200_000 }),
      catalogModel('embedding', { kind: 'embedding', endpoints: { embeddings: {} } }),
      catalogModel('reranker', { kind: 'rerank', endpoints: { rerank: {} } }),
    ]).map(entry => entry.name)).toEqual(['chat-a']);
  });

  // The dashboard asks the control plane for unlisted rows to populate its
  // alias combobox; `/v1/models`, which the installer snapshots, never serves
  // them. Keeping one here would put a model in Zed that the installer omits.
  it('drops addressable-but-unlisted rows the installer never sees', () => {
    expect(projectZedModels([
      catalogModel('listed', { contextWindow: 200_000 }),
      catalogModel('vendor/listed', { contextWindow: 200_000, unlisted: true }),
    ]).map(entry => entry.name)).toEqual(['listed']);
  });

  // `budget_tokens.min` is a lower bound an operator may record as 0, meaning
  // "no lower bound stated". Zed sends the budget verbatim on every request and
  // Anthropic rejects anything under its minimum, so a budget too small to use
  // is no budget: fall through to the ceiling, or leave the model in Default
  // mode, rather than writing one that makes every call 400.
  it('ignores a budget too small for Anthropic to accept', () => {
    const modes = projectZedModels([
      catalogModel('floor-zero', { contextWindow: 200_000, chat: { reasoning: { budget_tokens: { min: 0 } } } }),
      catalogModel('floor-zero-with-ceiling', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 }, chat: { reasoning: { budget_tokens: { min: 0, max: 8000 } } } }),
      catalogModel('both-too-small', { contextWindow: 200_000, chat: { reasoning: { budget_tokens: { min: 0, max: 500 } } } }),
    ]).map(entry => entry.mode);
    expect(modes[0]).toBeUndefined();
    expect(modes[1]).toEqual({ type: 'thinking', budget_tokens: 8000 });
    expect(modes[2]).toBeUndefined();
  });

  // Zed sends `max_tokens` as the model's output limit, or 4096 when it states
  // none, and passes the budget through unclamped — so a budget at or above
  // that is one Anthropic rejects on every request.
  it('keeps the budget under the max_tokens Zed will send', () => {
    const modes = projectZedModels([
      catalogModel('no-output-limit', { contextWindow: 200_000, chat: { reasoning: { budget_tokens: { max: 32_000 } } } }),
      catalogModel('budget-at-the-limit', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 8000 }, chat: { reasoning: { budget_tokens: { min: 8000 } } } }),
      catalogModel('budget-under-the-limit', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 8000 }, chat: { reasoning: { budget_tokens: { min: 4000 } } } }),
      // The band shrinks this row's reservation from 64_000 to 48_000, and it
      // is the shrunk one Zed sends — a budget between the two is under the
      // catalog's limit and over what actually goes on the wire.
      catalogModel('budget-over-the-shrunk-limit', { limits: { max_context_window_tokens: 128_000, max_output_tokens: 64_000 }, chat: { reasoning: { budget_tokens: { min: 50_000 } } } }),
    ]).map(entry => entry.mode);
    expect(modes[0]).toBeUndefined();
    expect(modes[1]).toBeUndefined();
    expect(modes[2]).toEqual({ type: 'thinking', budget_tokens: 4000 });
    expect(modes[3]).toBeUndefined();
  });

  // `max_tokens` is the context window, and Zed derives the prompt budget by
  // subtracting the output reservation — then disables auto-compaction when
  // fewer than 80_000 tokens remain. So the property worth asserting is what
  // Zed computes, not the number we hand it.
  // Refs: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent/src/thread.rs#L4383-L4390
  //       https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/agent/src/thread.rs#L124
  it('leaves Zed the prompt budget the catalog states', () => {
    const ZED_FALLBACK_OUTPUT = 4096;
    const ZED_MIN_COMPACTION = 80_000;
    // What Zed does with what we wrote.
    const derivedPromptBudget = (entry: { max_tokens: number; max_output_tokens?: number }) =>
      entry.max_tokens - (entry.max_output_tokens ?? ZED_FALLBACK_OUTPUT);

    const [both, windowOnly, promptOnly, unbounded] = projectZedModels([
      catalogModel('both', { limits: { max_context_window_tokens: 216_000, max_prompt_tokens: 128_000, max_output_tokens: 64_000 } }),
      catalogModel('window-only', { contextWindow: 400_000 }),
      catalogModel('prompt-only', { limits: { max_prompt_tokens: 120_000 } }),
      catalogModel('unbounded'),
    ]);

    // The case that matters: an upstream stating all three. Handing Zed the
    // 216k window would let it plan against headroom the upstream refuses;
    // handing it the bare 128k prompt limit leaves 64k and silently switches
    // compaction off.
    expect(derivedPromptBudget(both!)).toBe(128_000);
    expect(derivedPromptBudget(both!)).toBeGreaterThanOrEqual(ZED_MIN_COMPACTION);

    expect(windowOnly!.max_tokens).toBe(400_000);
    expect(derivedPromptBudget(promptOnly!)).toBe(120_000);
    expect(unbounded!.max_tokens).toBe(200_000);
  });

  // Zed asks the same 80_000 threshold of two different numbers: compaction of
  // `max_tokens - max_output_tokens`, and the small-context warning of the raw
  // `max_tokens`. A model must never land between them — that is compaction off
  // with the callout suppressed, and nothing on screen explains it. Copilot's
  // gpt-4o rows (128k window, 64k prompt, 16k output) sit exactly there under a
  // naive prompt+output reconstruction.
  it('never leaves a model without compaction and without the warning', () => {
    const ZED_FALLBACK_OUTPUT = 4096;
    const MIN_COMPACTION = 80_000;
    const derived = (e: { max_tokens: number; max_output_tokens?: number }) =>
      e.max_tokens - (e.max_output_tokens ?? ZED_FALLBACK_OUTPUT);
    const compacts = (e: { max_tokens: number; max_output_tokens?: number }) => derived(e) >= MIN_COMPACTION;
    // `max_tokens: 0` does not warn: the callout falls through to the usage
    // ratio, which is forced to Normal at zero. No projected row reaches that
    // today — the projection turns a stated zero into no bound at all — so this
    // conjunct is what keeps the predicate a faithful model of Zed rather than
    // a model of what the projection happens to emit.
    // Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/acp_thread/src/acp_thread.rs#L2042-L2043
    const warns = (e: { max_tokens: number }) => e.max_tokens > 0 && e.max_tokens < MIN_COMPACTION;

    const rows = projectZedModels([
      catalogModel('gpt-4o', { limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 64_000, max_output_tokens: 16_384 } }),
      catalogModel('just-under', { limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 79_999, max_output_tokens: 8000 } }),
      catalogModel('just-over', { limits: { max_context_window_tokens: 216_000, max_prompt_tokens: 80_000, max_output_tokens: 64_000 } }),
      catalogModel('roomy', { limits: { max_context_window_tokens: 216_000, max_prompt_tokens: 128_000, max_output_tokens: 64_000 } }),
      catalogModel('window-only', { contextWindow: 400_000 }),
      catalogModel('unbounded'),
      // No prompt limit — the branch the band check reached last. An
      // OpenAI-compatible upstream states window and output and nothing else,
      // and every one of these falls in the band on the stated pair.
      catalogModel('window-and-output', { limits: { max_context_window_tokens: 128_000, max_output_tokens: 64_000 } }),
      catalogModel('window-and-output-wide', { limits: { max_context_window_tokens: 100_000, max_output_tokens: 32_000 } }),
      catalogModel('window-and-output-narrow', { limits: { max_context_window_tokens: 82_000, max_output_tokens: 32_000 } }),
      // Output absent, so Zed reserves 4096 of a window that leaves too little.
      catalogModel('window-just-over-threshold', { contextWindow: 82_000 }),
      // Every shape that could reach Zed as a zero window.
      catalogModel('zero-window', { limits: { max_context_window_tokens: 0 } }),
      catalogModel('zero-prompt', { limits: { max_prompt_tokens: 0 } }),
      catalogModel('zero-everything', { limits: { max_context_window_tokens: 0, max_prompt_tokens: 0, max_output_tokens: 0 } }),
      // A stated prompt limit well below the band: the reservation stays on, so
      // the budget is the one the catalog stated rather than that minus 16k.
      catalogModel('small-prompt', { limits: { max_context_window_tokens: 48_384, max_prompt_tokens: 32_000, max_output_tokens: 16_384 } }),
      // Copilot's o3-mini shape: an output limit larger than the prompt limit.
      // Subtracting one from the other leaves no room to prompt at all.
      catalogModel('o3-mini', { limits: { max_prompt_tokens: 64_000, max_output_tokens: 100_000 } }),
      catalogModel('o1', { limits: { max_prompt_tokens: 20_000, max_output_tokens: 100_000 } }),
      catalogModel('equal-limits', { limits: { max_prompt_tokens: 60_000, max_output_tokens: 60_000 } }),
      // A prompt limit within the fallback reservation of the threshold: there
      // is no reservation small enough to state, so Zed's own 4096 applies.
      catalogModel('just-under-threshold', { limits: { max_prompt_tokens: 79_999, max_output_tokens: 8000 } }),
      // Ollama states a context length and nothing else, so Zed's own 4096
      // reservation is what the window has to survive: a 2048-token local
      // model would reserve twice its context and reach a negative budget.
      catalogModel('ollama-4k', { contextWindow: 4096 }),
      catalogModel('ollama-2k', { contextWindow: 2048 }),
      // A stated output limit at or over the window it shares.
      catalogModel('window-lt-output', { limits: { max_context_window_tokens: 64_000, max_output_tokens: 100_000 } }),
      catalogModel('window-eq-output', { limits: { max_context_window_tokens: 32_000, max_output_tokens: 32_000 } }),
      catalogModel('narrow-band-output', { limits: { max_context_window_tokens: 82_000, max_output_tokens: 100_000 } }),
      // A window of one to three tokens makes the quotients zero, which is the
      // value the limit filter exists to keep off Zed's wire. Clamped to leave
      // a token on each side instead — and a window of one, which cannot carry
      // both, is dropped from the projection rather than listed and broken.
      catalogModel('window-of-three', { contextWindow: 3 }),
      catalogModel('window-of-one', { limits: { max_context_window_tokens: 1, max_output_tokens: 1 } }),
    ]);

    for (const row of rows) {
      expect(compacts(row) || warns(row), `${row.name} gets neither compaction nor a warning`).toBe(true);
      // And a window with nothing left to prompt with is no better than the
      // band: the model is in the picker and every request is over budget.
      expect(derived(row), `${row.name} has no room to prompt`).toBeGreaterThan(0);
    }
    // And above the threshold the budget is still exactly what the catalog said.
    expect(rows.find(r => r.name === 'roomy')!.max_tokens - 64_000).toBe(128_000);
    // Below the band it is too: dropping the reservation there would cost the
    // operator 16k of prompt budget and buy nothing, since the callout fires
    // either way.
    const small = rows.find(r => r.name === 'small-prompt')!;
    expect(small.max_tokens - small.max_output_tokens!).toBe(32_000);
    // In the band the budget is still exactly the stated limit, because the
    // reservation shrinks to fit under the threshold rather than being
    // subtracted from it.
    const byName = (name: string) => rows.find(r => r.name === name)!;
    expect(derived(byName('o3-mini'))).toBe(64_000);
    expect(derived(byName('o1'))).toBe(20_000);
    expect(derived(byName('equal-limits'))).toBe(60_000);
    expect(byName('just-under-threshold')).not.toHaveProperty('max_output_tokens');
    // A window small enough that Zed's default would take more than a quarter
    // gets an explicit reservation; a roomy one is left to that default.
    expect(byName('ollama-4k').max_output_tokens).toBe(1024);
    expect(byName('ollama-2k').max_output_tokens).toBe(512);
    expect(byName('window-only')).not.toHaveProperty('max_output_tokens');
    // A stated one is kept to half the window it shares.
    expect(byName('window-lt-output').max_output_tokens).toBe(32_000);
    expect(byName('window-eq-output').max_output_tokens).toBe(16_000);
    // Never a stated zero, which Anthropic rejects on every request.
    expect(byName('window-of-three').max_output_tokens).toBe(1);
    expect(rows.some(r => r.name === 'window-of-one')).toBe(false);

    const row = (name: string) => rows.find(r => r.name === name)!;
    // With no prompt limit stated, the split is ours: the window is left whole
    // and the reservation shrinks to put the budget on the threshold.
    expect(row('window-and-output')).toMatchObject({ max_tokens: 128_000, max_output_tokens: 48_000 });
    expect(row('window-and-output-wide')).toMatchObject({ max_tokens: 100_000, max_output_tokens: 20_000 });
    // Under 4096 left over there is no split that compacts, so the window drops
    // below the threshold to raise the callout and the reservation stands.
    expect(row('window-and-output-narrow')).toMatchObject({ max_tokens: 79_999, max_output_tokens: 32_000 });
    expect(row('window-just-over-threshold')!.max_tokens).toBe(79_999);
    expect(row('window-just-over-threshold')).not.toHaveProperty('max_output_tokens');
  });

  // The `[1m]` suffix is Claude Code's discovery convention: the CLI strips it
  // and supplies the beta itself. Editors send the id back verbatim and the
  // gateway's resolution has no notion of the suffix, so projecting it would
  // address a model that does not exist. The merged row's window is optimistic
  // as a result, which is the lesser of the two — a 404 on every 1M model is
  // not.
  it('sends the id the gateway can resolve, suffix-free', () => {
    const [merged] = projectZedModels([
      catalogModel('claude-opus-4-7', { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000 } }),
    ]);
    expect(merged!.name).toBe('claude-opus-4-7');
  });

  // A stated 0 is a value in the catalog and no bound at all at Zed's wire,
  // where these are required u64s sent verbatim with no encoding for "unknown".
  // A 0 window is a 0-token context whose callout the ratio guard suppresses —
  // neither compaction nor warning — and a 0 output limit becomes a Messages
  // `max_tokens` of 0, which Anthropic rejects on every request. Negative and
  // fractional values fail Zed's deserialization and take the whole settings
  // document with them.
  it('treats a limit Zed cannot represent as no limit at all', () => {
    const [zeroWindow, zeroOutput, negativeWindow, fractionalWindow, zeroPrompt, absent] = projectZedModels([
      catalogModel('zero-window', { limits: { max_context_window_tokens: 0 } }),
      catalogModel('zero-output', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 0 } }),
      catalogModel('negative-window', { limits: { max_context_window_tokens: -1 } }),
      catalogModel('fractional-window', { limits: { max_context_window_tokens: 1.5 } }),
      catalogModel('zero-prompt', { limits: { max_context_window_tokens: 200_000, max_prompt_tokens: 0 } }),
      catalogModel('absent'),
    ]);
    expect(zeroWindow!.max_tokens).toBe(200_000);
    expect(zeroOutput).not.toHaveProperty('max_output_tokens');
    expect(negativeWindow!.max_tokens).toBe(200_000);
    expect(fractionalWindow!.max_tokens).toBe(200_000);
    // The prompt limit is unusable, so the window it does state is what goes.
    expect(zeroPrompt!.max_tokens).toBe(200_000);
    expect(absent!.max_tokens).toBe(200_000);
    expect(absent).not.toHaveProperty('max_output_tokens');
  });

  it('omits max_output_tokens when the catalog announces none', () => {
    const [withOutput, withoutOutput] = projectZedModels([
      catalogModel('bounded', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 } }),
      catalogModel('unbounded', { contextWindow: 200_000 }),
    ]);
    expect(withOutput!.max_output_tokens).toBe(64_000);
    expect(withoutOutput).not.toHaveProperty('max_output_tokens');
  });

  // Zed reads no per-field default for these, so a partial object fails to
  // deserialize and takes the whole provider down with it.
  it('always writes all three capability flags', () => {
    const [textOnly, withVision] = projectZedModels([
      catalogModel('text', { contextWindow: 200_000, chat: { modalities: { input: ['text'], output: ['text'] } } }),
      catalogModel('vision', { contextWindow: 200_000, chat: { modalities: { input: ['text', 'image'], output: ['text'] } } }),
    ]);
    expect(textOnly!.capabilities).toEqual({ tools: true, images: false, prompt_caching: true });
    expect(withVision!.capabilities).toEqual({ tools: true, images: true, prompt_caching: true });
  });

  // A thinking mode without a budget makes Zed put `"budget_tokens": null` on
  // every Messages request, which Anthropic rejects — so a reasoner with no
  // budget must stay in default mode rather than gain an unusable one.
  it('maps reasoning onto adaptive, a budgeted thinking mode, or no mode at all', () => {
    const [adaptive, floored, ceilingOnly, effortOnly, plain] = projectZedModels([
      catalogModel('adaptive', { contextWindow: 200_000, chat: { reasoning: { adaptive: true } } }),
      catalogModel('floored', { contextWindow: 200_000, chat: { reasoning: { budget_tokens: { min: 1024, max: 32_000 } } } }),
      catalogModel('ceiling-only', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 }, chat: { reasoning: { budget_tokens: { max: 32_000 } } } }),
      catalogModel('effort-only', { contextWindow: 200_000, chat: { reasoning: { effort: { supported: ['low'], default: 'low' } } } }),
      catalogModel('plain', { contextWindow: 200_000 }),
    ]);
    expect(adaptive!.mode).toEqual({ type: 'adaptive' });
    // The floor, not the ceiling: Zed sends this verbatim on every request and
    // Anthropic requires it below max_tokens.
    expect(floored!.mode).toEqual({ type: 'thinking', budget_tokens: 1024 });
    expect(ceilingOnly!.mode).toEqual({ type: 'thinking', budget_tokens: 32_000 });
    expect(effortOnly).not.toHaveProperty('mode');
    expect(plain).not.toHaveProperty('mode');
  });
});
