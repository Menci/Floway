import type {
  CanonicalDecisionRequest,
  CanonicalDecisionResponse,
  DecisionAnswer,
  DecisionChoiceOption,
  DecisionChoiceQuestion,
  DecisionContentPart,
  DecisionEntry,
  DecisionImagePart,
  DecisionInstructions,
  DecisionNoulQuestion,
  DecisionQuestion,
  DecisionScoreLevel,
  DecisionScoreQuestion,
  DecisionState,
  ParsedDecisionRequest,
} from './index.ts';
import { parseJsonNumber, type JsonNumber } from '../common/json.ts';
import type { DecisionProtocol } from '../common/models.ts';
import type { Result } from '@floway-dev/pipeline';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
};

// Answer numbers keep their source token when the upstream body was parsed with
// `parseJSONWithRawNumbers`, so a probability re-serializes byte for byte.
const finiteNumber = (value: unknown, field: string): JsonNumber => parseJsonNumber(value, field);

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
const typesafeSystemOneAssetImage = (reference: string, assets: unknown): DecisionImagePart | undefined => {
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
      const image = typesafeSystemOneAssetImage(node, assets);
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

const openAIContentPart = (part: unknown, field: string): Result<DecisionContentPart, string> => {
  if (!isRecord(part)) return { ok: false, error: `${field} must be an object` };
  const { type } = part;
  if (typeof type !== 'string') return { ok: false, error: `${field}.type must be a string` };
  if (type === 'input_text') {
    const { text } = part;
    if (typeof text !== 'string' || text.length === 0) return { ok: false, error: `${field}.text must be a non-empty string` };
    return { ok: true, value: { type: 'text', text } };
  }
  if (type === 'input_image') {
    const detail = part.detail ?? undefined;
    if (detail !== undefined && !isImageDetail(detail)) return { ok: false, error: `${field}.detail must be one of low, high, auto, original` };
    const { image_url: imageUrl } = part;
    if (typeof imageUrl !== 'string' || imageUrl.length === 0) return { ok: false, error: `${field}.image_url must be a non-empty string` };
    return {
      ok: true,
      value: {
        type: 'image',
        imageUrl,
        ...(detail === undefined ? {} : { detail }),
      },
    };
  }
  if (type === 'input_json') {
    if (!isRecord(part.data) && !Array.isArray(part.data)) return { ok: false, error: `${field}.data must be an object or an array` };
    return { ok: true, value: { type: 'json', data: part.data } };
  }
  return { ok: false, error: `${field}.type ${JSON.stringify(type)} is not supported` };
};

const openAIContent = (content: unknown, field: string): Result<readonly DecisionContentPart[] | string, string> => {
  if (typeof content === 'string') return { ok: true, value: content };
  if (!Array.isArray(content) || content.length === 0) return { ok: false, error: `${field} must be a string or a non-empty array of parts` };
  const parts: DecisionContentPart[] = [];
  for (const [index, item] of content.entries()) {
    const part = openAIContentPart(item, `${field}[${index}]`);
    if (!part.ok) return part;
    parts.push(part.value);
  }
  return { ok: true, value: parts };
};

const OPENAI_MESSAGE_ROLES = new Set(['user', 'developer', 'system', 'assistant']);

// OpenAI `input` may be a string or an ordered list of role-bearing messages.
// System One has no notion of turns, so the canonical form flattens text, JSON,
// and images into one ordered evidence list; a non-message item is rejected.
const openAIInputState = (input: unknown): Result<DecisionState, string> => {
  if (typeof input === 'string') return { ok: true, value: { kind: 'text', value: input } };
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: 'input must be a string or a non-empty array' };
  const parts: DecisionContentPart[] = [];
  for (const [index, item] of input.entries()) {
    if (!isRecord(item)) return { ok: false, error: `input[${index}] must be an object` };
    const { role } = item;
    if (typeof role !== 'string' || !OPENAI_MESSAGE_ROLES.has(role)) return { ok: false, error: `input[${index}].role is not supported` };
    const content = openAIContent(item.content, `input[${index}].content`);
    if (!content.ok) return content;
    if (typeof content.value === 'string') parts.push({ type: 'text', text: content.value });
    else parts.push(...content.value);
  }
  // A sole JSON part keeps its structure; every other mix becomes ordered parts.
  const only = parts.length === 1 ? parts[0] : undefined;
  if (only?.type === 'json') return { ok: true, value: { kind: 'json', value: only.data } };
  return { ok: true, value: { kind: 'parts', parts } };
};

