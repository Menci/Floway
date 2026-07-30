// Every key `ResponseResource.required` lists.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json#L2691-L2723
export const REQUIRED_RESOURCE_KEYS = [
  'id',
  'object',
  'created_at',
  'completed_at',
  'status',
  'incomplete_details',
  'model',
  'previous_response_id',
  'instructions',
  'output',
  'error',
  'tools',
  'tool_choice',
  'truncation',
  'parallel_tool_calls',
  'text',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'top_logprobs',
  'temperature',
  'reasoning',
  'usage',
  'max_output_tokens',
  'max_tool_calls',
  'store',
  'background',
  'service_tier',
  'metadata',
  'safety_identifier',
  'prompt_cache_key',
] as const;

export const missingRequiredResourceKeys = (resource: Record<string, unknown>): string[] =>
  REQUIRED_RESOURCE_KEYS.filter(key => !(key in resource));
