import type {
  CanonicalDecisionRequest,
  CanonicalDecisionResponse,
  DecisionAnswer,
  DecisionChoiceOption,
  DecisionChoiceQuestion,
  DecisionContentPart,
  DecisionImagePart,
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

// OpenAI requires 2–255 choices and 2–10 levels; System One's schema permits a
// single option or level, and these stricter bounds are applied to both.
// https://developers.openai.com/api/reference/resources/decisions/methods/create
// https://docs.typesafe.ai/primitives/score
const CHOICE_OPTION_MIN = 2;
const CHOICE_OPTION_MAX = 255;
const SCORE_LEVEL_MIN = 2;
const SCORE_LEVEL_MAX = 10;

// --- System One assets ----------------------------------------------------

// A System One image is an entry in a top-level `assets` map, referenced by a
// string written where the image belongs. This gateway reads the base64 PNG or
// JPEG form.
// https://docs.typesafe.ai/images
const systemOneAssetImage = (reference: string, assets: unknown): DecisionImagePart | undefined => {
  if (!isRecord(assets) || !Object.hasOwn(assets, reference)) return undefined;
  const asset = assets[reference];
  if (!isRecord(asset) || (asset.type !== undefined && asset.type !== 'image')) return undefined;
  const format = typeof asset.format === 'string' ? asset.format : 'png';
  const data = typeof asset.data_base64 === 'string' ? asset.data_base64 : '';
  return { type: 'image', imageUrl: `data:image/${format === 'jpg' ? 'jpeg' : format};base64,${data}` };
};

// Every asset a structured value references, in encounter order, deduplicated.
const collectAssetImages = (value: unknown, assets: unknown): DecisionImagePart[] => {
  const found: DecisionImagePart[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (seen.has(node)) return;
      const image = systemOneAssetImage(node, assets);
      if (image !== undefined) {
        seen.add(node);
        found.push(image);
      }
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (isRecord(node)) { for (const item of Object.values(node)) walk(item); }
  };
  walk(value);
  return found;
};

// A base64 data URL becomes a System One asset. An http(s) URL has no asset
// form — the contract holds images by value only.
const dataUrlAsset = (imageUrl: string, index: number): { format: string; dataBase64: string } => {
  const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(imageUrl);
  if (match === null) throw new Error(`image ${index} must be a base64 data URL to reach a System One target`);
  const subtype = match[1].toLowerCase();
  const format = subtype === 'jpeg' ? 'jpg' : subtype;
  if (format !== 'png' && format !== 'jpg') throw new Error(`image ${index} must be png or jpg to reach a System One target`);
  return { format, dataBase64: match[2].replace(/\s+/g, '') };
};

// --- OpenAI content parts -> canonical parts ------------------------------

const isImageDetail = (value: unknown): value is 'low' | 'high' | 'auto' | 'original' =>
  value === 'low' || value === 'high' || value === 'auto' || value === 'original';

const openAIContentPart = (part: unknown, field: string): DecisionContentPart => {
  if (!isRecord(part)) throw new Error(`${field} must be an object`);
  if (part.type === 'input_text') return { type: 'text', text: requiredString(part.text, `${field}.text`) };
  if (part.type === 'input_image') {
    const detail = part.detail ?? undefined;
    if (detail !== undefined && !isImageDetail(detail)) throw new Error(`${field}.detail must be one of low, high, auto, original`);
    return {
      type: 'image',
      imageUrl: requiredString(part.image_url, `${field}.image_url`),
      ...(detail === undefined ? {} : { detail }),
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

// OpenAI `input` may be a string or an ordered list of role-bearing messages.
// System One has no notion of turns, so the canonical form flattens text, JSON,
// and images into one ordered evidence list; a non-message item is rejected.
const openAIInputState = (input: unknown): DecisionState => {
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

// Unknown top-level fields are rejected rather than silently dropped, so a
// caller's mistake reaches them instead of being hidden from the model.
const SYSTEMONE_TOP_LEVEL_FIELDS = new Set(['model', 'state', 'questions', 'assets']);

// System One instructions are text (possibly structured data serialized once).
// A whole-string asset reference becomes that image.
const systemOneInstructions = (value: unknown, field: string, assets: unknown): DecisionInstructions => {
  if (typeof value === 'string') {
    const image = systemOneAssetImage(value, assets);
    return image === undefined ? value : [image];
  }
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  throw new Error(`${field} must be a string`);
};

// A whole-string asset reference becomes an image part; a structured state keeps
// its shape and carries the images its references resolved to.
const systemOneState = (state: unknown, assets: unknown): DecisionState => {
  if (typeof state === 'string') {
    const image = systemOneAssetImage(state, assets);
    return image === undefined ? { kind: 'text', value: state } : { kind: 'parts', parts: [image] };
  }
  if (isRecord(state) || Array.isArray(state)) {
    const images = collectAssetImages(state, assets);
    return { kind: 'json', value: state as Record<string, unknown> | readonly unknown[], ...(images.length === 0 ? {} : { images }) };
  }
  throw new Error('state must be a string, an object, or an array');
};

const systemOneNoul = (name: string, value: Record<string, unknown>, assets: unknown): DecisionNoulQuestion => {
  const instructions = systemOneInstructions(value.instructions, `questions.${name}.instructions`, assets);
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

const systemOneChoice = (name: string, value: Record<string, unknown>, assets: unknown): DecisionChoiceQuestion => {
  const instructions = systemOneInstructions(value.instructions, `questions.${name}.instructions`, assets);
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

const systemOneScore = (name: string, value: Record<string, unknown>, assets: unknown): DecisionScoreQuestion => {
  const instructions = systemOneInstructions(value.instructions, `questions.${name}.instructions`, assets);
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

const parseSystemOneQuestion = (name: string, value: unknown, assets: unknown): DecisionQuestion => {
  if (!isRecord(value)) throw new Error(`questions.${name} must be an object`);
  if (value.type === 'noul') return systemOneNoul(name, value, assets);
  if (value.type === 'choice') return systemOneChoice(name, value, assets);
  if (value.type === 'score') return systemOneScore(name, value, assets);
  throw new Error(`questions.${name}.type must be one of noul, choice, score`);
};

const parseSystemOneRequest = (value: Record<string, unknown>): CanonicalDecisionRequest => {
  const unknownFields = Object.keys(value).filter(key => !SYSTEMONE_TOP_LEVEL_FIELDS.has(key));
  if (unknownFields.length > 0) throw new Error(`System One does not support ${unknownFields.join(', ')}`);
  if (value.state === undefined) throw new Error('state is required');
  const state = systemOneState(value.state, value.assets);
  if (!isRecord(value.questions)) throw new Error('questions must be an object keyed by question name');
  const questions = Object.entries(value.questions).map(([name, entry]) => parseSystemOneQuestion(name, entry, value.assets));
  if (questions.length === 0) throw new Error('questions must contain at least one question');
  return { sourceProtocol: 'systemone', raw: value, state, questions };
};

// --- OpenAI request -> canonical ------------------------------------------

const OPENAI_TOP_LEVEL_FIELDS = new Set([
  'model', 'input', 'questions',
  // Caller-controlled fields this dialect supports; kept only in `raw` for a
  // same-protocol forward, not modelled canonically.
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
  const state = openAIInputState(value.input);
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

// The only incompatibility is a question type the target does not answer. Both
// dialects carry text, JSON, and image content, so the content itself is never a
// reason to refuse here: whether a model reads an image is the model's answer to
// give. A value one dialect cannot represent (a typed choice collision) surfaces
// at serialization.
export const decisionRequestIncompatibility = (target: DecisionTarget, request: CanonicalDecisionRequest): string | null => {
  if (target.questionTypes === undefined) return null;
  const supported = new Set<DecisionQuestionType>(target.questionTypes);
  const unsupported = requestQuestionTypes(request).filter(type => !supported.has(type));
  if (unsupported.length === 0) return null;
  return `${[...new Set(unsupported)].join(', ')} questions require a target that answers them`;
};

// --- serialization --------------------------------------------------------

interface SystemOneCarrier {
  assets: Record<string, unknown>;
  reference: (part: DecisionContentPart, index: number) => unknown;
}

const systemOneCarrier = (): SystemOneCarrier => {
  const assets: Record<string, unknown> = {};
  let count = 0;
  return {
    assets,
    reference: (part, index) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'json') return part.data;
      const { format, dataBase64 } = dataUrlAsset(part.imageUrl, index);
      const ref = `image-${count++}`;
      assets[ref] = { type: 'image', format, data_base64: dataBase64 };
      return ref;
    },
  };
};

const systemOneInstructionsValue = (instructions: DecisionInstructions, carrier: SystemOneCarrier): unknown =>
  typeof instructions === 'string' ? instructions : instructions.map((part, index) => carrier.reference(part, index));

const systemOneStateValue = (state: DecisionState, carrier: SystemOneCarrier): unknown => {
  if (state.kind === 'text') return state.value;
  // A structured state already carries its references; images lifted from it
  // ride alongside, so lower them into assets under fresh references.
  if (state.kind === 'json') {
    const images = state.images ?? [];
    if (images.length === 0) return state.value;
    return [...images.map((image, index) => carrier.reference(image, index)), state.value];
  }
  const mapped = state.parts.map((part, index) => carrier.reference(part, index));
  return mapped.length === 1 ? mapped[0] : mapped;
};

const serializeSystemOne = (model: string, request: CanonicalDecisionRequest): Record<string, unknown> => {
  const carrier = systemOneCarrier();
  const questions = Object.fromEntries(request.questions.map(question => {
    if (question.type === 'noul') {
      return [question.name, {
        type: 'noul',
        instructions: systemOneInstructionsValue(question.instructions, carrier),
        ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
      }];
    }
    if (question.type === 'choice') {
      const criteria: Record<string, string | null> = {};
      for (const option of question.options) {
        const key = String(option.value);
        // System One keys options by string, so two typed values that read the
        // same cannot be carried without merging them.
        if (Object.hasOwn(criteria, key)) throw new Error(`choice question ${question.name} has values that collapse to the same System One label`);
        criteria[key] = option.description ?? null;
      }
      return [question.name, {
        type: 'choice',
        instructions: systemOneInstructionsValue(question.instructions, carrier),
        criteria,
      }];
    }
    return [question.name, {
      type: 'score',
      instructions: systemOneInstructionsValue(question.instructions, carrier),
      criteria: question.levels.map(level => level.label),
    }];
  }));
  const state = systemOneStateValue(request.state, carrier);
  return {
    model,
    state,
    questions,
    ...(Object.keys(carrier.assets).length === 0 ? {} : { assets: carrier.assets }),
  };
};

const openAIContentParts = (parts: readonly DecisionContentPart[]): readonly Record<string, unknown>[] => parts.map(part => {
  if (part.type === 'text') return { type: 'input_text', text: part.text };
  if (part.type === 'image') return { type: 'input_image', image_url: part.imageUrl, ...(part.detail === undefined ? {} : { detail: part.detail }) };
  return { type: 'input_json', data: part.data };
});

const openAIInstructions = (instructions: DecisionInstructions): unknown =>
  typeof instructions === 'string' ? instructions : openAIContentParts(instructions);

const openAIStateValue = (state: DecisionState): unknown => {
  if (state.kind === 'text') return state.value;
  if (state.kind === 'json') {
    const images = state.images ?? [];
    if (images.length === 0) return state.value;
    return [{ role: 'user', content: [...images.map(image => ({ type: 'input_image', image_url: image.imageUrl, ...(image.detail === undefined ? {} : { detail: image.detail }) })), { type: 'input_json', data: state.value }] }];
  }
  return [{ role: 'user', content: openAIContentParts(state.parts) }];
};

// OpenAI's Decisions shape: `input`, an array of questions whose yes/no type is
// `predicate`, choice options as `{value, description?}`, and score levels as
// `{label, description?}`.
// https://developers.openai.com/api/docs/guides/decisions
const serializeOpenAIDecisions = (model: string, request: CanonicalDecisionRequest): Record<string, unknown> => ({
  model,
  input: openAIStateValue(request.state),
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
    // The upstream lets a refusal answer one question while the rest resolve;
    // this canonical form has no refusal case, so the whole body is rejected
    // rather than silently returning a short answer list.
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

// Floway bills decision models on input tokens only; both dialects carry
// `input_tokens` and `output_tokens` under `usage`.
const usageNumbers = (body: Record<string, unknown>): { inputTokens?: number; outputTokens?: number } => {
  if (!isRecord(body.usage)) return {};
  const inputTokens = optionalNumber(body.usage.input_tokens);
  const outputTokens = optionalNumber(body.usage.output_tokens);
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
