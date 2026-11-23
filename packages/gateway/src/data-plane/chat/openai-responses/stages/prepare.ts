import { responsesPayloadStage } from './facts.ts';
import { normalizeAssistantInputText } from '../items/normalize-assistant-content.ts';

export const prepare = responsesPayloadStage('prepare', payload => {
  const input = normalizeAssistantInputText(payload.input);
  return input === payload.input ? payload : { ...payload, input };
});
