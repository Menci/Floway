import type {
  CanonicalDecisionRequest,
  CanonicalDecisionResponse,
  DecisionAnswer,
  DecisionChoiceQuestion,
  DecisionNoulQuestion,
  DecisionQuestion,
  DecisionScoreQuestion,
  DecisionState,
  ParsedDecisionRequest,
} from './index.ts';
import type { DecisionProtocol, DecisionQuestionType, DecisionTarget } from '../common/models.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
};

const finiteNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
};

// The System One contract allows 2–255 options for a Choice and 2–10 levels for
// a Score. Every implementation copies those bounds today; a target with
// different limits narrows through `questionTypes` before reaching here.
// https://docs.typesafe.ai/primitives/choice
const CHOICE_OPTION_MIN = 2;
const CHOICE_OPTION_MAX = 255;
const SCORE_LEVEL_MIN = 2;
const SCORE_LEVEL_MAX = 10;

const decisionState = (value: unknown): DecisionState => {
  if (typeof value === 'string') return value;
  if (isRecord(value)) return value;
  if (Array.isArray(value)) return value;
  throw new Error('state must be a string, an object, or an array');
};

const noulQuestion = (name: string, value: Record<string, unknown>): DecisionNoulQuestion => {
  const instructions = requiredString(value.instructions, `questions.${name}.instructions`);
  if (value.criteria === undefined) return { type: 'noul', name, instructions };
  if (!isRecord(value.criteria)) throw new Error(`questions.${name}.criteria must be an object`);
  const trueCriterion = value.criteria.true;
  const falseCriterion = value.criteria.false;
  if (trueCriterion !== undefined && typeof trueCriterion !== 'string') throw new Error(`questions.${name}.criteria.true must be a string`);
  if (falseCriterion !== undefined && typeof falseCriterion !== 'string') throw new Error(`questions.${name}.criteria.false must be a string`);
  return {
    type: 'noul',
    name,
    instructions,
    criteria: {
      ...(trueCriterion === undefined ? {} : { true: trueCriterion }),
      ...(falseCriterion === undefined ? {} : { false: falseCriterion }),
    },
  };
};

const choiceQuestion = (name: string, value: Record<string, unknown>): DecisionChoiceQuestion => {
  const instructions = requiredString(value.instructions, `questions.${name}.instructions`);
  if (!isRecord(value.criteria)) throw new Error(`questions.${name}.criteria must be an object`);
  const options = Object.entries(value.criteria).map(([option, description]) => {
    if (description !== null && typeof description !== 'string') {
      throw new Error(`questions.${name}.criteria.${option} must be a string or null`);
    }
    return [option, description] as const;
  });
  if (options.length < CHOICE_OPTION_MIN || options.length > CHOICE_OPTION_MAX) {
    throw new Error(`questions.${name}.criteria must have ${CHOICE_OPTION_MIN}-${CHOICE_OPTION_MAX} options`);
  }
  return { type: 'choice', name, instructions, criteria: Object.fromEntries(options) };
};

const scoreQuestion = (name: string, value: Record<string, unknown>): DecisionScoreQuestion => {
  const instructions = requiredString(value.instructions, `questions.${name}.instructions`);
  if (!Array.isArray(value.criteria)) throw new Error(`questions.${name}.criteria must be an array of level descriptions`);
  if (value.criteria.length < SCORE_LEVEL_MIN || value.criteria.length > SCORE_LEVEL_MAX) {
    throw new Error(`questions.${name}.criteria must have ${SCORE_LEVEL_MIN}-${SCORE_LEVEL_MAX} levels`);
  }
  const levels = value.criteria.map((level, index) => {
    if (typeof level !== 'string') throw new Error(`questions.${name}.criteria[${index}] must be a string`);
    return level;
  });
  return { type: 'score', name, instructions, criteria: levels };
};

const questionFromEntry = (name: string, value: unknown): DecisionQuestion => {
  if (!isRecord(value)) throw new Error(`questions.${name} must be an object`);
  const type = value.type;
  if (type === 'noul') return noulQuestion(name, value);
  if (type === 'choice') return choiceQuestion(name, value);
  if (type === 'score') return scoreQuestion(name, value);
  throw new Error(`questions.${name}.type must be one of noul, choice, score`);
};

// Ingress is the System One contract only: `/v1/systemone` is the single
// decision route Floway exposes. System One rejects unknown top-level
// arguments with a 400, so parsing mirrors that strictness instead of silently
// dropping fields the model never sees.
const SYSTEMONE_TOP_LEVEL_FIELDS = new Set(['model', 'state', 'questions']);

export const parseDecisionRequest = (value: unknown): ParsedDecisionRequest => {
  if (!isRecord(value)) throw new Error('Decision request body must be an object');
  const model = requiredString(value.model, 'model');
  const unknownFields = Object.keys(value).filter(key => !SYSTEMONE_TOP_LEVEL_FIELDS.has(key));
  if (unknownFields.length > 0) throw new Error(`System One does not support ${unknownFields.join(', ')}`);
  if (value.state === undefined) throw new Error('state is required');
  const state = decisionState(value.state);
  if (!isRecord(value.questions)) throw new Error('questions must be an object keyed by question name');
  const questions = Object.entries(value.questions).map(([name, entry]) => questionFromEntry(name, entry));
  if (questions.length === 0) throw new Error('questions must contain at least one question');
  return { model, request: { raw: value, state, questions } };
};

