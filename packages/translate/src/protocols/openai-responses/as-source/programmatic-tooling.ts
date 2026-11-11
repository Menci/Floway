import { TranslateInputException } from '../../../types.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';

export const rejectProgrammaticOpenAIResponsesPayload = (payload: OpenAIResponsesPayloadEx): void => {
  const toolChoice = payload.tool_choice;
  if (payload.tools?.some(hasProgrammaticCaller) === true || (toolChoice !== null && typeof toolChoice === 'object' && toolChoice.type === 'programmatic_tool_calling')) {
    throw new TranslateInputException('Programmatic OpenAI Responses tooling cannot be translated.');
  }
  if (payload.tools?.some(hasDeferredTool) === true) {
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
