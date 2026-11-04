import { describe, expect, test } from 'vitest';

import { decisionRequestIncompatibility, parseDecisionRequest, parseDecisionResponse, parseDecisionUsage, renderDecisionResponse, serializeDecisionRequest } from '../../src/decision/translate.ts';

const choiceRequest = {
  model: 'microsoft-decision-1',
  state: 'The API returns 500 on every call.',
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: { billing: 'Charges, invoices, and refunds', engineering: 'Bugs, errors, and outages' },
    },
  },
};

describe('decision request ingress', () => {
  test('parses a System One body into canonical questions', () => {
    const parsed = parseDecisionRequest(choiceRequest);
    expect(parsed.model).toBe('microsoft-decision-1');
    expect(parsed.request.state).toBe('The API returns 500 on every call.');
    expect(parsed.request.questions).toEqual([
      {
        type: 'choice',
        name: 'team',
        instructions: 'Which team should handle this ticket?',
        criteria: { billing: 'Charges, invoices, and refunds', engineering: 'Bugs, errors, and outages' },
      },
    ]);
  });

  test('keeps noul criteria and score levels', () => {
    const parsed = parseDecisionRequest({
      model: 'jev-1.13',
      state: { ticket: 'I want a refund' },
      questions: {
        refund: { type: 'noul', instructions: 'Is a refund requested?', criteria: { true: 'Commits to paying', false: 'No commitment' } },
        severity: { type: 'score', instructions: 'How severe?', criteria: ['Cosmetic', 'Minor', 'Critical'] },
      },
    });
    expect(parsed.request.questions[0]).toEqual({
      type: 'noul',
      name: 'refund',
      instructions: 'Is a refund requested?',
      criteria: { true: 'Commits to paying', false: 'No commitment' },
    });
    expect(parsed.request.questions[1]).toMatchObject({ type: 'score', name: 'severity', criteria: ['Cosmetic', 'Minor', 'Critical'] });
  });

  test('rejects a choice question outside the 2-255 option bound', () => {
    expect(() => parseDecisionRequest({
      model: 'm',
      state: 's',
      questions: { q: { type: 'choice', instructions: 'i', criteria: { only: null } } },
    })).toThrow(/2-255 options/);
  });

  test('rejects a score question outside the 2-10 level bound', () => {
    expect(() => parseDecisionRequest({
      model: 'm',
      state: 's',
      questions: { q: { type: 'score', instructions: 'i', criteria: ['one'] } },
    })).toThrow(/2-10 levels/);
  });

  test('rejects unknown top-level arguments the way System One does', () => {
    expect(() => parseDecisionRequest({ ...choiceRequest, stream: true })).toThrow(/does not support stream/);
  });

  test('rejects questions as an array', () => {
    expect(() => parseDecisionRequest({ model: 'm', state: 's', questions: [] })).toThrow(/questions must be an object/);
  });

  test('rejects an unsupported question type', () => {
    expect(() => parseDecisionRequest({
      model: 'm',
      state: 's',
      questions: { q: { type: 'predicate', instructions: 'i' } },
    })).toThrow(/must be one of noul, choice, score/);
  });
});

describe('decision compatibility', () => {
  const parsed = parseDecisionRequest(choiceRequest);
  const request = parsed.request;

  test('a target with no declared question types answers everything', () => {
    expect(decisionRequestIncompatibility({ protocol: 'systemone' }, request)).toBeNull();
  });

  test('a target declaring only choice rejects a noul question', () => {
    const noul = parseDecisionRequest({ model: 'm', state: 's', questions: { q: { type: 'noul', instructions: 'i' } } }).request;
    expect(decisionRequestIncompatibility({ protocol: 'systemone', questionTypes: ['choice'] }, noul)).toMatch(/noul questions/);
    expect(decisionRequestIncompatibility({ protocol: 'systemone', questionTypes: ['choice'] }, request)).toBeNull();
  });
});

