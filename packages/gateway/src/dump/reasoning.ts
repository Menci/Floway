import { FlowayOpenAIChatCompletionsReasoning, fromFlowayOpenAIChatCompletionsReasoning } from '@floway-dev/protocols/openai-chat-completions';

// Dumps cross a JSON persistence boundary. Project internal reasoning into the
// diagnostic wire consumed by the dashboard before JSON drops Symbol members.
export const projectReasoningForDump = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(projectReasoningForDump);
  if (value === null || typeof value !== 'object') return value;
  const message = value as Record<PropertyKey, unknown>;
  const projected = message[FlowayOpenAIChatCompletionsReasoning] === undefined ? message : fromFlowayOpenAIChatCompletionsReasoning(message, { text: 'reasoning-text', data: 'reasoning-opaque' }, { warn: warning => console.warn('Floway dump reasoning projection:', warning) });
  return Object.fromEntries(Object.entries(projected).map(([key, child]) => [key, projectReasoningForDump(child)]));
};
