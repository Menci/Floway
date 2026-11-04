// OpenAI Decisions ⇄ System One translation. Copilot and Foundry serve
// decision models only through System One, so an OpenAI Decisions request is
// lowered onto it and the System One answer map is lifted back into OpenAI's
// ordered answer list. The field mapping follows the gateway precedent at
// https://www.truefoundry.com/docs/ai-gateway/decisions; anything System One
// cannot carry without changing the decision (images, tool items) is a 400.

import type { DecisionsChoiceValue, DecisionsQuestionPlan, DecisionsTranslation, SystemOneUsage } from './index.ts';

export class DecisionsRequestError extends Error {
  constructor(message: string, readonly param: string | null) {
    super(message);
    this.name = 'DecisionsRequestError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fail = (message: string, param: string | null): never => {
  throw new DecisionsRequestError(message, param);
};

const PART_SEPARATOR = '\n\n';

// A content part contributes either text or a JSON value. Images have no
// System One representation, so dropping them would silently change the
// decision the caller asked for.
type ContentSegment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'json'; readonly data: unknown };

const contentPartSegment = (part: unknown, param: string): ContentSegment => {
  if (!isRecord(part)) return fail(`${param} must be an object.`, param);
  switch (part.type) {
  case 'input_text':
  case 'output_text':
    if (typeof part.text !== 'string') return fail(`${param}.text must be a string.`, `${param}.text`);
    return { kind: 'text', text: part.text };
  case 'refusal':
    if (typeof part.refusal !== 'string') return fail(`${param}.refusal must be a string.`, `${param}.refusal`);
    return { kind: 'text', text: part.refusal };
  case 'input_json':
    if (!isRecord(part.data) && !Array.isArray(part.data)) return fail(`${param}.data must be an object or array.`, `${param}.data`);
    return { kind: 'json', data: part.data };
  case 'input_image':
    return fail('System One decision models cannot represent input_image parts.', param);
  default:
    return fail(`${param}.type ${JSON.stringify(part.type)} is not supported.`, param);
  }
};

const contentSegments = (content: unknown, param: string): ContentSegment[] => {
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content) || content.length === 0) return fail(`${param} must be a string or a non-empty array of content parts.`, param);
  return content.map((part, index) => contentPartSegment(part, `${param}[${index}]`));
};

const joinSegments = (segments: readonly ContentSegment[]): string =>
  segments.map(segment => segment.kind === 'text' ? segment.text : JSON.stringify(segment.data)).join(PART_SEPARATOR);

const MESSAGE_ROLES: ReadonlySet<unknown> = new Set(['user', 'developer', 'system', 'assistant']);

const inputSegments = (input: unknown): ContentSegment[] => {
  if (typeof input === 'string') return [{ kind: 'text', text: input }];
  if (!Array.isArray(input) || input.length === 0) return fail('input must be a string or a non-empty array of messages.', 'input');
  return input.flatMap((item, index) => {
    const param = `input[${index}]`;
    if (!isRecord(item) || (item.type !== undefined && item.type !== 'message') || !MESSAGE_ROLES.has(item.role)) {
      return fail(`${param} must be a message; System One decision models cannot represent other input items.`, param);
    }
    return contentSegments(item.content, `${param}.content`);
  });
};

// A sole JSON part keeps its structure: System One accepts an object or array
// state natively, which is the structured-state form Foundry recommends.
const systemOneState = (input: unknown): unknown => {
  const segments = inputSegments(input);
  const [only] = segments;
  return segments.length === 1 && only.kind === 'json' ? only.data : joinSegments(segments);
};

const instructionsText = (instructions: unknown, param: string): string => {
  if (typeof instructions === 'string') return instructions;
  if (!Array.isArray(instructions)) return fail(`${param} must be a string or a non-empty array of content parts.`, param);
  return joinSegments(contentSegments(instructions, param));
};

const optionalDescription = (value: unknown, param: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return fail(`${param} must be a string.`, param);
  return value;
};

const nonEmptyArray = (value: unknown, param: string): unknown[] => {
  if (!Array.isArray(value) || value.length === 0) return fail(`${param} must be a non-empty array.`, param);
  return value;
};

interface TranslatedQuestion {
  readonly systemOne: Record<string, unknown>;
  readonly plan: DecisionsQuestionPlan;
}

const translateChoice = (question: Record<string, unknown>, key: string, name: string | null, instructions: string, param: string): TranslatedQuestion => {
  const criteria: Record<string, string> = {};
  const values: DecisionsChoiceValue[] = [];
  nonEmptyArray(question.choices, `${param}.choices`).forEach((choice, index) => {
    const choiceParam = `${param}.choices[${index}]`;
    if (!isRecord(choice)) return fail(`${choiceParam} must be an object.`, choiceParam);
    const { value } = choice;
    if (typeof value !== 'string' && typeof value !== 'boolean') return fail(`${choiceParam}.value must be a string or boolean.`, `${choiceParam}.value`);
    // System One keys choices by their text, so `true` and `"true"` — distinct
    // OpenAI values — would collapse into one label.
    const label = String(value);
    if (Object.hasOwn(criteria, label)) return fail(`${choiceParam}.value collides with another choice once represented as the System One label ${JSON.stringify(label)}.`, `${choiceParam}.value`);
    // System One rejects an empty criterion (422 "value must not be empty"),
    // so an undescribed choice describes itself by its label.
    const description = optionalDescription(choice.description, `${choiceParam}.description`);
    criteria[label] = description === undefined || description === '' ? label : description;
    values.push(value);
  });
  return { systemOne: { type: 'choice', instructions, criteria }, plan: { type: 'choice', key, name, values } };
};