describe('decision request serialization', () => {
  test('a same-protocol forward preserves the raw body and vendor extensions', () => {
    const parsed = parseDecisionRequest(choiceRequest);
    const wire = serializeDecisionRequest('systemone', 'microsoft-decision-1', parsed.request);
    expect(wire).toEqual(choiceRequest);
  });

  test('the OpenAI dialect renames noul to predicate and expands criteria', () => {
    const parsed = parseDecisionRequest({
      model: 'jev-1.13',
      state: 's',
      questions: {
        is_bug: { type: 'noul', instructions: 'Is it a bug?' },
        team: { type: 'choice', instructions: 'Team?', criteria: { billing: 'Charges', other: null } },
        severity: { type: 'score', instructions: 'Severity?', criteria: ['Low', 'High'] },
      },
    });
    const wire = serializeDecisionRequest('openai-decisions', 'gpt-6-luna', parsed.request) as {
      input: unknown; model: string;
      questions: readonly Record<string, unknown>[];
    };
    expect(wire.model).toBe('gpt-6-luna');
    expect(wire.input).toBe('s');
    expect(wire.questions[0]).toEqual({ type: 'predicate', name: 'is_bug', instructions: 'Is it a bug?' });
    expect(wire.questions[1]).toEqual({
      type: 'choice',
      name: 'team',
      instructions: 'Team?',
      choices: [{ value: 'billing', description: 'Charges' }, { value: 'other' }],
    });
    expect(wire.questions[2]).toEqual({
      type: 'score',
      name: 'severity',
      instructions: 'Severity?',
      levels: [{ label: 'Low' }, { label: 'High' }],
    });
  });
});

describe('decision response parsing', () => {
  test('parses the observed Copilot / Azure System One response', () => {
    const body = {
      model: 'microsoft-decision-1',
      answers: {
        team: {
          choice: 'engineering',
          confidence: 0.9997532109087481,
          probabilities: { billing: 0.00012339454562592273, engineering: 0.9998766054543741 },
          type: 'choice',
        },
      },
      usage: { input_tokens: 56, output_tokens: 1 },
    };
    const response = parseDecisionResponse('systemone', body);
    expect(response.model).toBe('microsoft-decision-1');
    expect(response.answers).toEqual([
      {
        type: 'choice',
        name: 'team',
        choice: 'engineering',
        confidence: 0.9997532109087481,
        probabilities: { billing: 0.00012339454562592273, engineering: 0.9998766054543741 },
      },
    ]);
    expect(parseDecisionUsage(body)).toEqual({ inputTokens: 56, outputTokens: 1 });
  });

  test('keeps score legend and full-precision numbers', () => {
    const response = parseDecisionResponse('systemone', {
      answers: {
        s: {
          confidence: 0.9482735850747837,
          legend: { '0': 'Cosmetic', '1': 'Critical' },
          probabilities: { '0': 0.0005316274832540363, '1': 0.9612051888060877 },
          score: 2.9591487229431306,
          type: 'score',
        },
      },
    });
    expect(response.answers[0]).toEqual({
      type: 'score',
      name: 's',
      score: 2.9591487229431306,
      confidence: 0.9482735850747837,
      probabilities: { '0': 0.0005316274832540363, '1': 0.9612051888060877 },
      legend: { '0': 'Cosmetic', '1': 'Critical' },
    });
  });

  test('noul carries no confidence', () => {
    const response = parseDecisionResponse('systemone', {
      answers: { r: { noul: 0.9988304897966891, type: 'noul' } },
    });
    expect(response.answers[0]).toEqual({ type: 'noul', name: 'r', noul: 0.9988304897966891 });
  });

  test('parses the OpenAI answers array and folds value lists into maps', () => {
    const response = parseDecisionResponse('openai-decisions', {
      model: 'gpt-6-luna',
      answers: [
        { type: 'predicate', name: 'damage', probability: 0.92 },
        { type: 'choice', name: 'dept', choice: 'billing', confidence: 0.93, probabilities: [{ value: 'billing', probability: 0.95 }, { value: 'other', probability: 0.05 }] },
        { type: 'score', name: 'sev', score: 1.1, confidence: 0.55, probabilities: [{ value: 0, label: 'Cosmetic', probability: 0.1 }, { value: 2, label: 'Blocked', probability: 0.9 }] },
      ],
    });
    expect(response.answers).toEqual([
      { type: 'noul', name: 'damage', noul: 0.92 },
      { type: 'choice', name: 'dept', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.95, other: 0.05 } },
      { type: 'score', name: 'sev', score: 1.1, confidence: 0.55, probabilities: { '0': 0.1, '2': 0.9 }, legend: { '0': 'Cosmetic', '2': 'Blocked' } },
    ]);
  });
});

describe('decision response rendering', () => {
  test('renders a name-keyed System One body regardless of the upstream dialect', () => {
    const response = parseDecisionResponse('openai-decisions', {
      model: 'gpt-6-luna',
      answers: [{ type: 'predicate', name: 'damage', probability: 0.92 }],
      usage: { input_tokens: 12, output_tokens: 0 },
    });
    expect(renderDecisionResponse(response)).toEqual({
      model: 'gpt-6-luna',
      answers: { damage: { type: 'noul', noul: 0.92 } },
      usage: { input_tokens: 12, output_tokens: 0 },
    });
  });
});