const questionTypes = (request: CanonicalDecisionRequest): readonly DecisionQuestionType[] =>
  request.questions.map(question => question.type);

// A target accepts a request when its dialect can express every question and
// its declared capability covers every question type. The protocol name alone
// never decides this: a dialect may accept a primitive another rejects.
export const decisionRequestIncompatibility = (target: DecisionTarget, request: CanonicalDecisionRequest): string | null => {
  if (target.questionTypes !== undefined) {
    const supported = new Set<DecisionQuestionType>(target.questionTypes);
    const unsupported = questionTypes(request).filter(type => !supported.has(type));
    if (unsupported.length > 0) {
      return `${[...new Set(unsupported)].join(', ')} questions require a target that answers them`;
    }
  }
  return null;
};

const serializeNoul = (question: DecisionNoulQuestion): Record<string, unknown> => ({
  type: 'noul',
  instructions: question.instructions,
  ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
});

const serializeChoice = (question: DecisionChoiceQuestion): Record<string, unknown> => ({
  type: 'choice',
  instructions: question.instructions,
  criteria: question.criteria,
});

const serializeScore = (question: DecisionScoreQuestion): Record<string, unknown> => ({
  type: 'score',
  instructions: question.instructions,
  criteria: question.criteria,
});

const serializeQuestion = (question: DecisionQuestion): Record<string, unknown> => {
  if (question.type === 'noul') return serializeNoul(question);
  if (question.type === 'choice') return serializeChoice(question);
  return serializeScore(question);
};

// System One question map keyed by the caller's name. A same-protocol forward
// returns the raw body so vendor extensions survive verbatim.
const serializeSystemOne = (model: string, request: CanonicalDecisionRequest): Record<string, unknown> => {
  if (request.raw.model === model && request.raw.state !== undefined && isRecord(request.raw.questions)) {
    return { ...request.raw, model };
  }
  return {
    model,
    state: request.state,
    questions: Object.fromEntries(request.questions.map(question => [question.name, serializeQuestion(question)])),
  };
};

// OpenAI's Decisions shape: `input`, an array of questions whose yes/no type is
// `predicate`, choice options as `{value, description?}`, and score levels as
// `{label, description?}`.
// https://developers.openai.com/api/docs/guides/decisions
const serializeOpenAIDecisions = (model: string, request: CanonicalDecisionRequest): Record<string, unknown> => ({
  model,
  input: request.state,
  questions: request.questions.map(question => {
    if (question.type === 'noul') {
      return { type: 'predicate', name: question.name, instructions: question.instructions };
    }
    if (question.type === 'choice') {
      return {
        type: 'choice',
        name: question.name,
        instructions: question.instructions,
        choices: Object.entries(question.criteria).map(([value, description]) => ({
          value,
          ...(description === null ? {} : { description }),
        })),
      };
    }
    return {
      type: 'score',
      name: question.name,
      instructions: question.instructions,
      levels: question.criteria.map(label => ({ label })),
    };
  }),
});

export const serializeDecisionRequest = (protocol: DecisionProtocol, model: string, request: CanonicalDecisionRequest): Record<string, unknown> => {
  switch (protocol) {
  case 'systemone': return serializeSystemOne(model, request);
  case 'openai-decisions': return serializeOpenAIDecisions(model, request);
  default: protocol satisfies never; throw new Error(`Unhandled decision protocol: ${protocol as string}`);
  }
};

const optionalNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const numberRecord = (value: unknown): Record<string, number> | undefined => {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
};

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
};

// System One answers key off the question name and carry `noul`/`choice`/
// `score` with their probabilities. Level keys stay string-keyed, matching the
// HTTP contract. A provider that rounds to two decimals and one that reports
// full precision both parse here unchanged.
const answerFromEntry = (name: string, value: unknown): DecisionAnswer => {
  if (!isRecord(value)) throw new Error(`answers.${name} must be an object`);
  if (value.type === 'noul') {
    return { type: 'noul', name, noul: finiteNumber(value.noul, `answers.${name}.noul`) };
  }
  if (value.type === 'choice') {
    const choice = requiredString(value.choice, `answers.${name}.choice`);
    const confidence = optionalNumber(value.confidence);
    const probabilities = numberRecord(value.probabilities);
    return {
      type: 'choice',
      name,
      choice,
      ...(confidence === undefined ? {} : { confidence }),
      ...(probabilities === undefined ? {} : { probabilities }),
    };
  }
  if (value.type === 'score') {
    const score = finiteNumber(value.score, `answers.${name}.score`);
    const confidence = optionalNumber(value.confidence);
    const probabilities = numberRecord(value.probabilities);
    const legend = stringRecord(value.legend);
    return {
      type: 'score',
      name,
      score,
      ...(confidence === undefined ? {} : { confidence }),
      ...(probabilities === undefined ? {} : { probabilities }),
      ...(legend === undefined ? {} : { legend }),
    };
  }
  throw new Error(`answers.${name}.type must be one of noul, choice, score`);
};