// --- System One request -> canonical --------------------------------------

// Unknown top-level fields are rejected rather than silently dropped, so a
// caller's mistake reaches them instead of being hidden from the model.
const SYSTEMONE_TOP_LEVEL_FIELDS = new Set(['model', 'state', 'questions', 'assets']);

// System One reads a structured instruction as given, so the structure is kept
// rather than stringified into text the model would parse. A whole-string
// asset reference becomes that image. Omitted and null both mean "no
// instructions": both SDKs type it as optional and nullable, so a question may
// carry its whole meaning in `criteria`.
const typesafeSystemOneInstructions = (value: unknown, field: string, assets: unknown): Result<{ instructions?: DecisionInstructions }, string> => {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (typeof value === 'string') {
    const image = typesafeSystemOneAssetImage(value, assets);
    return { ok: true, value: { instructions: image === undefined ? value : [image] } };
  }
  if (isRecord(value) || Array.isArray(value)) return { ok: true, value: { instructions: value } };
  return { ok: false, error: `${field} must be a string, an object, an array, or null` };
};

// A whole-string asset reference becomes an image part; a structured state keeps
// its shape and carries the images its references resolved to.
const typesafeSystemOneState = (state: unknown, assets: unknown): Result<DecisionState, string> => {
  if (typeof state === 'string') {
    const image = typesafeSystemOneAssetImage(state, assets);
    return { ok: true, value: image === undefined ? { kind: 'text', value: state } : { kind: 'parts', parts: [image] } };
  }
  if (isRecord(state) || Array.isArray(state)) {
    const images = collectAssetImages(state, assets);
    return { ok: true, value: { kind: 'json', value: state, ...(images.length === 0 ? {} : { images }) } };
  }
  return { ok: false, error: 'state must be a string, an object, or an array' };
};

const typesafeSystemOneNoul = (name: string, value: Record<string, unknown>, assets: unknown): Result<DecisionNoulQuestion, string> => {
  const instructions = typesafeSystemOneInstructions(value.instructions, `questions.${name}.instructions`, assets);
  if (!instructions.ok) return instructions;
  // `null` is the SDK's explicit "no criteria", equivalent to omitting it.
  if (value.criteria === undefined || value.criteria === null) return { ok: true, value: { type: 'noul', name, ...instructions.value } };
  if (!isRecord(value.criteria)) return { ok: false, error: `questions.${name}.criteria must be an object` };
  const trueCriterion = value.criteria.true;
  const falseCriterion = value.criteria.false;
  if (trueCriterion !== undefined && typeof trueCriterion !== 'string' && !isRecord(trueCriterion) && !Array.isArray(trueCriterion)) {
    return { ok: false, error: `questions.${name}.criteria.true must be a string, an object, or an array` };
  }
  if (falseCriterion !== undefined && typeof falseCriterion !== 'string' && !isRecord(falseCriterion) && !Array.isArray(falseCriterion)) {
    return { ok: false, error: `questions.${name}.criteria.false must be a string, an object, or an array` };
  }
  return {
    ok: true,
    value: {
      type: 'noul',
      name,
      ...instructions.value,
      criteria: {
        ...(trueCriterion === undefined ? {} : { true: trueCriterion as DecisionEntry }),
        ...(falseCriterion === undefined ? {} : { false: falseCriterion as DecisionEntry }),
      },
    },
  };
};

const typesafeSystemOneChoice = (name: string, value: Record<string, unknown>, assets: unknown): Result<DecisionChoiceQuestion, string> => {
  const instructions = typesafeSystemOneInstructions(value.instructions, `questions.${name}.instructions`, assets);
  if (!instructions.ok) return instructions;
  if (!isRecord(value.criteria)) return { ok: false, error: `questions.${name}.criteria must be an object` };
  const options: DecisionChoiceOption[] = [];
  for (const [option, description] of Object.entries(value.criteria)) {
    if (description !== null && typeof description !== 'string' && !isRecord(description) && !Array.isArray(description)) {
      return { ok: false, error: `questions.${name}.criteria.${option} must be a string, an object, an array, or null` };
    }
    options.push({ value: option, ...(description === null ? {} : { description }) });
  }
  if (options.length < CHOICE_OPTION_MIN || options.length > CHOICE_OPTION_MAX) {
    return { ok: false, error: `questions.${name}.criteria must have ${CHOICE_OPTION_MIN}-${CHOICE_OPTION_MAX} options` };
  }
  return { ok: true, value: { type: 'choice', name, ...instructions.value, options } };
};

