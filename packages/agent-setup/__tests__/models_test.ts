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
    ]).map(entry => entry.mode);
    expect(modes[0]).toBeUndefined();
    expect(modes[1]).toBeUndefined();
    expect(modes[2]).toEqual({ type: 'thinking', budget_tokens: 4000 });
  });

  // Zed copies `max_tokens` into `max_input_tokens` and compacts against it, so
  // it is the prompt budget. A model stating both — which Copilot routinely
  // does — must not be handed the window, or Zed never compacts and every long
  // request 400s upstream.
  it('fills the prompt budget from the prompt limit, not the window', () => {
    expect(projectZedModels([
      catalogModel('both', { limits: { max_context_window_tokens: 216_000, max_prompt_tokens: 128_000 } }),
      catalogModel('window-only', { contextWindow: 400_000 }),
      catalogModel('prompt-only', { limits: { max_prompt_tokens: 120_000 } }),
      catalogModel('unbounded'),
    ]).map(entry => entry.max_tokens)).toEqual([128_000, 400_000, 120_000, 200_000]);
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
