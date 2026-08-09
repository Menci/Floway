import { describe, expect, it } from 'vitest';

import { catalogModel } from './model-fixture.ts';
import { projectVSCodeModels, projectZedModels } from '../src/models.ts';

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
    ]).map(entry => entry.mode);
    expect(modes[0]).toBeUndefined();
    expect(modes[1]).toBeUndefined();
    expect(modes[2]).toEqual({ type: 'thinking', budget_tokens: 4000 });
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
    const compacts = (e: { max_tokens: number; max_output_tokens?: number }) =>
      e.max_tokens - (e.max_output_tokens ?? ZED_FALLBACK_OUTPUT) >= MIN_COMPACTION;
    const warns = (e: { max_tokens: number }) => e.max_tokens < MIN_COMPACTION;

    const rows = projectZedModels([
      catalogModel('gpt-4o', { limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 64_000, max_output_tokens: 16_384 } }),
      catalogModel('just-under', { limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 79_999, max_output_tokens: 8000 } }),
      catalogModel('just-over', { limits: { max_context_window_tokens: 216_000, max_prompt_tokens: 80_000, max_output_tokens: 64_000 } }),
      catalogModel('roomy', { limits: { max_context_window_tokens: 216_000, max_prompt_tokens: 128_000, max_output_tokens: 64_000 } }),
      catalogModel('window-only', { contextWindow: 400_000 }),
      catalogModel('unbounded'),
    ]);

    for (const row of rows) {
      expect(compacts(row) || warns(row), `${row.name} gets neither compaction nor a warning`).toBe(true);
    }
    // And above the threshold the budget is still exactly what the catalog said.
    expect(rows.find(r => r.name === 'roomy')!.max_tokens - 64_000).toBe(128_000);
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

  // A stated 0 is a value, not an absent limit. `||` and truthiness cannot tell
  // the two apart, and the difference reaches Zed as a 200k window on a model
  // that announced none, or a silently dropped output limit.
  it('distinguishes a stated zero from an absent limit', () => {
    const [zeroWindow, zeroOutput, absent] = projectZedModels([
      catalogModel('zero-window', { limits: { max_context_window_tokens: 0 } }),
      catalogModel('zero-output', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 0 } }),
      catalogModel('absent'),
    ]);
    expect(zeroWindow!.max_tokens).toBe(0);
    expect(zeroOutput!.max_output_tokens).toBe(0);
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

// VS Code reconciles the two limits itself: it reserves the output budget out
// of the window and gives the prompt whatever remains, clamping an explicit
// `maxInputTokens` to that remainder.
// Ref: https://github.com/microsoft/vscode/blob/c780ea96132b1cabf170a454aced493d8317eee7/extensions/copilot/src/extension/byok/common/byokProvider.ts#L125-L134
describe('VS Code customendpoint model projection', () => {
  // What VS Code computes from what we wrote.
  const resolve = (entry: { contextWindow: number; maxOutputTokens: number; maxInputTokens?: number }) => {
    const maxOutputTokens = Math.min(entry.maxOutputTokens, entry.contextWindow);
    const remaining = Math.max(0, entry.contextWindow - maxOutputTokens);
    return { maxOutputTokens, maxInputTokens: Math.min(entry.maxInputTokens ?? remaining, remaining) };
  };

  it('states the prompt limit rather than letting it be derived', () => {
    const [both, windowOnly] = projectVSCodeModels([
      catalogModel('both', { limits: { max_context_window_tokens: 216_000, max_prompt_tokens: 128_000, max_output_tokens: 64_000 } }),
      catalogModel('window-only', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 32_000 } }),
    ], 'messages');

    expect(both!.contextWindow).toBe(216_000);
    expect(both!.maxInputTokens).toBe(128_000);
    // Derived rather than stated, the prompt budget would have been 152k — more
    // than the upstream accepts.
    expect(resolve(both!).maxInputTokens).toBe(128_000);

    expect(windowOnly).not.toHaveProperty('maxInputTokens');
    expect(resolve(windowOnly!).maxInputTokens).toBe(168_000);
  });

  // Ollama states a context length and no output limit, so an 8k model would
  // otherwise reserve the whole window for output and register with a prompt
  // budget of zero: present in the picker, over budget before it starts.
  it('never leaves a small-context model with no room to prompt', () => {
    const [tiny, small] = projectVSCodeModels([
      catalogModel('ollama-4k', { limits: { max_context_window_tokens: 4096 } }),
      catalogModel('ollama-8k', { limits: { max_context_window_tokens: 8192 } }),
    ], 'messages');

    expect(resolve(tiny!).maxInputTokens).toBeGreaterThan(0);
    expect(resolve(small!).maxInputTokens).toBeGreaterThan(0);
    expect(resolve(small!).maxInputTokens).toBe(8192 - 2048);
  });

  it('sends the id the gateway can resolve, suffix-free', () => {
    const [merged] = projectVSCodeModels([
      catalogModel('claude-opus-4-7', { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000, max_output_tokens: 64_000 } }),
    ], 'messages');
    expect(merged!.id).toBe('claude-opus-4-7');
  });

  // The window is non-zero on purpose: pairing a stated `max_output_tokens: 0`
  // with a zero window makes the fallback arm produce 0 as well, so the test
  // could not fail on the substitution it is named for.
  // A prompt limit of 0 is a stated limit; truthiness would drop the field and
  // let VS Code derive a budget the upstream never offered.
  it('states a prompt limit of zero rather than dropping it', () => {
    const [zeroPrompt, absent] = projectVSCodeModels([
      catalogModel('zero-prompt', { limits: { max_context_window_tokens: 200_000, max_prompt_tokens: 0 } }),
      catalogModel('absent', { limits: { max_context_window_tokens: 200_000 } }),
    ], 'messages');
    expect(zeroPrompt!.maxInputTokens).toBe(0);
    expect(absent).not.toHaveProperty('maxInputTokens');
  });

  // Without this VS Code drops the model from agent mode and inline chat, which
  // is most of what an operator installs it for.
  it('declares tool calling on every projected model', () => {
    const projected = projectVSCodeModels([
      catalogModel('plain', { contextWindow: 200_000 }),
      catalogModel('reasoner', { contextWindow: 200_000, chat: { reasoning: { adaptive: true } } }),
    ], 'messages');
    expect(projected.map(entry => entry.toolCalling)).toEqual([true, true]);
  });

  it('keeps a stated zero verbatim rather than substituting a fallback', () => {
    const [zeroOutput, zeroWindow] = projectVSCodeModels([
      catalogModel('zero-output', { limits: { max_context_window_tokens: 200_000, max_output_tokens: 0 } }),
      catalogModel('zero-window', { limits: { max_context_window_tokens: 0, max_output_tokens: 0 } }),
    ], 'messages');
    expect(zeroOutput!.maxOutputTokens).toBe(0);
    expect(zeroOutput!.contextWindow).toBe(200_000);
    expect(zeroWindow!.contextWindow).toBe(0);
  });
});