const typesafeSystemOneScore = (name: string, value: Record<string, unknown>, assets: unknown): Result<DecisionScoreQuestion, string> => {
  const instructions = typesafeSystemOneInstructions(value.instructions, `questions.${name}.instructions`, assets);
  if (!instructions.ok) return instructions;
  if (!Array.isArray(value.criteria)) return { ok: false, error: `questions.${name}.criteria must be an array of level descriptions` };
  if (value.criteria.length < SCORE_LEVEL_MIN || value.criteria.length > SCORE_LEVEL_MAX) {
    return { ok: false, error: `questions.${name}.criteria must have ${SCORE_LEVEL_MIN}-${SCORE_LEVEL_MAX} levels` };
  }
  const levels: DecisionScoreLevel[] = [];
  for (const [index, level] of value.criteria.entries()) {
    if (typeof level !== 'string' && !isRecord(level) && !Array.isArray(level)) {
      return { ok: false, error: `questions.${name}.criteria[${index}] must be a string, an object, or an array` };
    }
    levels.push({ label: level });
  }
  return { ok: true, value: { type: 'score', name, ...instructions.value, levels } };
};

const parseSystemOneQuestion = (name: string, value: unknown, assets: unknown): Result<DecisionQuestion, string> => {
  if (!isRecord(value)) return { ok: false, error: `questions.${name} must be an object` };
  if (value.type === 'noul') return typesafeSystemOneNoul(name, value, assets);
  if (value.type === 'choice') return typesafeSystemOneChoice(name, value, assets);
  if (value.type === 'score') return typesafeSystemOneScore(name, value, assets);
  return { ok: false, error: `questions.${name}.type must be one of noul, choice, score` };
};

const parseSystemOneRequest = (value: Record<string, unknown>): Result<CanonicalDecisionRequest, string> => {
  const unknownFields = Object.keys(value).filter(key => !SYSTEMONE_TOP_LEVEL_FIELDS.has(key));
  if (unknownFields.length > 0) return { ok: false, error: `System One does not support ${unknownFields.join(', ')}` };
  if (value.state === undefined) return { ok: false, error: 'state is required' };
  const state = typesafeSystemOneState(value.state, value.assets);
  if (!state.ok) return state;
  if (!isRecord(value.questions)) return { ok: false, error: 'questions must be an object keyed by question name' };
  const questions: DecisionQuestion[] = [];
  for (const [name, entry] of Object.entries(value.questions)) {
    const question = parseSystemOneQuestion(name, entry, value.assets);
    if (!question.ok) return question;
    questions.push(question.value);
  }
  if (questions.length === 0) return { ok: false, error: 'questions must contain at least one question' };
  return { ok: true, value: { sourceProtocol: 'typesafe-systemone', raw: value, state: state.value, questions } };
};

// --- OpenAI request -> canonical ------------------------------------------

const OPENAI_TOP_LEVEL_FIELDS = new Set([
  'model', 'input', 'questions',
  // Caller-controlled fields this dialect supports; kept only in `raw` for a
  // same-protocol forward, not modelled canonically.
  'prompt_cache_key', 'prompt_cache_options', 'safety_identifier',
]);

const bounded = <T>(items: T[], field: string, min: number, max: number): Result<readonly T[], string> => {
  if (items.length < min || items.length > max) return { ok: false, error: `${field} must have ${min}-${max} entries` };
  return { ok: true, value: items };
};

