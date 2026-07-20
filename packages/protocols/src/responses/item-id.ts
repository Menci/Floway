// These are the Responses item types Floway itself can create. Native
// Responses providers keep ownership of every id they return; this table is
// intentionally not a catalog of every upstream item type.
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
  // https://github.com/openai/openai-python/blob/d4dceb221b9a92c55c232d5b330ae89beb539415/src/openai/types/responses/response_output_item.py#L513-L537
  image_generation_call: 'ig',
} as const;

export type GeneratedResponsesItemType = keyof typeof generatedItemPrefixes;

export const createRandomResponsesItemId = (type: GeneratedResponsesItemType): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${generatedItemPrefixes[type]}_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
};
