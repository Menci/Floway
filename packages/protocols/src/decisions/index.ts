// OpenAI Decisions and Microsoft System One wire contracts.
// OpenAI Decisions: https://developers.openai.com/api/reference/resources/decisions/methods/create
// System One: https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision

export type DecisionsChoiceValue = string | boolean;

// What the response renderer needs to restore OpenAI identities from the
// System One answer map: the map key, the caller's (possibly absent) name,
// and the per-type values System One keys answers by.
export type DecisionsQuestionPlan =
  | { readonly type: 'predicate'; readonly key: string; readonly name: string | null }
  | { readonly type: 'choice'; readonly key: string; readonly name: string | null; readonly values: readonly DecisionsChoiceValue[] }
  | { readonly type: 'score'; readonly key: string; readonly name: string | null; readonly labels: readonly string[] };

export interface DecisionsTranslation {
  readonly model: string;
  // System One request body without `model`; the provider stamps its own id.
  readonly systemOne: Record<string, unknown>;
  readonly questions: readonly DecisionsQuestionPlan[];
}

export interface SystemOneUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export {
  DecisionsRequestError,
  parseSystemOneUsage,
  renderDecisionsResponse,
  translateDecisionsRequest,
} from './translate.ts';