// Choice values are typed in this dialect; a string and a boolean that read the
// same are distinct options.
const openAIChoiceOption = (value: unknown, field: string): Result<DecisionChoiceOption, string> => {
  if (!isRecord(value)) return { ok: false, error: `${field} must be an object` };
  const option = value.value;
  if (typeof option !== 'string' && typeof option !== 'boolean') return { ok: false, error: `${field}.value must be a string or boolean` };
  if (value.description !== undefined && typeof value.description !== 'string') return { ok: false, error: `${field}.description must be a string` };
  return { ok: true, value: value.description === undefined ? { value: option } : { value: option, description: value.description } };
};

const openAILevel = (value: unknown, field: string): Result<DecisionScoreLevel, string> => {
  if (!isRecord(value)) return { ok: false, error: `${field} must be an object` };
  const { label, description } = value;
  if (typeof label !== 'string' || label.length === 0) return { ok: false, error: `${field}.label must be a non-empty string` };
  if (description !== undefined && typeof description !== 'string') return { ok: false, error: `${field}.description must be a string` };
  return { ok: true, value: description === undefined ? { label } : { label, description } };
};

const openAIQuestion = (value: unknown, index: number): Result<DecisionQuestion, string> => {
  const field = `questions[${index}]`;
  if (!isRecord(value)) return { ok: false, error: `${field} must be an object` };
  const { name } = value;
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: `${field}.name must be a non-empty string` };
  const instructions = openAIContent(value.instructions, `${field}.instructions`);
  if (!instructions.ok) return instructions;
  if (value.type === 'predicate') return { ok: true, value: { type: 'noul', name, instructions: instructions.value } };
  if (value.type === 'choice') {
    if (!Array.isArray(value.choices)) return { ok: false, error: `${field}.choices must be an array` };
    const options: DecisionChoiceOption[] = [];
    for (const [choiceIndex, choice] of value.choices.entries()) {
      const option = openAIChoiceOption(choice, `${field}.choices[${choiceIndex}]`);
      if (!option.ok) return option;
      options.push(option.value);
    }
    const result = bounded(options, `${field}.choices`, CHOICE_OPTION_MIN, CHOICE_OPTION_MAX);
    if (!result.ok) return result;
    return { ok: true, value: { type: 'choice', name, instructions: instructions.value, options: result.value } };
  }
  if (value.type === 'score') {
    if (!Array.isArray(value.levels)) return { ok: false, error: `${field}.levels must be an array` };
    const levels: DecisionScoreLevel[] = [];
    for (const [levelIndex, level] of value.levels.entries()) {
      const parsed = openAILevel(level, `${field}.levels[${levelIndex}]`);
      if (!parsed.ok) return parsed;
      levels.push(parsed.value);
    }
    const result = bounded(levels, `${field}.levels`, SCORE_LEVEL_MIN, SCORE_LEVEL_MAX);
    if (!result.ok) return result;
    return { ok: true, value: { type: 'score', name, instructions: instructions.value, levels: result.value } };
  }
  return { ok: false, error: `${field}.type must be one of predicate, choice, score` };
};

const parseOpenAIDecisionsRequest = (value: Record<string, unknown>): Result<CanonicalDecisionRequest, string> => {
  const unknownFields = Object.keys(value).filter(key => !OPENAI_TOP_LEVEL_FIELDS.has(key));
  if (unknownFields.length > 0) return { ok: false, error: `OpenAI Decisions does not support ${unknownFields.join(', ')}` };
  if (value.input === undefined) return { ok: false, error: 'input is required' };
  const state = openAIInputState(value.input);
  if (!state.ok) return state;
  if (!Array.isArray(value.questions)) return { ok: false, error: 'questions must be an array' };
  const questions: DecisionQuestion[] = [];
  for (const [index, entry] of value.questions.entries()) {
    const question = openAIQuestion(entry, index);
    if (!question.ok) return question;
    questions.push(question.value);
  }
  if (questions.length === 0) return { ok: false, error: 'questions must contain at least one question' };
  return { ok: true, value: { sourceProtocol: 'openai-decisions', raw: value, state: state.value, questions } };
};

