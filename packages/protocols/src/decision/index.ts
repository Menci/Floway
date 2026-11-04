import type { JsonNumber } from '../common/json.ts';
import type { DecisionProtocol } from '../common/models.ts';

// A decision request carries evidence and typed questions. Both dialects can
// hold text, JSON, and images, so the canonical form keeps all three. A System
// One target additionally gates images behind a vendor header this gateway
// sends only through a custom upstream's ingress rules.
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
// including images.
export type DecisionState =
  | { kind: 'text'; value: string }
  | { kind: 'json'; value: Record<string, unknown> | readonly unknown[]; images?: readonly DecisionImagePart[] }
  | { kind: 'parts'; parts: readonly DecisionContentPart[] };

// Anywhere a description goes — a question's instructions, a Choice option's
// description, a Score level, or a Noul's criteria — System One accepts text,
// a JSON object, a JSON array, or null, and reads structure as given. Both
// official SDKs type it identically:
// https://github.com/typesafe-ai/typesafe-typescript/blob/main/src/types.ts
// `type EntryType = string | Asset | TextWithAssets | { [key: string]:
//  ContentValue } | ContentValue[] | null`
export type DecisionEntry = string | Record<string, unknown> | readonly unknown[] | null;

// Instructions are text, an ordered content mix (the OpenAI shape), or any
// structured value. The array arm is ambiguous by itself: only the source
// dialect says whether it is a content-part list or a plain array, so
// serialization discriminates on `sourceProtocol`, never on the contents.
// https://docs.typesafe.ai/primitives#advanced-structure
export type DecisionInstructions = DecisionEntry;

// Choice values are typed: the OpenAI contract defines value as string or
// boolean and treats `true` and `"true"` as distinct options. System One keys
// options by string, so a target on that dialect cannot represent a collision
// between the two.
export interface DecisionChoiceOption {
  value: string | boolean;
  description?: DecisionEntry;
}

export interface DecisionScoreLevel {
  // A level is the whole description System One scores against, so it carries
  // the same string-or-structure shape as any other description.
  label: DecisionEntry;
  description?: DecisionEntry;
}

export interface DecisionNoulQuestion {
  type: 'noul';
  name: string;
  // Omitted or null is legal: a question may carry its whole meaning in
  // `criteria`.
  instructions?: DecisionInstructions;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry } | null;
}

export interface DecisionChoiceQuestion {
  type: 'choice';
  name: string;
  // Omitted or null is legal: a question may carry its whole meaning in
  // `criteria`.
  instructions?: DecisionInstructions;
  options: readonly DecisionChoiceOption[];
}

export interface DecisionScoreQuestion {
  type: 'score';
  name: string;
  // Omitted or null is legal: a question may carry its whole meaning in
  // `criteria`.
  instructions?: DecisionInstructions;
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
  sourceProtocol: DecisionProtocol;
  // The wire body as received, so a same-protocol forward can preserve vendor
  // extensions the canonical form does not model.
  raw: Record<string, unknown>;
  state: DecisionState;
  questions: readonly DecisionQuestion[];
}

// Probabilities keep the upstream's own number token: a parsed JavaScript
// number would re-serialize `1.0` as `1` and a value beyond the double range as
// `null`, and a decision answer is exactly the place those digits matter.
export interface DecisionNoulAnswer {
  type: 'noul';
  name: string;
  // Probability that the answer is yes. Noul has no separate confidence.
  noul: JsonNumber;
}

export interface DecisionChoiceAnswer {
  type: 'choice';
  name: string;
  choice: string | boolean;
  // Both dialects mark these required on a Choice answer.
  confidence: JsonNumber;
  // One entry per supplied option, summing to 1.
  probabilities: readonly { value: string | boolean; probability: JsonNumber }[];
}

export interface DecisionScoreAnswer {
  type: 'score';
  name: string;
  score: JsonNumber;
  // Both dialects mark these required on a Score answer.
  confidence: JsonNumber;
  // Level label keyed by level number. Every System One answer carries it; the
  // OpenAI shape has no separate legend and inlines each label instead.
  // System One echoes each level's criteria value verbatim, so a structured
  // criteria comes back structured.
  legend?: Record<string, DecisionEntry>;
  probabilities: readonly { value: number; label?: string; probability: JsonNumber }[];
}

// The model declined one question. The OpenAI dialect defines this answer; the
// System One dialect has no refusal case at all. It carries no probability; the
// standard defines no reason string.
export interface DecisionRefusalAnswer {
  type: 'refusal';
  name: string;
}

export type DecisionAnswer = DecisionNoulAnswer | DecisionChoiceAnswer | DecisionScoreAnswer | DecisionRefusalAnswer;

export interface CanonicalDecisionResponse {
  raw: Record<string, unknown>;
  // The model id the upstream reports answering with, rendered back to the
  // client. It can differ from the Floway model id, since a provider may update
  // weights behind a stable alias.
  model?: string;
  answers: readonly DecisionAnswer[];
}

export interface ParsedDecisionRequest {
  model: string;
  request: CanonicalDecisionRequest;
}

export { DEFAULT_DECISION_PATHS } from './default-paths.ts';
export {
  parseDecisionRequest,
  parseDecisionResponse,
  parseDecisionUsage,
  renderDecisionResponse,
  serializeDecisionRequest,
} from './translate.ts';