const translateScore = (question: Record<string, unknown>, key: string, name: string | null, instructions: string, param: string): TranslatedQuestion => {
  const labels: string[] = [];
  const criteria = nonEmptyArray(question.levels, `${param}.levels`).map((level, index) => {
    const levelParam = `${param}.levels[${index}]`;
    if (!isRecord(level)) return fail(`${levelParam} must be an object.`, levelParam);
    if (typeof level.label !== 'string' || level.label.length === 0) return fail(`${levelParam}.label must be a non-empty string.`, `${levelParam}.label`);
    labels.push(level.label);
    const description = optionalDescription(level.description, `${levelParam}.description`);
    return description === undefined || description === '' ? level.label : `${level.label}: ${description}`;
  });
  return { systemOne: { type: 'score', instructions, criteria }, plan: { type: 'score', key, name, labels } };
};

const translateQuestion = (question: unknown, index: number, key: string, name: string | null): TranslatedQuestion => {
  const param = `questions[${index}]`;
  if (!isRecord(question)) return fail(`${param} must be an object.`, param);
  const instructions = instructionsText(question.instructions, `${param}.instructions`);
  switch (question.type) {
  case 'predicate':
    return { systemOne: { type: 'noul', instructions }, plan: { type: 'predicate', key, name } };
  case 'choice':
    return translateChoice(question, key, name, instructions, param);
  case 'score':
    return translateScore(question, key, name, instructions, param);
  default:
    return fail(`${param}.type must be one of predicate, choice, or score.`, `${param}.type`);
  }
};

// OpenAI answers echo the caller's name; System One needs a map key, so an
// unnamed question takes its position. Either way two questions must not
// share a key, or one answer would overwrite the other.
const questionName = (question: unknown, index: number): string | null => {
  if (!isRecord(question) || question.name === undefined || question.name === null) return null;
  if (typeof question.name !== 'string' || question.name.length === 0) return fail(`questions[${index}].name must be a non-empty string.`, `questions[${index}].name`);
  return question.name;
};

export const translateDecisionsRequest = (body: unknown): DecisionsTranslation => {
  if (!isRecord(body)) return fail('Decisions request body must be an object.', null);
  if (typeof body.model !== 'string' || body.model.length === 0) return fail('model must be a non-empty string.', 'model');
  const questions = nonEmptyArray(body.questions, 'questions');
  const state = systemOneState(body.input);

  const systemOneQuestions: Record<string, unknown> = {};
  const plans = questions.map((question, index) => {
    const name = questionName(question, index);
    const key = name ?? `question_${index}`;
    if (Object.hasOwn(systemOneQuestions, key)) return fail(`questions[${index}].name ${JSON.stringify(key)} is used by another question.`, `questions[${index}].name`);
    const translated = translateQuestion(question, index, key, name);
    systemOneQuestions[key] = translated.systemOne;
    return translated.plan;
  });

  return { model: body.model, systemOne: { state, questions: systemOneQuestions }, questions: plans };
};

const finiteNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`System One ${label} must be a finite number`);
  return value;
};

const probabilityMap = (value: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`System One ${label} must be an object`);
  return value;
};

const renderAnswer = (plan: DecisionsQuestionPlan, answer: unknown): Record<string, unknown> => {
  const label = `answer ${JSON.stringify(plan.key)}`;
  if (!isRecord(answer)) throw new Error(`System One response is missing ${label}`);
  switch (plan.type) {
  case 'predicate':
    return { type: 'predicate', name: plan.name, probability: finiteNumber(answer.noul, `${label}.noul`) };
  case 'choice': {
    const probabilities = probabilityMap(answer.probabilities, `${label}.probabilities`);
    const choice = plan.values.find(value => String(value) === answer.choice);
    if (choice === undefined) throw new Error(`System One ${label} chose ${JSON.stringify(answer.choice)}, which is not a requested choice`);
    return {
      type: 'choice',
      name: plan.name,
      choice,
      confidence: finiteNumber(answer.confidence, `${label}.confidence`),
      probabilities: plan.values.map(value => ({ value, probability: finiteNumber(probabilities[String(value)], `${label}.probabilities.${String(value)}`) })),
    };
  }
  case 'score': {
    const probabilities = probabilityMap(answer.probabilities, `${label}.probabilities`);
    // Labels come from the request: System One's legend echoes the lowered
    // `label: description` criteria, not the caller's label.
    return {
      type: 'score',
      name: plan.name,
      score: finiteNumber(answer.score, `${label}.score`),
      confidence: finiteNumber(answer.confidence, `${label}.confidence`),
      probabilities: plan.labels.map((levelLabel, index) => ({
        value: index,
        label: levelLabel,
        probability: finiteNumber(probabilities[String(index)], `${label}.probabilities.${index}`),
      })),
    };
  }
  }
};

export const renderDecisionsResponse = (body: unknown, questions: readonly DecisionsQuestionPlan[]): Record<string, unknown> => {
  if (!isRecord(body)) throw new Error('System One response must be an object');
  const answers = probabilityMap(body.answers, 'answers');
  const usage = parseSystemOneUsage(body);
  return {
    model: body.model,
    answers: questions.map(plan => renderAnswer(plan, answers[plan.key])),
    ...(usage === null ? {} : {
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens },
    }),
  };
};

export const parseSystemOneUsage = (body: unknown): SystemOneUsage | null => {
  if (!isRecord(body) || !isRecord(body.usage)) return null;
  const { input_tokens: inputTokens, output_tokens: outputTokens } = body.usage;
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return null;
  return { inputTokens, outputTokens };
};