export const parseDecisionRequest = (protocol: DecisionProtocol, value: unknown): Result<ParsedDecisionRequest, string> => {
  if (!isRecord(value)) return { ok: false, error: 'Decision request body must be an object' };
  const { model } = value;
  if (typeof model !== 'string' || model.length === 0) return { ok: false, error: 'model must be a non-empty string' };
  let request: Result<CanonicalDecisionRequest, string>;
  switch (protocol) {
  case 'typesafe-systemone': request = parseSystemOneRequest(value); break;
  case 'openai-decisions': request = parseOpenAIDecisionsRequest(value); break;
  default: protocol satisfies never; throw new Error(`Unhandled decision protocol: ${protocol as string}`);
  }
  return request.ok ? { ok: true, value: { model, request: request.value } } : request;
};

// --- serialization --------------------------------------------------------

// System One gates images behind a vendor request header this gateway does not
// send, so an image cannot be lowered into that target at all: emitting an asset
// the upstream ignores would trade the image for a confident answer about its
// absence.
interface SystemOneCarrier {
  assets: Record<string, unknown>;
  reference: (part: DecisionContentPart, index: number) => unknown;
}

const typesafeSystemOneCarrier = (): SystemOneCarrier => {
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

// A content-part list is lowered into assets; any other array is structured
// data the model reads as given, so only an OpenAI-sourced array is mapped.
const typesafeSystemOneInstructionsValue = (
  instructions: DecisionInstructions | undefined,
  carrier: SystemOneCarrier,
  sourceProtocol: DecisionProtocol,
): unknown => {
  if (instructions === undefined) return undefined;
  if (sourceProtocol !== 'openai-decisions' || !Array.isArray(instructions)) return instructions;
  return (instructions as readonly DecisionContentPart[]).map((part, index) => carrier.reference(part, index));
};

const typesafeSystemOneStateValue = (state: DecisionState, carrier: SystemOneCarrier): unknown => {
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
  const carrier = typesafeSystemOneCarrier();
  const questions = Object.fromEntries(request.questions.map(question => {
    if (question.type === 'noul') {
      return [question.name, {
        type: 'noul',
        ...(question.instructions === undefined ? {} : { instructions: typesafeSystemOneInstructionsValue(question.instructions, carrier, request.sourceProtocol) }),
        ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
      }];
    }
    if (question.type === 'choice') {
      const criteria: Record<string, DecisionEntry | null> = {};
      for (const option of question.options) {
        const key = String(option.value);
        // System One keys options by string, so two typed values that read the
        // same cannot be carried without merging them.
        if (Object.hasOwn(criteria, key)) throw new Error(`choice question ${question.name} has values that collapse to the same System One label`);
        criteria[key] = option.description ?? null;
      }
      return [question.name, {
        type: 'choice',
        ...(question.instructions === undefined ? {} : { instructions: typesafeSystemOneInstructionsValue(question.instructions, carrier, request.sourceProtocol) }),
        criteria,
      }];
    }
    return [question.name, {
      type: 'score',
      ...(question.instructions === undefined ? {} : { instructions: typesafeSystemOneInstructionsValue(question.instructions, carrier, request.sourceProtocol) }),
      criteria: question.levels.map(level => level.label),
    }];
  }));
  const state = typesafeSystemOneStateValue(request.state, carrier);
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

// Only a content-part list becomes OpenAI parts; a structured instruction has
// no OpenAI form, so it is sent as its JSON text.
// Only an OpenAI-sourced request carries content parts; a System One array is
// structured data the model reads as given, so it is sent unchanged.
const openAIInstructions = (instructions: DecisionInstructions | undefined, sourceProtocol: DecisionProtocol): unknown => {
  if (instructions === undefined) return undefined;
  if (sourceProtocol !== 'openai-decisions' || !Array.isArray(instructions)) return instructions;
  return openAIContentParts(instructions as readonly DecisionContentPart[]);
};

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
      return {
        type: 'predicate',
        name: question.name,
        ...(question.instructions === undefined ? {} : { instructions: openAIInstructions(question.instructions, request.sourceProtocol) }),
      };
    }
    if (question.type === 'choice') {
      return {
        type: 'choice',
        name: question.name,
        ...(question.instructions === undefined ? {} : { instructions: openAIInstructions(question.instructions, request.sourceProtocol) }),
        choices: question.options.map(option => ({
          value: option.value,
          ...(option.description === undefined ? {} : { description: option.description }),
        })),
      };
    }
    return {
      type: 'score',
      name: question.name,
      ...(question.instructions === undefined ? {} : { instructions: openAIInstructions(question.instructions, request.sourceProtocol) }),
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
  case 'typesafe-systemone': return serializeSystemOne(model, request);
  case 'openai-decisions': return serializeOpenAIDecisions(model, request);
  default: protocol satisfies never; throw new Error(`Unhandled decision protocol: ${protocol as string}`);
  }
};

