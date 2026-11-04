import type {
  CanonicalDecisionRequest,
  CanonicalDecisionResponse,
  DecisionAnswer,
  DecisionChoiceOption,
  DecisionChoiceQuestion,
  DecisionContentPart,
  DecisionInstructions,
  DecisionNoulQuestion,
  DecisionQuestion,
  DecisionScoreLevel,
  DecisionScoreQuestion,
  DecisionState,
  ParsedDecisionRequest,
} from './index.ts';
import type { DecisionProtocol, DecisionQuestionType, DecisionSourceProtocol, DecisionTarget } from '../common/models.ts';

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
// a Score; the OpenAI contract matches. A target with different limits narrows
// through `questionTypes` before reaching here.
// https://docs.typesafe.ai/primitives/choice
const CHOICE_OPTION_MIN = 2;
const CHOICE_OPTION_MAX = 255;
const SCORE_LEVEL_MIN = 2;
const SCORE_LEVEL_MAX = 10;

const isImageDetail = (value: unknown): value is 'low' | 'high' | 'auto' | 'original' =>
  value === 'low' || value === 'high' || value === 'auto' || value === 'original';

const decided = <T>(value: unknown, field: string, check: (candidate: unknown) => candidate is T, allowed: string): T => {
  if (!check(value)) throw new Error(`${field} must be one of ${allowed}`);
  return value;
};

// --- OpenAI content parts -> canonical parts -------------------------------

const openAIContentPart = (part: unknown, field: string): DecisionContentPart => {
  if (!isRecord(part)) throw new Error(`${field} must be an object`);
  if (part.type === 'input_text') return { type: 'text', text: requiredString(part.text, `${field}.text`) };
  if (part.type === 'input_image') {
    const detail = part.detail ?? undefined;
    return {
      type: 'image',
      imageUrl: requiredString(part.image_url, `${field}.image_url`),
      ...(detail === undefined ? {} : { detail: decided(detail, `${field}.detail`, isImageDetail, 'low, high, auto, original') }),
    };
  }
  if (part.type === 'input_json') {
    if (!isRecord(part.data) && !Array.isArray(part.data)) throw new Error(`${field}.data must be an object or an array`);
    return { type: 'json', data: part.data as Record<string, unknown> | readonly unknown[] };
  }
  throw new Error(`${field}.type ${JSON.stringify(part.type)} is not supported`);
};

const openAIContent = (content: unknown, field: string): readonly DecisionContentPart[] | string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) throw new Error(`${field} must be a string or a non-empty array of parts`);
  return content.map((part, index) => openAIContentPart(part, `${field}[${index}]`));
};

const OPENAI_MESSAGE_ROLES = new Set(['user', 'developer', 'system', 'assistant']);

// OpenAI `input` may be a string or an ordered list of messages with function
// calls and tool outputs. System One has no notion of turns, so the canonical
// form flattens text, JSON, and images into one ordered evidence list; a target
// that reads images receives them.
const openAIState = (input: unknown): DecisionState => {
  if (typeof input === 'string') return { kind: 'text', value: input };
  if (!Array.isArray(input) || input.length === 0) throw new Error('input must be a string or a non-empty array');
  const parts: DecisionContentPart[] = [];
  for (const [index, item] of input.entries()) {
    if (!isRecord(item)) throw new Error(`input[${index}] must be an object`);
    if (!OPENAI_MESSAGE_ROLES.has(String(item.role))) throw new Error(`input[${index}].role is not supported`);
    const content = openAIContent(item.content, `input[${index}].content`);
    if (typeof content === 'string') parts.push({ type: 'text', text: content });
    else parts.push(...content);
  }
  // A sole JSON part keeps its structure; every other mix becomes ordered parts.
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.type === 'json') return { kind: 'json', value: only.data };
  return { kind: 'parts', parts };
};

// --- System One request -> canonical --------------------------------------

// System One rejects unknown top-level arguments with a 400, so parsing mirrors
// that strictness instead of silently dropping fields the model never sees.
// `assets` is accepted so an image-bearing request survives; the assets stay
// opaque and ride through `raw` on a same-protocol forward.
const SYSTEMONE_TOP_LEVEL_FIELDS = new Set(['model', 'state', 'questions', 'assets']);

