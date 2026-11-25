import { jsonRequest, ollamaDial } from '../dial.ts';
import { formatOpenAIError } from '../errors.ts';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';

// https://docs.ollama.com/capabilities/decision
export const dial = ollamaDial('decision', (payload, model) => {
  const target = model.decisionTarget;
  if (target?.protocol !== 'typesafe-systemone') throw new Error(`Ollama decision model ${model.id} must use a System One target`);
  const path = target.path ?? DEFAULT_DECISION_PATHS[target.protocol];
  return jsonRequest(path, serializeDecisionRequest(target.protocol, model.upstreamModelId, payload));
}, formatOpenAIError);
