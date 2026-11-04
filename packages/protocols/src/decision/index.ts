// The System One state: a string, a JSON object, or a JSON array. Decision
// models read it as evidence and never treat it as instructions.
// https://docs.typesafe.ai/primitives
export type DecisionState = string | Record<string, unknown> | readonly unknown[];

// One question. `name` is the caller's key; the model never sees it and the
// answer echoes it. `noul` gives a yes/no probability; `choice` selects one of
// an unordered set; `score` places the state on ordered levels. A Choice and a
// Score each take criteria — a map of options and an ordered list of levels —
// and a Noul's criteria optionally define what yes and no mean.
export interface DecisionNoulQuestion {
  type: 'noul';
  name: string;
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface DecisionChoiceQuestion {
  type: 'choice';
  name: string;
  instructions: string;
  // Option value mapped to a description, or null when the value is
  // self-explanatory. Order is irrelevant for a Choice and preserved verbatim
  // so a same-protocol forward reaches the model unchanged.
  criteria: Record<string, string | null>;
}

export interface DecisionScoreQuestion {
  type: 'score';
  name: string;
  instructions: string;
  // Ordered from lowest to highest; the index is the level number. The model
  // returns a probability-weighted average, so the score can fall between two
  // levels.
  criteria: readonly string[];
}

export type DecisionQuestion = DecisionNoulQuestion | DecisionChoiceQuestion | DecisionScoreQuestion;

export interface CanonicalDecisionRequest {
  // The wire body as received, so a same-protocol forward can preserve vendor
  // extensions the canonical form does not model.
  raw: Record<string, unknown>;
  state: DecisionState;
  // Insertion order matches the caller's request and is preserved on a
  // same-protocol forward.
  questions: readonly DecisionQuestion[];
}

export interface DecisionNoulAnswer {
  type: 'noul';
  name: string;
  // Probability that the answer is yes. Noul has no separate confidence.
  noul: number;
}

export interface DecisionChoiceAnswer {
  type: 'choice';
  name: string;
  choice: string;
  confidence?: number;
  // Option value to probability. Sums to 1.
  probabilities?: Record<string, number>;
}

export interface DecisionScoreAnswer {
  type: 'score';
  name: string;
  score: number;
  confidence?: number;
  // Level label keyed by level number. Providers key these by string over
  // HTTP; the SDKs key them by int, so we normalize to string keys.
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
}

export type DecisionAnswer = DecisionNoulAnswer | DecisionChoiceAnswer | DecisionScoreAnswer;

export interface CanonicalDecisionResponse {
  raw: Record<string, unknown>;
  // The versioned model id the upstream reports answering with. Log it: a
  // provider may update weights behind a stable alias.
  model?: string;
  answers: readonly DecisionAnswer[];
  inputTokens?: number;
  outputTokens?: number;
}

export interface ParsedDecisionRequest {
  model: string;
  request: CanonicalDecisionRequest;
}

export { DEFAULT_DECISION_PATHS } from './default-paths.ts';
export {
  decisionRequestIncompatibility,
  parseDecisionRequest,
  parseDecisionResponse,
  parseDecisionUsage,
  renderDecisionResponse,
  serializeDecisionRequest,
} from './translate.ts';
