// These are only the Responses item types Floway itself can create, not a
// catalog or validator for provider-returned item IDs.
// OpenAI's wire examples use msg_/rs_/ws_/ctc_ for their corresponding item
// lifecycles and fc_/cmp_ for function and compaction items.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L57042-L59599
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L68023-L68281
const generatedItemPrefixes = {
  message: 'msg',
  reasoning: 'rs',
  web_search_call: 'ws',
  function_call: 'fc',
  custom_tool_call: 'ctc',
  compaction: 'cmp',
  // https://github.com/openai/codex/blob/8c41ed33ce3e39460e7b13b14c35e0c39bb5980d/codex-rs/protocol/src/models.rs#L1076-L1094
  image_generation_call: 'ig',
} as const;

export type GeneratedResponsesItemType = keyof typeof generatedItemPrefixes;

export const createRandomResponsesItemId = (type: GeneratedResponsesItemType): string => {
  if (!Object.hasOwn(generatedItemPrefixes, type)) {
    throw new TypeError(`Unknown generated Responses item type: ${type as string}`);
  }
  const prefix = generatedItemPrefixes[type];
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
};
