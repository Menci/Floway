// OpenAI strict-mode JSON Schema validators (Copilot, Azure OpenAI, OpenAI
// proper) reject `{type: 'object'}` tool parameters without an explicit
// `properties` field; Anthropic accepts that shape. Translators that forward
// Messages tool schemas to OpenAI-shaped targets must normalize the schema
// first. The reverse direction at
// packages/translate/src/chat-completions-via-messages/request.ts already
// defaults `parameters` to `{type: 'object', properties: {}}`, so this closes a
// real asymmetry. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
export const normalizeMessagesToolInputSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  if (schema.type !== 'object' || schema.properties !== undefined) return schema;
  return { ...schema, properties: {} };
};
