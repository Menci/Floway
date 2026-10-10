import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesTool } from './index.ts';

// `web_search` ships under four equivalent type values (current + dated
// + preview + dated-preview). All four name the same hosted tool. The
// canonical list lives here so the runtime Set and this TS union can't
// drift.
// https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/resources/responses/responses.ts
export const WEB_SEARCH_HOSTED_TYPE_NAMES = [
  'web_search',
  'web_search_2025_08_26',
  'web_search_preview',
  'web_search_preview_2025_03_11',
] as const;

export const collectOpenAIResponsesToolEntries = (
  payload: CanonicalOpenAIResponsesPayload,
): Array<{ tool: OpenAIResponsesTool; path: string }> => [
  ...(payload.tools ?? []).map((tool, index) => ({ tool, path: `tools[${index}]` })),
  ...payload.input.flatMap((item, inputIndex) =>
    item.type === 'additional_tools' || item.type === 'tool_search_output'
      ? item.tools.map((tool, toolIndex) => ({ tool, path: `input[${inputIndex}].tools[${toolIndex}]` }))
      : []),
];

export const collectOpenAIResponsesTools = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesTool[] =>
  collectOpenAIResponsesToolEntries(payload).map(entry => entry.tool);

export const mapOpenAIResponsesTools = (
  payload: CanonicalOpenAIResponsesPayload,
  transform: (tool: OpenAIResponsesTool) => OpenAIResponsesTool,
): CanonicalOpenAIResponsesPayload => {
  const mapTools = (tools: OpenAIResponsesTool[]): OpenAIResponsesTool[] => tools.map(transform);
  const input = payload.input.map(item => {
    switch (item.type) {
    case 'additional_tools':
    case 'tool_search_output':
      return { ...item, tools: mapTools(item.tools) };
    default:
      return item;
    }
  });
  return {
    ...payload,
    input,
    ...(Array.isArray(payload.tools) ? { tools: mapTools(payload.tools) } : {}),
  };
};