// --- response parsing -----------------------------------------------------

const optionalNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const requiredNumberRecord = (value: unknown, field: string): Record<string, number> => {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return numberRecord(value) ?? {};
};

const numberRecord = (value: unknown): Record<string, number> | undefined => {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
};

// Every legend entry is kept: System One echoes the criteria value it was
// given, which may be a string, an object, or an array.
const entryRecord = (value: unknown): Record<string, DecisionEntry> | undefined =>
  isRecord(value) ? value as Record<string, DecisionEntry> : undefined;

// Both dialects mark `confidence` and `probabilities` required on Choice and
// Score answers, so a missing one is a broken response rather than an answer
// without detail. System One also carries a separate `legend`; the OpenAI shape
// inlines each label instead.
const typesafeSystemOneAnswer = (name: string, value: unknown): DecisionAnswer => {
  if (!isRecord(value)) throw new Error(`answers.${name} must be an object`);
  if (value.type === 'noul') return { type: 'noul', name, noul: finiteNumber(value.noul, `answers.${name}.noul`) };
  const confidence = finiteNumber(value.confidence, `answers.${name}.confidence`);
  if (value.type === 'choice') {
    const choice = requiredString(value.choice, `answers.${name}.choice`);
    const record = requiredNumberRecord(value.probabilities, `answers.${name}.probabilities`);
    return {
      type: 'choice',
      name,
      choice,
      confidence,
      probabilities: Object.entries(record).map(([option, probability]) => ({ value: option, probability })),
    };
  }
  if (value.type === 'score') {
    const score = finiteNumber(value.score, `answers.${name}.score`);
    const legend = entryRecord(value.legend);
    const record = requiredNumberRecord(value.probabilities, `answers.${name}.probabilities`);
    return {
      type: 'score',
      name,
      score,
      confidence,
      probabilities: Object.entries(record).map(([level, probability]) => {
        // OpenAI's per-level `label` is a string; a structured System One
        // criteria stays in `legend` and is not flattened into it.
        const label = legend?.[level];
        return {
          value: Number(level),
          ...(typeof label === 'string' ? { label } : {}),
          probability,
        };
      }),
      ...(legend === undefined ? {} : { legend }),
    };
  }
  throw new Error(`answers.${name}.type must be one of noul, choice, score`);
};

const parseSystemOneResponse = (body: Record<string, unknown>): CanonicalDecisionResponse => {
  if (!isRecord(body.answers)) throw new Error('answers must be an object keyed by question name');
  return {
    targetProtocol: 'typesafe-systemone',
    raw: body,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    answers: Object.entries(body.answers).map(([name, entry]) => typesafeSystemOneAnswer(name, entry)),
  };
};

// OpenAI marks `probabilities` required on Choice and Score answers, so a
// non-array is a broken response. A missing entry value type is likewise an
// upstream contract violation, not the absence of detail.
const openAITypedProbabilities = (value: unknown, field: string): readonly { value: string | boolean; probability: JsonNumber }[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${field}[${index}] must be an object`);
    const raw = entry.value;
    if (typeof raw !== 'string' && typeof raw !== 'boolean') throw new Error(`${field}[${index}].value must be a string or boolean`);
    return { value: raw, probability: finiteNumber(entry.probability, `${field}[${index}].probability`) };
  });
};

const openAIScoreProbabilities = (value: unknown, field: string): readonly { value: number; label?: string; probability: JsonNumber }[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${field}[${index}] must be an object`);
    if (typeof entry.value !== 'number') throw new Error(`${field}[${index}].value must be a number`);
    if (entry.label !== undefined && typeof entry.label !== 'string') throw new Error(`${field}[${index}].label must be a string`);
    return {
      value: entry.value,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      probability: finiteNumber(entry.probability, `${field}[${index}].probability`),
    };
  });
};

