import type { DecisionProtocol } from '../common/models.ts';

export const DEFAULT_DECISION_PATHS: Readonly<Record<DecisionProtocol, string>> = {
  // TypeSafe Jev HTTP contract, which every System One implementation copies.
  // https://docs.typesafe.ai/api
  'systemone': '/v1/systemone',
  // OpenAI Decisions API; Azure OpenAI serves the same shape under
  // /openai/v1/decisions on the resource's v1 base.
  // https://developers.openai.com/api/docs/guides/decisions
  'openai-decisions': '/v1/decisions',
};
