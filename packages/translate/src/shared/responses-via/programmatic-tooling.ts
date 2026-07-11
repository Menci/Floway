import { TranslatorInputError } from '../../translator-input-error.ts';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';

export const rejectProgrammaticResponsesPayload = (payload: ResponsesPayload, target: string): void => {
  const programmaticTool = payload.tools?.find(tool =>
    tool.type === 'programmatic_tool_calling'
    || (tool.type === 'function' || tool.type === 'custom')
    && tool.allowed_callers?.includes('programmatic'));
  const toolChoice = payload.tool_choice;
  if (programmaticTool !== undefined || (typeof toolChoice === 'object' && toolChoice.type === 'programmatic_tool_calling')) {
    throw new TranslatorInputError(`Programmatic Responses tooling cannot be translated to ${target}.`);
  }
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
