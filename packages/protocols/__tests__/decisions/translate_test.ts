import { describe, expect, test } from 'vitest';

import { DecisionsRequestError, parseSystemOneUsage, renderDecisionsResponse, translateDecisionsRequest } from '../../src/decisions/translate.ts';

const choiceQuestion = {
  type: 'choice',
  name: 'owner',
  instructions: 'Which team should handle this?',
  choices: [
    { value: 'frontend', description: 'Browser interaction issues' },
    { value: 'backend', description: 'Server errors' },
    { value: 'unknown' },
  ],
};

const requestError = (body: unknown): DecisionsRequestError => {
  try {
    translateDecisionsRequest(body);
  } catch (error) {
    if (error instanceof DecisionsRequestError) return error;
    throw error;
  }
  throw new Error('expected translateDecisionsRequest to throw');
};

describe('Decisions request translation to System One', () => {
  test('maps every question type and keys the questions map by name', () => {
    const { model, systemOne } = translateDecisionsRequest({
      model: 'microsoft-decision-1',
      input: 'The export button does nothing.',
      questions: [
        { type: 'predicate', name: 'is_frontend', instructions: 'Is this a frontend bug?' },
        choiceQuestion,
        {
          type: 'score',
          name: 'severity',
          instructions: 'How severe is this?',
          levels: [{ label: 'Minor' }, { label: 'Major', description: 'Blocks a workflow' }],
        },
      ],
    });

    expect(model).toBe('microsoft-decision-1');
    expect(systemOne).toEqual({
      state: 'The export button does nothing.',
      questions: {
        is_frontend: { type: 'noul', instructions: 'Is this a frontend bug?' },
        owner: {
          type: 'choice',
          instructions: 'Which team should handle this?',
          criteria: { frontend: 'Browser interaction issues', backend: 'Server errors', unknown: 'unknown' },
        },
        severity: {
          type: 'score',
          instructions: 'How severe is this?',
          criteria: ['Minor', 'Major: Blocks a workflow'],
        },
      },
    });
  });

  test('keys unnamed questions by their position', () => {
    const { systemOne } = translateDecisionsRequest({
      model: 'm',
      input: 'x',
      questions: [{ type: 'predicate', instructions: 'Is it true?' }],
    });

    expect(systemOne.questions).toEqual({ question_0: { type: 'noul', instructions: 'Is it true?' } });
  });

  test('passes a sole input_json part through as an object state', () => {
    const { systemOne } = translateDecisionsRequest({
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_json', data: { message: 'checkout down', count: 3 } }] }],
      questions: [{ type: 'predicate', name: 'urgent', instructions: 'Is it urgent?' }],
    });

    expect(systemOne.state).toEqual({ message: 'checkout down', count: 3 });
  });

  test('joins text and serialized JSON parts across messages into a string state', () => {
    const { systemOne } = translateDecisionsRequest({
      model: 'm',
      input: [
        { role: 'developer', content: 'Triage the ticket.' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Checkout is down.' }, { type: 'input_json', data: { count: 3 } }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Noted.' }] },
      ],
      questions: [{ type: 'predicate', name: 'urgent', instructions: 'Is it urgent?' }],
    });

    expect(systemOne.state).toBe('Triage the ticket.\n\nCheckout is down.\n\n{"count":3}\n\nNoted.');
  });

  test('joins text parts of question instructions', () => {
    const { systemOne } = translateDecisionsRequest({
      model: 'm',
      input: 'x',
      questions: [{ type: 'predicate', name: 'p', instructions: [{ type: 'input_text', text: 'Is it' }, { type: 'input_text', text: 'true?' }] }],
    });

    expect(systemOne.questions).toEqual({ p: { type: 'noul', instructions: 'Is it\n\ntrue?' } });
  });

  test('stringifies boolean choice values as System One labels', () => {
    const { systemOne } = translateDecisionsRequest({
      model: 'm',
      input: 'x',
      questions: [{ type: 'choice', name: 'c', instructions: '?', choices: [{ value: true, description: 'yes' }, { value: false }] }],
    });

    expect(systemOne.questions).toEqual({ c: { type: 'choice', instructions: '?', criteria: { true: 'yes', false: 'false' } } });
  });

  test('drops cache and safety fields that System One cannot represent', () => {
    const { systemOne } = translateDecisionsRequest({
      model: 'm',
      input: 'x',
      questions: [{ type: 'predicate', name: 'p', instructions: '?' }],
      prompt_cache_key: 'k',
      prompt_cache_options: { mode: 'explicit' },
      safety_identifier: 'user-1',
    });

    expect(Object.keys(systemOne)).toEqual(['state', 'questions']);
  });

  test.each([
    ['a non-object body', [], null],
    ['a missing model', { input: 'x', questions: [{ type: 'predicate', instructions: '?' }] }, 'model'],
    ['an empty question list', { model: 'm', input: 'x', questions: [] }, 'questions'],
    ['an unknown question type', { model: 'm', input: 'x', questions: [{ type: 'noul', instructions: '?' }] }, 'questions[0].type'],
    ['an image input part', { model: 'm', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/a.png' }] }], questions: [{ type: 'predicate', instructions: '?' }] }, 'input[0].content[0]'],
    ['an image in question instructions', { model: 'm', input: 'x', questions: [{ type: 'predicate', instructions: [{ type: 'input_image', image_url: 'https://example.test/a.png' }] }] }, 'questions[0].instructions[0]'],
    ['a tool call input item', { model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }], questions: [{ type: 'predicate', instructions: '?' }] }, 'input[0]'],
    ['duplicate question names', { model: 'm', input: 'x', questions: [{ type: 'predicate', name: 'a', instructions: '?' }, { type: 'predicate', name: 'a', instructions: '?' }] }, 'questions[1].name'],
    ['a name colliding with a positional key', { model: 'm', input: 'x', questions: [{ type: 'predicate', instructions: '?' }, { type: 'predicate', name: 'question_0', instructions: '?' }] }, 'questions[1].name'],
    ['choice values colliding after stringification', { model: 'm', input: 'x', questions: [{ type: 'choice', name: 'c', instructions: '?', choices: [{ value: true }, { value: 'true' }] }] }, 'questions[0].choices[1].value'],
    ['a non-string non-boolean choice value', { model: 'm', input: 'x', questions: [{ type: 'choice', name: 'c', instructions: '?', choices: [{ value: 1 }, { value: 'b' }] }] }, 'questions[0].choices[0].value'],
    ['a score level without a label', { model: 'm', input: 'x', questions: [{ type: 'score', name: 's', instructions: '?', levels: [{ description: 'low' }, { label: 'high' }] }] }, 'questions[0].levels[0].label'],
  ])('rejects %s', (_name, body, param) => {
    const error = requestError(body);
    expect(error.param).toBe(param);
  });
});