const parseOpenAIDecisionsResponse = (body: Record<string, unknown>): CanonicalDecisionResponse => {
  if (!Array.isArray(body.answers)) throw new Error('answers must be an array');
  const answers: DecisionAnswer[] = body.answers.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`answers[${index}] must be an object`);
    const name = requiredString(entry.name, 'answers[].name');
    // A refusal answers only its own question; the others still resolve, so it
    // is carried through as its own answer rather than failing the response. It
    // carries no probability, so it is decided before reading one.
    if (entry.type === 'refusal') return { type: 'refusal', name };
    if (entry.type === 'predicate') return { type: 'noul', name, noul: finiteNumber(entry.probability, `answers.${name}.probability`) };
    const confidence = finiteNumber(entry.confidence, `answers.${name}.confidence`);
    if (entry.type === 'choice') {
      const raw = entry.choice;
      if (typeof raw !== 'string' && typeof raw !== 'boolean') throw new Error(`answers.${name}.choice must be a string or boolean`);
      return {
        type: 'choice',
        name,
        choice: raw,
        confidence,
        probabilities: openAITypedProbabilities(entry.probabilities, `answers.${name}.probabilities`),
      };
    }
    if (entry.type === 'score') {
      const probabilities = openAIScoreProbabilities(entry.probabilities, `answers.${name}.probabilities`);
      // The OpenAI shape has no separate legend; derive it from the inline
      // labels so a same-dialect System One reader sees the level names.
      const legend: Record<string, string> = {};
      for (const level of probabilities) {
        if (level.label !== undefined) legend[String(level.value)] = level.label;
      }
      return {
        type: 'score',
        name,
        score: finiteNumber(entry.score, `answers.${name}.score`),
        confidence,
        probabilities,
        ...(Object.keys(legend).length === 0 ? {} : { legend }),
      };
    }
    throw new Error(`answers[${index}].type ${JSON.stringify(entry.type)} is not supported`);
  });
  return {
    targetProtocol: 'openai-decisions',
    raw: body,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    answers,
  };
};

export const parseDecisionResponse = (protocol: DecisionProtocol, body: Record<string, unknown>): CanonicalDecisionResponse => {
  switch (protocol) {
  case 'typesafe-systemone': return parseSystemOneResponse(body);
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
    // System One defines no refusal answer, so it cannot be rendered there.
    if (answer.type === 'refusal') throw new Error(`answers.${answer.name} is a refusal, which System One cannot express`);
    if (answer.type === 'noul') {
      answers[answer.name] = { type: 'noul', noul: answer.noul };
    } else if (answer.type === 'choice') {
      answers[answer.name] = {
        type: 'choice',
        choice: String(answer.choice),
        confidence: answer.confidence,
        probabilities: Object.fromEntries(answer.probabilities.map(entry => [String(entry.value), entry.probability])),
      };
    } else {
      answers[answer.name] = {
        type: 'score',
        score: answer.score,
        confidence: answer.confidence,
        probabilities: Object.fromEntries(answer.probabilities.map(entry => [String(entry.value), entry.probability])),
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
    if (answer.type === 'refusal') return { type: 'refusal', name: answer.name };
    if (answer.type === 'noul') return { type: 'predicate', name: answer.name, probability: answer.noul };
    if (answer.type === 'choice') {
      return {
        type: 'choice',
        name: answer.name,
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: answer.probabilities.map(entry => ({ value: entry.value, probability: entry.probability })),
      };
    }
    return {
      type: 'score',
      name: answer.name,
      score: answer.score,
      confidence: answer.confidence,
      probabilities: answer.probabilities.map(entry => ({ value: entry.value, ...(entry.label === undefined ? {} : { label: entry.label }), probability: entry.probability })),
    };
  });
  const usage = renderUsage(response);
  return {
    ...(response.model === undefined ? {} : { model: response.model }),
    answers,
    ...(usage === undefined ? {} : { usage }),
  };
};

export const renderDecisionResponse = (protocol: DecisionProtocol, response: CanonicalDecisionResponse): Record<string, unknown> => {
  switch (protocol) {
  case 'typesafe-systemone': return renderSystemOneResponse(response);
  case 'openai-decisions': return renderOpenAIDecisionsResponse(response);
  default: protocol satisfies never; throw new Error(`Unhandled decision protocol: ${protocol as string}`);
  }
};