// System One instructions may be structured data; keep the text form verbatim
// and preserve structure by serializing it once.
const systemOneInstructions = (value: unknown, field: string): DecisionInstructions => {
  if (typeof value === 'string') return value;
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  throw new Error(`${field} must be a string`);
};

const systemOneState = (value: unknown): DecisionState => {
  if (typeof value === 'string') return { kind: 'text', value };
  if (isRecord(value)) return { kind: 'json', value };
  if (Array.isArray(value)) return { kind: 'json', value: value as readonly unknown[] };
  throw new Error('state must be a string, an object, or an array');
};

const systemOneNoul = (name: string, value: Record<string, unknown>): DecisionNoulQuestion => {
  const instructions = systemOneInstructions(value.instructions, `questions.${name}.instructions`);
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

const systemOneChoice = (name: string, value: Record<string, unknown>): DecisionChoiceQuestion => {
  const instructions = systemOneInstructions(value.instructions, `questions.${name}.instructions`);
  if (!isRecord(value.criteria)) throw new Error(`questions.${name}.criteria must be an object`);
  const options: DecisionChoiceOption[] = Object.entries(value.criteria).map(([option, description]) => {
    if (description !== null && typeof description !== 'string') {
      throw new Error(`questions.${name}.criteria.${option} must be a string or null`);
    }
    return description === null ? { value: option } : { value: option, description };
  });
  if (options.length < CHOICE_OPTION_MIN || options.length > CHOICE_OPTION_MAX) {
    throw new Error(`questions.${name}.criteria must have ${CHOICE_OPTION_MIN}-${CHOICE_OPTION_MAX} options`);
  }
  return { type: 'choice', name, instructions, options };
};

const systemOneScore = (name: string, value: Record<string, unknown>): DecisionScoreQuestion => {
  const instructions = systemOneInstructions(value.instructions, `questions.${name}.instructions`);
  if (!Array.isArray(value.criteria)) throw new Error(`questions.${name}.criteria must be an array of level descriptions`);
  if (value.criteria.length < SCORE_LEVEL_MIN || value.criteria.length > SCORE_LEVEL_MAX) {
    throw new Error(`questions.${name}.criteria must have ${SCORE_LEVEL_MIN}-${SCORE_LEVEL_MAX} levels`);
  }
  const levels: DecisionScoreLevel[] = value.criteria.map((level, index) => {
    if (typeof level !== 'string') throw new Error(`questions.${name}.criteria[${index}] must be a string`);
    return { label: level };
  });
  return { type: 'score', name, instructions, levels };
};

const parseSystemOneQuestion = (name: string, value: unknown): DecisionQuestion => {
  if (!isRecord(value)) throw new Error(`questions.${name} must be an object`);
  if (value.type === 'noul') return systemOneNoul(name, value);
  if (value.type === 'choice') return systemOneChoice(name, value);
  if (value.type === 'score') return systemOneScore(name, value);
  throw new Error(`questions.${name}.type must be one of noul, choice, score`);
};

const parseSystemOneRequest = (value: Record<string, unknown>): CanonicalDecisionRequest => {
  const unknownFields = Object.keys(value).filter(key => !SYSTEMONE_TOP_LEVEL_FIELDS.has(key));
  if (unknownFields.length > 0) throw new Error(`System One does not support ${unknownFields.join(', ')}`);
  if (value.state === undefined) throw new Error('state is required');
  const state = systemOneState(value.state);
  if (!isRecord(value.questions)) throw new Error('questions must be an object keyed by question name');
  const questions = Object.entries(value.questions).map(([name, entry]) => parseSystemOneQuestion(name, entry));
  if (questions.length === 0) throw new Error('questions must contain at least one question');
  return { sourceProtocol: 'systemone', raw: value, state, questions };
};

// --- OpenAI request -> canonical ------------------------------------------

const OPENAI_TOP_LEVEL_FIELDS = new Set([
  'model', 'input', 'questions',
  // Caller controls the target reads when it speaks this dialect; preserved in
  // `raw` for a same-protocol forward rather than modelled canonically.
  'prompt_cache_key', 'prompt_cache_options', 'safety_identifier',
]);

const bounded = <T>(items: T[], field: string, min: number, max: number): readonly T[] => {
  if (items.length < min || items.length > max) throw new Error(`${field} must have ${min}-${max} entries`);
  return items;
};

// Choice values are typed in this dialect; a string and a boolean that read the
// same are distinct options.
const openAIChoiceOption = (value: unknown, field: string): DecisionChoiceOption => {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const option = value.value;
  if (typeof option !== 'string' && typeof option !== 'boolean') throw new Error(`${field}.value must be a string or boolean`);
  if (value.description !== undefined && typeof value.description !== 'string') throw new Error(`${field}.description must be a string`);
  return value.description === undefined ? { value: option } : { value: option, description: value.description };
};

const openAILevel = (value: unknown, field: string): DecisionScoreLevel => {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const label = requiredString(value.label, `${field}.label`);
  if (value.description !== undefined && typeof value.description !== 'string') throw new Error(`${field}.description must be a string`);
  return value.description === undefined ? { label } : { label, description: value.description };
};

const openAIQuestion = (value: unknown, index: number): DecisionQuestion => {
  if (!isRecord(value)) throw new Error(`questions[${index}] must be an object`);
  const name = requiredString(value.name, `questions[${index}].name`);
  const instructions = openAIContent(value.instructions, `questions[${index}].instructions`);
  if (value.type === 'predicate') return { type: 'noul', name, instructions };
  if (value.type === 'choice') {
    if (!Array.isArray(value.choices)) throw new Error(`questions[${index}].choices must be an array`);
    const options = value.choices.map((choice, choiceIndex) => openAIChoiceOption(choice, `questions[${index}].choices[${choiceIndex}]`));
    return { type: 'choice', name, instructions, options: bounded(options, `questions[${index}].choices`, CHOICE_OPTION_MIN, CHOICE_OPTION_MAX) };
  }
  if (value.type === 'score') {
    if (!Array.isArray(value.levels)) throw new Error(`questions[${index}].levels must be an array`);
    const levels = value.levels.map((level, levelIndex) => openAILevel(level, `questions[${index}].levels[${levelIndex}]`));
    return { type: 'score', name, instructions, levels: bounded(levels, `questions[${index}].levels`, SCORE_LEVEL_MIN, SCORE_LEVEL_MAX) };
  }
  throw new Error(`questions[${index}].type must be one of predicate, choice, score`);
};

const parseOpenAIDecisionsRequest = (value: Record<string, unknown>): CanonicalDecisionRequest => {
  const unknownFields = Object.keys(value).filter(key => !OPENAI_TOP_LEVEL_FIELDS.has(key));
  if (unknownFields.length > 0) throw new Error(`OpenAI Decisions does not support ${unknownFields.join(', ')}`);
  if (value.input === undefined) throw new Error('input is required');
  const state = openAIState(value.input);
  if (!Array.isArray(value.questions)) throw new Error('questions must be an array');
  const questions = value.questions.map((entry, index) => openAIQuestion(entry, index));
  if (questions.length === 0) throw new Error('questions must contain at least one question');
  return { sourceProtocol: 'openai-decisions', raw: value, state, questions };
};

export const parseDecisionRequest = (protocol: DecisionSourceProtocol, value: unknown): ParsedDecisionRequest => {
  if (!isRecord(value)) throw new Error('Decision request body must be an object');
  const model = requiredString(value.model, 'model');
  switch (protocol) {
  case 'systemone': return { model, request: parseSystemOneRequest(value) };
  case 'openai-decisions': return { model, request: parseOpenAIDecisionsRequest(value) };
  default: protocol satisfies never; throw new Error(`Unhandled decision protocol: ${protocol as string}`);
  }
};

// --- compatibility --------------------------------------------------------

const requestQuestionTypes = (request: CanonicalDecisionRequest): readonly DecisionQuestionType[] =>
  request.questions.map(question => question.type);

const hasImage = (request: CanonicalDecisionRequest): boolean =>
  (request.state.kind === 'parts' && request.state.parts.some(part => part.type === 'image'))
  || request.questions.some(question => Array.isArray(question.instructions) && question.instructions.some(part => part.type === 'image'));

// System One keys options by string, so `true` and `"true"` collapse there.
const hasTypedChoiceCollision = (request: CanonicalDecisionRequest): boolean =>
  request.questions.some(question => {
    if (question.type !== 'choice') return false;
    const seen = new Set<string>();
    for (const option of question.options) {
      const key = String(option.value);
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  });

// A target accepts a request when its dialect can express every question and
// its declared capability covers every question type. The protocol name alone
// never decides this: a dialect may accept a primitive another rejects.
export const decisionRequestIncompatibility = (target: DecisionTarget, request: CanonicalDecisionRequest): string | null => {
  if (target.questionTypes !== undefined) {
    const supported = new Set<DecisionQuestionType>(target.questionTypes);
    const unsupported = requestQuestionTypes(request).filter(type => !supported.has(type));
    if (unsupported.length > 0) {
      return `${[...new Set(unsupported)].join(', ')} questions require a target that answers them`;
    }
  }
  if (target.protocol === 'systemone' && hasTypedChoiceCollision(request)) {
    return 'choice values that differ only by type cannot be represented on a System One target';
  }
  // Images are only representable where the target reads them; a target that
  // does not would silently drop the evidence.
  if (hasImage(request) && target.images !== true) {
    return 'image evidence requires a target that reads images';
  }
  return null;
};

// --- serialization --------------------------------------------------------

const systemOneStateValue = (state: DecisionState): unknown => {
  if (state.kind !== 'parts') return state.value;
  return state.parts.map(part => part.type === 'text' ? part.text : part.type === 'json' ? JSON.stringify(part.data) : '').join('\n');
};

const serializeSystemOne = (model: string, request: CanonicalDecisionRequest): Record<string, unknown> => {
  const questions = Object.fromEntries(request.questions.map(question => {
    if (question.type === 'noul') {
      return [question.name, {
        type: 'noul',
        instructions: question.instructions,
        ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
      }];
    }
    if (question.type === 'choice') {
      return [question.name, {
        type: 'choice',
        instructions: question.instructions,
        criteria: Object.fromEntries(question.options.map(option => [String(option.value), option.description ?? null])),
      }];
    }
    return [question.name, {
      type: 'score',
      instructions: question.instructions,
      criteria: question.levels.map(level => level.label),
    }];
  }));
  return { model, state: systemOneStateValue(request.state), questions };
};

const openAIContentParts = (parts: readonly DecisionContentPart[]): readonly Record<string, unknown>[] => parts.map(part => {
  if (part.type === 'text') return { type: 'input_text', text: part.text };
  if (part.type === 'image') return { type: 'input_image', image_url: part.imageUrl, ...(part.detail === undefined ? {} : { detail: part.detail }) };
  return { type: 'input_json', data: part.data };
});

const openAIInstructions = (instructions: DecisionInstructions): unknown =>
  typeof instructions === 'string' ? instructions : openAIContentParts(instructions);

// OpenAI's Decisions shape: `input`, an array of questions whose yes/no type is
// `predicate`, choice options as `{value, description?}`, and score levels as
// `{label, description?}`.
// https://developers.openai.com/api/docs/guides/decisions
const serializeOpenAIDecisions = (model: string, request: CanonicalDecisionRequest): Record<string, unknown> => ({
  model,
  input: request.state.kind === 'parts'
    ? [{ role: 'user', content: openAIContentParts(request.state.parts) }]
    : request.state.value,
  questions: request.questions.map(question => {
    if (question.type === 'noul') {
      return { type: 'predicate', name: question.name, instructions: openAIInstructions(question.instructions) };
    }
    if (question.type === 'choice') {
      return {
        type: 'choice',
        name: question.name,
        instructions: openAIInstructions(question.instructions),
        choices: question.options.map(option => ({
          value: option.value,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      };
    }
    return {
      type: 'score',
      name: question.name,
      instructions: openAIInstructions(question.instructions),
      levels: question.levels.map(level => ({
        label: level.label,
        ...(level.description === undefined ? {} : { description: level.description }),
      })),
    };
  }),
});

// A target on the client's own dialect receives the body as sent, so vendor
// extensions the canonical form does not model survive verbatim; only the
// model is replaced. A target on another dialect gets the canonical fields
// re-serialized into that dialect.
export const serializeDecisionRequest = (protocol: DecisionProtocol, model: string, request: CanonicalDecisionRequest): Record<string, unknown> => {
  if (protocol === request.sourceProtocol) return { ...request.raw, model };
  switch (protocol) {
  case 'systemone': return serializeSystemOne(model, request);
  case 'openai-decisions': return serializeOpenAIDecisions(model, request);
  default: protocol satisfies never; throw new Error(`Unhandled decision protocol: ${protocol as string}`);
  }
};

// --- response parsing -----------------------------------------------------

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
// HTTP contract.
const systemOneAnswer = (name: string, value: unknown): DecisionAnswer => {
  if (!isRecord(value)) throw new Error(`answers.${name} must be an object`);
  if (value.type === 'noul') return { type: 'noul', name, noul: finiteNumber(value.noul, `answers.${name}.noul`) };
  const confidence = optionalNumber(value.confidence);
  if (value.type === 'choice') {
    const choice = requiredString(value.choice, `answers.${name}.choice`);
    const record = numberRecord(value.probabilities);
    return {
      type: 'choice',
      name,
      choice,
      ...(confidence === undefined ? {} : { confidence }),
      ...(record === undefined ? {} : { probabilities: Object.entries(record).map(([option, probability]) => ({ value: option, probability })) }),
    };
  }
  if (value.type === 'score') {
    const score = finiteNumber(value.score, `answers.${name}.score`);
    const legend = stringRecord(value.legend);
    const record = numberRecord(value.probabilities);
    return {
      type: 'score',
      name,
      score,
      ...(confidence === undefined ? {} : { confidence }),
      ...(record === undefined
        ? {}
        : {
            probabilities: Object.entries(record).map(([level, probability]) => ({
              value: Number(level),
              ...(legend?.[level] === undefined ? {} : { label: legend[level] }),
              probability,
            })),
          }),
      ...(legend === undefined ? {} : { legend }),
    };
  }
  throw new Error(`answers.${name}.type must be one of noul, choice, score`);
};

const parseSystemOneResponse = (body: Record<string, unknown>): CanonicalDecisionResponse => {
  if (!isRecord(body.answers)) throw new Error('answers must be an object keyed by question name');
  return {
    raw: body,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    answers: Object.entries(body.answers).map(([name, entry]) => systemOneAnswer(name, entry)),
  };
};

const openAITypedProbabilities = (value: unknown, field: string): readonly { value: string | boolean; probability: number }[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${field}[${index}] must be an object`);
    const raw = entry.value;
    if (typeof raw !== 'string' && typeof raw !== 'boolean') throw new Error(`${field}[${index}].value must be a string or boolean`);
    return { value: raw, probability: finiteNumber(entry.probability, `${field}[${index}].probability`) };
  });
};

const parseOpenAIDecisionsResponse = (body: Record<string, unknown>): CanonicalDecisionResponse => {
  if (!Array.isArray(body.answers)) throw new Error('answers must be an array');
  const answers: DecisionAnswer[] = body.answers.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`answers[${index}] must be an object`);
    const name = requiredString(entry.name, 'answers[].name');
    if (entry.type === 'predicate') return { type: 'noul', name, noul: finiteNumber(entry.probability, `answers.${name}.probability`) };
    const confidence = optionalNumber(entry.confidence);
    if (entry.type === 'choice') {
      const raw = entry.choice;
      if (typeof raw !== 'string' && typeof raw !== 'boolean') throw new Error(`answers.${name}.choice must be a string or boolean`);
      const probabilities = openAITypedProbabilities(entry.probabilities, `answers.${name}.probabilities`);
      return { type: 'choice', name, choice: raw, ...(confidence === undefined ? {} : { confidence }), ...(probabilities === undefined ? {} : { probabilities }) };
    }
    if (entry.type === 'score') {
      const legend: Record<string, string> = {};
      const probabilities: { value: number; probability: number; label?: string }[] = [];
      if (Array.isArray(entry.probabilities)) {
        for (const [levelIndex, level] of entry.probabilities.entries()) {
          if (!isRecord(level)) throw new Error(`answers.${name}.probabilities[${levelIndex}] must be an object`);
          if (typeof level.value !== 'number') throw new Error(`answers.${name}.probabilities[${levelIndex}].value must be a number`);
          const probability = finiteNumber(level.probability, `answers.${name}.probabilities[${levelIndex}].probability`);
          if (typeof level.label === 'string') legend[String(level.value)] = level.label;
          probabilities.push({ value: level.value, ...(typeof level.label === 'string' ? { label: level.label } : {}), probability });
        }
      }
      return {
        type: 'score',
        name,
        score: finiteNumber(entry.score, `answers.${name}.score`),
        ...(confidence === undefined ? {} : { confidence }),
        ...(Array.isArray(entry.probabilities) ? { probabilities } : {}),
        ...(Object.keys(legend).length === 0 ? {} : { legend }),
      };
    }
    // A refusal answers one question while the rest still resolve; it carries no
    // typed value, so it is not surfaced as an answer.
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

// --- rendering ------------------------------------------------------------

const renderUsage = (response: CanonicalDecisionResponse): Record<string, unknown> | undefined => {
  const usage = usageNumbers(response.raw);
  if (Object.keys(usage).length === 0) return undefined;
  return {
    ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
  };
};

const renderSystemOneResponse = (response: CanonicalDecisionResponse): Record<string, unknown> => {
  const answers: Record<string, unknown> = {};
  for (const answer of response.answers) {
    if (answer.type === 'noul') {
      answers[answer.name] = { type: 'noul', noul: answer.noul };
    } else if (answer.type === 'choice') {
      answers[answer.name] = {
        type: 'choice',
        choice: String(answer.choice),
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        ...(answer.probabilities === undefined ? {} : { probabilities: Object.fromEntries(answer.probabilities.map(entry => [String(entry.value), entry.probability])) }),
      };
    } else {
      answers[answer.name] = {
        type: 'score',
        score: answer.score,
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        ...(answer.probabilities === undefined ? {} : { probabilities: Object.fromEntries(answer.probabilities.map(entry => [String(entry.value), entry.probability])) }),
        ...(answer.legend === undefined ? {} : { legend: answer.legend }),
      };
    }
  }
  const usage = renderUsage(response);
  return {
    ...(response.model === undefined ? {} : { model: response.model }),
    answers,
    ...(usage === undefined ? {} : { usage }),
  };
};

const renderOpenAIDecisionsResponse = (response: CanonicalDecisionResponse): Record<string, unknown> => {
  const answers = response.answers.map(answer => {
    if (answer.type === 'noul') return { type: 'predicate', name: answer.name, probability: answer.noul };
    if (answer.type === 'choice') {
      return {
        type: 'choice',
        name: answer.name,
        choice: answer.choice,
        ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
        ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities.map(entry => ({ value: entry.value, probability: entry.probability })) }),
      };
    }
    return {
      type: 'score',
      name: answer.name,
      score: answer.score,
      ...(answer.confidence === undefined ? {} : { confidence: answer.confidence }),
      ...(answer.probabilities === undefined
        ? {}
        : { probabilities: answer.probabilities.map(entry => ({ value: entry.value, ...(entry.label === undefined ? {} : { label: entry.label }), probability: entry.probability })) }),
    };
  });
  const usage = renderUsage(response);
  return {
    ...(response.model === undefined ? {} : { model: response.model }),
    answers,
    ...(usage === undefined ? {} : { usage }),
  };
};

export const renderDecisionResponse = (protocol: DecisionSourceProtocol, response: CanonicalDecisionResponse): Record<string, unknown> => {
  switch (protocol) {
  case 'systemone': return renderSystemOneResponse(response);
  case 'openai-decisions': return renderOpenAIDecisionsResponse(response);
  default: protocol satisfies never; throw new Error(`Unhandled decision protocol: ${protocol as string}`);
  }
};
