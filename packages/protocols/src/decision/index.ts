import type { DecisionSourceProtocol } from '../common/models.ts';

// A decision request carries evidence and typed questions. Both dialects can
// hold text, JSON, and images; the canonical form keeps all three so a target
// that reads images still receives them.
// https://developers.openai.com/api/reference/resources/decisions/methods/create
// https://docs.typesafe.ai/images
export interface DecisionTextPart {
  type: 'text';
  text: string;
}

export interface DecisionImagePart {
  type: 'image';
  // A base64 data URL or a publicly accessible HTTP(S) URL. File IDs are not
  // supported by either dialect.
  imageUrl: string;
  detail?: 'low' | 'high' | 'auto' | 'original';
}

export interface DecisionJsonPart {
  type: 'json';
  data: Record<string, unknown> | readonly unknown[];
}

export type DecisionContentPart = DecisionTextPart | DecisionImagePart | DecisionJsonPart;

// The evidence the questions are asked about. `text` and `json` are the two
// single-value forms System One accepts directly; `parts` keeps an ordered mix
// (including images) that only a target reading images can receive.
export type DecisionState =
  | { kind: 'text'; value: string }
  | { kind: 'json'; value: Record<string, unknown> | readonly unknown[] }
  | { kind: 'parts'; parts: readonly DecisionContentPart[] };

export type DecisionInstructions = string | readonly DecisionContentPart[];

// Choice values are typed: the OpenAI contract defines value as string or
// boolean and treats `true` and `"true"` as distinct options. System One keys
// options by string, so a target on that dialect cannot represent a collision
// between the two.
export interface DecisionChoiceOption {
  value: string | boolean;
  description?: string;
}

export interface DecisionScoreLevel {
  label: string;
  description?: string;
}

export interface DecisionNoulQuestion {
  type: 'noul';
  name: string;
  instructions: DecisionInstructions;
  criteria?: { true?: string; false?: string };
}

export interface DecisionChoiceQuestion {
  type: 'choice';
  name: string;
  instructions: DecisionInstructions;
  options: readonly DecisionChoiceOption[];
}

export interface DecisionScoreQuestion {
  type: 'score';
  name: string;
  instructions: DecisionInstructions;
  // Ordered from lowest to highest; the index is the level number. The model
  // returns a probability-weighted average, so the score can fall between two
  // levels.
  levels: readonly DecisionScoreLevel[];
}

export type DecisionQuestion = DecisionNoulQuestion | DecisionChoiceQuestion | DecisionScoreQuestion;

export interface CanonicalDecisionRequest {
  // The ingress dialect the client spoke. A request forwards to a target on the
  // same dialect opaquely; across dialects it is serialized from the canonical
  // fields below.
  sourceProtocol: DecisionSourceProtocol;
  // The wire body as received, so a same-protocol forward can preserve vendor
  // extensions the canonical form does not model.
  raw: Record<string, unknown>;
  state: DecisionState;
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
  choice: string | boolean;
  confidence?: number;
  // One entry per supplied option, summing to 1.
  probabilities?: readonly { value: string | boolean; probability: number }[];
}

export interface DecisionScoreAnswer {
  type: 'score';
  name: string;
  score: number;
  confidence?: number;
  // Level label keyed by level number. Providers key these by string over
  // HTTP; the SDKs key them by int, so we normalize to string keys.
  legend?: Record<string, string>;
  probabilities?: readonly { value: number; label?: string; probability: number }[];
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
