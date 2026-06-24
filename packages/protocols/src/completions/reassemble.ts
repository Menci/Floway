import type { CompletionsChoice, CompletionsResult, CompletionsStreamEvent, CompletionsUsage } from './index.ts';

// Fold a /v1/completions streaming chunk sequence back into the
// single-shot envelope. Per-choice `text` concatenates, the latest
// non-null `finish_reason` wins, and the final usage chunk (which carries
// an empty `choices`) seeds the result's usage block. Chunk-level
// identity (`id`, `created`, `model`, `system_fingerprint`) is taken from
// the first chunk that carried it.
//
// Unlike chat-completions, the legacy protocol has no tool-calls or
// reasoning surface, so the fold is straightforward text accumulation
// per index. Unknown choice / chunk fields fall on the floor by design;
// the dashboard renders the captured raw frame stream alongside the
// reassembled result for a forensic view of what the upstream actually
// emitted.

export const reassembleCompletionsEvents = async (chunks: AsyncIterable<CompletionsStreamEvent>): Promise<CompletionsResult> => {
  let id = '';
  let model = '';
  let created = 0;
  let systemFingerprint: string | undefined;
  let lastUsage: CompletionsUsage | undefined;

  interface ChoiceAccumulator {
    text: string;
    finishReason: string | null;
    logprobs: unknown;
  }
  const choices = new Map<number, ChoiceAccumulator>();

  for await (const chunk of chunks) {
    if (!id && chunk.id) {
      id = chunk.id;
      model = chunk.model;
      created = chunk.created;
    }
    if (systemFingerprint === undefined && chunk.system_fingerprint !== undefined) {
      systemFingerprint = chunk.system_fingerprint;
    }
    if (chunk.usage) {
      lastUsage = chunk.usage;
    }

    if (!Array.isArray(chunk.choices)) continue;
    for (const choice of chunk.choices) {
      const accumulator = choices.get(choice.index) ?? { text: '', finishReason: null, logprobs: undefined };
      if (typeof choice.text === 'string') accumulator.text += choice.text;
      if (choice.finish_reason) accumulator.finishReason = choice.finish_reason;
      if (choice.logprobs !== undefined) accumulator.logprobs = choice.logprobs;
      choices.set(choice.index, accumulator);
    }
  }

  const sortedIndices = [...choices.keys()].sort((a, b) => a - b);
  const result: CompletionsResult = {
    id,
    object: 'text_completion',
    created,
    model,
    choices: sortedIndices.map((index): CompletionsChoice => {
      const accumulator = choices.get(index)!;
      const choice: CompletionsChoice = {
        index,
        text: accumulator.text,
        finish_reason: accumulator.finishReason,
      };
      if (accumulator.logprobs !== undefined) choice.logprobs = accumulator.logprobs;
      return choice;
    }),
  };
  if (lastUsage) result.usage = lastUsage;
  if (systemFingerprint !== undefined) result.system_fingerprint = systemFingerprint;
  return result;
};
