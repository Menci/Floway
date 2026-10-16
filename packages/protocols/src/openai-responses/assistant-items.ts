import type { CanonicalOpenAIResponsesInputItem } from './index.ts';

// Assistant-produced entries in the Responses input item union.
// https://platform.openai.com/docs/api-reference/responses/create
const assistantItemTypes = new Set<CanonicalOpenAIResponsesInputItem['type']>([
  'reasoning', 'function_call', 'custom_tool_call', 'web_search_call', 'file_search_call', 'computer_call', 'tool_search_call',
  'program', 'agent_message', 'multi_agent_call', 'image_generation_call',
  'code_interpreter_call', 'local_shell_call', 'shell_call', 'apply_patch_call', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request',
]);

export const isOpenAIResponsesAssistantInputItem = (item: CanonicalOpenAIResponsesInputItem): boolean => item.type === 'message'
  ? item.role === 'assistant'
  : assistantItemTypes.has(item.type);