describe('System One response rendering as Decisions', () => {
  const { model, systemOne, questions } = translateDecisionsRequest({
    model: 'microsoft-decision-1',
    input: 'x',
    questions: [
      { type: 'predicate', instructions: 'Is this a frontend bug?' },
      { type: 'choice', name: 'flag', instructions: '?', choices: [{ value: true }, { value: 'maybe' }] },
      { type: 'score', name: 'severity', instructions: '?', levels: [{ label: 'Minor', description: 'small' }, { label: 'Major' }] },
    ],
  });

  test('renders answers in request order with the original names, values and labels', () => {
    expect(model).toBe('microsoft-decision-1');
    expect(Object.keys(systemOne.questions as object)).toEqual(['question_0', 'flag', 'severity']);

    const rendered = renderDecisionsResponse({
      model: 'microsoft-decision-1',
      answers: {
        severity: {
          type: 'score',
          score: 0.9,
          confidence: 0.8,
          legend: { 0: 'Minor: small', 1: 'Major' },
          probabilities: { 0: 0.1, 1: 0.9 },
        },
        flag: { type: 'choice', choice: 'true', confidence: 0.7, probabilities: { maybe: 0.3, true: 0.7 } },
        question_0: { type: 'noul', noul: 0.99 },
      },
      usage: { input_tokens: 136, output_tokens: 3 },
    }, questions);

    expect(rendered).toEqual({
      model: 'microsoft-decision-1',
      answers: [
        { type: 'predicate', name: null, probability: 0.99 },
        {
          type: 'choice',
          name: 'flag',
          choice: true,
          confidence: 0.7,
          probabilities: [{ value: true, probability: 0.7 }, { value: 'maybe', probability: 0.3 }],
        },
        {
          type: 'score',
          name: 'severity',
          score: 0.9,
          confidence: 0.8,
          probabilities: [{ value: 0, label: 'Minor', probability: 0.1 }, { value: 1, label: 'Major', probability: 0.9 }],
        },
      ],
      usage: { input_tokens: 136, output_tokens: 3, total_tokens: 139 },
    });
  });

  test('rejects an upstream response that omits a requested answer', () => {
    expect(() => renderDecisionsResponse({ model: 'm', answers: { flag: { type: 'noul', noul: 1 } }, usage: {} }, questions))
      .toThrow(/question_0/);
  });

  test('rejects an upstream choice outside the requested values', () => {
    expect(() => renderDecisionsResponse({
      model: 'm',
      answers: {
        question_0: { type: 'noul', noul: 0.5 },
        flag: { type: 'choice', choice: 'other', confidence: 1, probabilities: { other: 1 } },
        severity: { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1 } },
      },
    }, questions)).toThrow(/flag/);
  });
});

describe('System One usage', () => {
  test('reads input and output tokens', () => {
    expect(parseSystemOneUsage({ usage: { input_tokens: 136, output_tokens: 3 } })).toEqual({ inputTokens: 136, outputTokens: 3 });
  });

  test('returns null when usage is absent or malformed', () => {
    expect(parseSystemOneUsage({ answers: {} })).toBeNull();
    expect(parseSystemOneUsage({ usage: { input_tokens: '1' } })).toBeNull();
    expect(parseSystemOneUsage(null)).toBeNull();
  });
});
