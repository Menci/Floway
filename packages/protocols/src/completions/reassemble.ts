import type { CompletionsChoice, CompletionsResult, CompletionsStreamEvent, CompletionsUsage } from './index.ts';

// Fold a /v1/completions streaming chunk sequence back into the
// single-shot envelope used by the dashboard's dump renderer. The
// dashboard also surfaces the raw frame stream alongside the reassembled
// result, so unknown choice / chunk fields fall on the floor here by
// design — the forensic view is the raw stream.

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

  const mergeLogprobs = (current: unknown, incoming: unknown): unknown => {
    if (current === undefined) return structuredClone(incoming);
    if (typeof current !== 'object' || current === null || Array.isArray(current)
      || typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) return structuredClone(incoming);
    return Object.fromEntries(new Set([...Object.keys(current), ...Object.keys(incoming)]).values().map(key => {
      const left = (current as Record<string, unknown>)[key];
      const right = (incoming as Record<string, unknown>)[key];
      const selected = Object.hasOwn(incoming, key) ? right : left;
      return [key, Array.isArray(left) && Array.isArray(right) ? [...left, ...right] : structuredClone(selected)];
    }));
  };

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

    if (!Array.isArray(chunk.choices)) throw new TypeError('Completions chunk choices must be an array');
    for (const choice of chunk.choices) {
      // Placeholder choices (only `index`, no `text` / `finish_reason`)
      // appear in the Zhipu/GLM vLLM fork's final usage chunk; they
      // contribute nothing here.
      if (!Number.isSafeInteger(choice.index) || choice.index < 0) throw new RangeError(`Completions choice index must be a non-negative safe integer: ${choice.index}`);
      const accumulator = choices.get(choice.index) ?? { text: '', finishReason: null, logprobs: undefined };
      if (accumulator.finishReason !== null && (choice.text !== undefined || choice.finish_reason !== undefined || choice.logprobs !== undefined)) {
        throw new Error(`Completions choice ${choice.index} emitted data after finish_reason`);
      }
      if (choice.text !== undefined) {
        if (typeof choice.text !== 'string') throw new TypeError(`Completions choice ${choice.index} text must be a string`);
        accumulator.text += choice.text;
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== 'string') throw new TypeError(`Completions choice ${choice.index} finish_reason must be a string or null`);
        accumulator.finishReason = choice.finish_reason;
      }
      if (choice.logprobs !== undefined) accumulator.logprobs = mergeLogprobs(accumulator.logprobs, choice.logprobs);
      choices.set(choice.index, accumulator);
    }
  }

  const result: CompletionsResult = {
    id,
    object: 'text_completion',
    created,
    model,
    choices: [...choices.entries()].sort(([a], [b]) => a - b).map(([index, accumulator]): CompletionsChoice => {
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
