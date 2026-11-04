import type { DecisionProtocol } from '../common/models.ts';

export const DEFAULT_DECISION_PATHS: Readonly<Record<DecisionProtocol, string>> = {
  // TypeSafe Jev HTTP contract, which every System One implementation copies.
  // https://docs.typesafe.ai/api
  'systemone': '/v1/systemone',
  // OpenAI Decisions API. An Azure OpenAI deployment needs its own `path`
  // override: the Azure provider joins this to the resource host, but the
  // decisions endpoint lives under /openai/v1.
  // https://developers.openai.com/api/docs/guides/decisions
  'openai-decisions': '/v1/decisions',
};
