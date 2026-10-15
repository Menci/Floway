// These are assistant-produced entries in the Responses input item union.
// https://platform.openai.com/docs/api-reference/responses/create
export const assistantItemTypeNames = [
  'reasoning', 'function_call', 'custom_tool_call', 'web_search_call', 'file_search_call', 'computer_call', 'tool_search_call',
  'program', 'agent_message', 'multi_agent_call', 'image_generation_call',
  'code_interpreter_call', 'local_shell_call', 'shell_call', 'apply_patch_call', 'mcp_call', 'mcp_approval_request',
] as const;
