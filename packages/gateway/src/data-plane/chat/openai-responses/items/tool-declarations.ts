import { replaceOpenAIResponsesAdditionalTools, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

// Standard requests declare tools at the top level; Lite also uses ordered
// additional_tools items, including declarations added after earlier turns.
// Reading the declarations together must not move them on the outbound wire.
// https://developers.openai.com/api/reference/resources/responses/methods/create
export const declaredOpenAIResponsesTools = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesTool[] => [
  ...(Array.isArray(payload.tools) ? payload.tools : []),
  ...payload.input.flatMap(item => item.type === 'additional_tools' && item.role === 'developer' ? item.tools : []),
];

export const mapOpenAIResponsesToolDeclarations = (
  payload: CanonicalOpenAIResponsesPayload,
  transform: (tools: OpenAIResponsesTool[]) => OpenAIResponsesTool[],
): CanonicalOpenAIResponsesPayload => {
  const tools = Array.isArray(payload.tools) ? transform(payload.tools) : payload.tools;
  let changed = tools !== payload.tools;
  const input = payload.input.map(item => {
    if (item.type !== 'additional_tools' || item.role !== 'developer') return item;
    const next = replaceOpenAIResponsesAdditionalTools(item, transform(item.tools));
    changed ||= next !== item;
    return next;
  });
  return changed ? { ...payload, ...(tools === undefined ? {} : { tools }), input } : payload;
};
