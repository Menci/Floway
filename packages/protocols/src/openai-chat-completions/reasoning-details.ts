const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Consecutive text/summary details share one entry; encrypted details are complete, distinct blobs.
// https://github.com/OpenRouterTeam/ai-sdk-provider/blob/1b22b05352cb0f9243a6c3fdd326038dd3705544/src/chat/index.ts#L774-L819
export const accumulateOpenAIChatCompletionsReasoningDetails = (details: unknown[], incoming: unknown[]): void => {
  for (const next of incoming) {
    const last = details.at(-1);
    const field = record(next) && next.type === 'reasoning.summary' ? 'summary' : record(next) && next.type === 'reasoning.text' ? 'text' : undefined;
    if (record(next) && record(last) && field !== undefined && last.type === next.type) {
      last[field] = (typeof last[field] === 'string' ? last[field] : '') + (typeof next[field] === 'string' ? next[field] : '');
      if (field === 'text' && !last.signature) last.signature = next.signature;
      if (!Boolean(last.format)) last.format = next.format;
    } else details.push(record(next) ? { ...next } : next);
  }
};
