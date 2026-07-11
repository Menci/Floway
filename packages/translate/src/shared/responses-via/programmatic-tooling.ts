import { TranslatorInputError } from '../../translator-input-error.ts';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';

export const rejectProgrammaticResponsesPayload = (payload: ResponsesPayload, target: string): void => {
  const toolChoice = payload.tool_choice;
  if (payload.tools?.some(hasProgrammaticCaller) === true || (toolChoice !== null && typeof toolChoice === 'object' && toolChoice.type === 'programmatic_tool_calling')) {
    throw new TranslatorInputError(`Programmatic Responses tooling cannot be translated to ${target}.`);
  }
  if (payload.tools?.some(hasDeferredTool) === true) {
    throw new TranslatorInputError(`Deferred Responses tooling cannot be translated to ${target}.`);
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

export const rejectProgramCaller = (item: ResponsesInputItem): void => {
  if (
    (item.type === 'function_call'
      || item.type === 'function_call_output'
      || item.type === 'custom_tool_call'
      || item.type === 'custom_tool_call_output')
    && item.caller?.type === 'program'
  ) {
    throw new TranslatorInputError(`Cannot translate ${item.type} '${item.call_id}' with a program caller.`);
  }
};