const parseSystemOneResponse = (body: Record<string, unknown>): CanonicalDecisionResponse => {
  if (!isRecord(body.answers)) throw new Error('answers must be an object keyed by question name');
  const answers = Object.entries(body.answers).map(([name, entry]) => answerFromEntry(name, entry));
  return {
    raw: body,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    answers,
  };
};

const openAIPredicateAnswer = (answer: Record<string, unknown>): DecisionAnswer => {
  const name = requiredString(answer.name, 'answers[].name');
  return { type: 'noul', name, noul: finiteNumber(answer.probability, `answers.${name}.probability`) };
};

const openAIProbabilityRecord = (value: unknown, field: string): Record<string, number> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) continue;
    if (typeof entry.value !== 'string' && typeof entry.value !== 'number') continue;
    out[String(entry.value)] = finiteNumber(entry.probability, `${field}[${index}].probability`);
  }
  return out;
};

const parseOpenAIDecisionsResponse = (body: Record<string, unknown>): CanonicalDecisionResponse => {
  if (!Array.isArray(body.answers)) throw new Error('answers must be an array');
  const answers: DecisionAnswer[] = body.answers.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`answers[${index}] must be an object`);
    if (entry.type === 'predicate') return openAIPredicateAnswer(entry);
    const name = requiredString(entry.name, 'answers[].name');
    if (entry.type === 'choice') {
      const confidence = optionalNumber(entry.confidence);
      const probabilities = openAIProbabilityRecord(entry.probabilities, `answers.${name}.probabilities`);
      return {
        type: 'choice',
        name,
        choice: requiredString(entry.choice, `answers.${name}.choice`),
        ...(confidence === undefined ? {} : { confidence }),
        ...(probabilities === undefined ? {} : { probabilities }),
      };
    }
    if (entry.type === 'score') {
      const confidence = optionalNumber(entry.confidence);
      const probabilities = openAIProbabilityRecord(entry.probabilities, `answers.${name}.probabilities`);
      const legend: Record<string, string> = {};
      if (Array.isArray(entry.probabilities)) {
        for (const level of entry.probabilities) {
          if (isRecord(level) && typeof level.value === 'number' && typeof level.label === 'string') {
            legend[String(level.value)] = level.label;
          }
        }
      }
      return {
        type: 'score',
        name,
        score: finiteNumber(entry.score, `answers.${name}.score`),
        ...(confidence === undefined ? {} : { confidence }),
        ...(probabilities === undefined ? {} : { probabilities }),
        ...(Object.keys(legend).length === 0 ? {} : { legend }),
      };
    }
    // A refusal answers one question while the rest still resolve.
    throw new Error(`answers[${index}].type ${JSON.stringify(entry.type)} is not supported`);
  });
  return {
    raw: body,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    answers,
  };
};

export const parseDecisionResponse = (protocol: DecisionProtocol, body: Record<string, unknown>): CanonicalDecisionResponse => {
  switch (protocol) {
  case 'systemone': return parseSystemOneResponse(body);
  case 'openai-decisions': return parseOpenAIDecisionsResponse(body);
  default: protocol satisfies never; throw new Error(`Unhandled decision protocol: ${protocol as string}`);
  }
};

// Output tokens are free for every decision model we route, so only input
// tokens reach billing. Both dialects keep the counts under `usage`.
const usageNumbers = (body: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } => {
  if (!isRecord(body.usage)) return {};
  const inputTokens = optionalNumber(body.usage.input_tokens ?? body.usage.prompt_tokens);
  const outputTokens = optionalNumber(body.usage.output_tokens ?? body.usage.completion_tokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
};

export const parseDecisionUsage = (body: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } => usageNumbers(body);

const renderNoul = (answer: DecisionAnswer & { type: 'noul' }): Record<string, unknown> => ({
  type: 'noul',
  ...(answer.noul === undefined ? {} : { noul: answer.noul }),
});

// Rendering always produces the System One answer shape, the only decision
// ingress Floway exposes: answers keyed by question name, with probabilities
// and level labels preserved as the target reported them.
export const renderDecisionResponse = (response: CanonicalDecisionResponse): Record<string, unknown> => {
  const answers: Record<string, unknown> = {};
  for (const answer of response.answers) {
    if (answer.type === 'noul') {
      answers[answer.name] = { type: 'noul', noul: answer.noul };
    } else if (answer.type === 'choice') {
      answers[answer.name] = {
        type: 'choice',
        choice: answer.choice,
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
      };
    } else {
      answers[answer.name] = {
        type: 'score',
        score: answer.score,
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
        ...(answer.legend === undefined ? {} : { legend: answer.legend }),
      };
    }
  }
  const usage = usageNumbers(response.raw);
  return {
    ...(response.model === undefined ? {} : { model: response.model }),
    answers,
    ...(Object.keys(usage).length === 0
      ? {}
      : { usage: {
        ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
      } }),
  };
};
