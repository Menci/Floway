import { TranslateInputException } from '../../../shared/input-error.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';

export const rejectProgrammaticOpenAIResponsesPayload = (payload: OpenAIResponsesPayloadEx): void => {
  const toolChoice = payload.tool_choice;
  const tools = [
    ...(payload.tools ?? []),
    ...(Array.isArray(payload.input) ? payload.input.flatMap(item => item.type === 'additional_tools' || item.type === 'tool_search_output' ? item.tools : []) : []),
  ];
  if (tools.some(hasProgrammaticCaller) || (toolChoice !== null && typeof toolChoice === 'object' && toolChoice.type === 'programmatic_tool_calling')) {
    throw new TranslateInputException('Programmatic OpenAI Responses tooling cannot be translated.');
  }
  if (tools.some(hasDeferredTool)) {
    throw new TranslateInputException('Deferred OpenAI Responses tooling cannot be translated.');
  }
};

const hasProgrammaticCaller = (tool: unknown): boolean => {
  if (typeof tool !== 'object' || tool === null) return false;
  const record = tool as Record<string, unknown>;
  if (record.type === 'programmatic_tool_calling') return true;
  if (Array.isArray(record.allowed_callers) && record.allowed_callers.includes('programmatic')) return true;
  return Array.isArray(record.tools) && record.tools.some(hasProgrammaticCaller);
};

const hasDeferredTool = (tool: unknown): boolean => {
  if (typeof tool !== 'object' || tool === null) return false;
  const record = tool as Record<string, unknown>;
  if (record.defer_loading === true) return true;
  return Array.isArray(record.tools) && record.tools.some(hasDeferredTool);
};

export const rejectProgramCaller = (item: CanonicalOpenAIResponsesInputItem): void => {
  if (!('caller' in item)) return;
  const caller = item.caller;
  if (typeof caller === 'object' && caller !== null && 'type' in caller && caller.type === 'program') {
    throw new TranslateInputException(`Cannot translate ${item.type} '${Reflect.get(item, 'call_id')}' with a program caller.`);
  }
};
