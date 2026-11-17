import { describe, expect, test } from 'vitest';

import { parseJSONWithRawNumbers } from '../../src/common/json.ts';
import { parseDecisionRequest, parseDecisionResponse, parseDecisionUsage, renderDecisionResponse, serializeDecisionRequest } from '../../src/decision/translate.ts';

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
    const parsed = parseDecisionRequest('typesafe-systemone', choiceRequest);
    expect(parsed.model).toBe('microsoft-decision-1');
    expect(parsed.request.state).toEqual({ kind: 'text', value: 'The API returns 500 on every call.' });
    expect(parsed.request.questions).toEqual([
      {
        type: 'choice',
        name: 'team',
        instructions: 'Which team should handle this ticket?',
        options: [
          { value: 'billing', description: 'Charges, invoices, and refunds' },
          { value: 'engineering', description: 'Bugs, errors, and outages' },
        ],
      },
    ]);
  });

  test('rejects unknown top-level arguments the way System One does', () => {
    expect(() => parseDecisionRequest('typesafe-systemone', { ...choiceRequest, stream: true })).toThrow(/does not support stream/);
  });
});

describe('decision request serialization', () => {
  test('a same-protocol forward preserves the raw body and vendor extensions', () => {
    const parsed = parseDecisionRequest('typesafe-systemone', choiceRequest);
    const wire = serializeDecisionRequest('typesafe-systemone', 'microsoft-decision-1', parsed.request);
    expect(wire).toEqual(choiceRequest);
  });

  test('the OpenAI dialect renames noul to predicate and expands criteria', () => {
    const parsed = parseDecisionRequest('typesafe-systemone', {
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
    const response = parseDecisionResponse('typesafe-systemone', body);
    expect(response.model).toBe('microsoft-decision-1');
    expect(response.answers).toEqual([
      {
        type: 'choice',
        name: 'team',
        choice: 'engineering',
        confidence: 0.9997532109087481,
        probabilities: [
          { value: 'billing', probability: 0.00012339454562592273 },
          { value: 'engineering', probability: 0.9998766054543741 },
        ],
      },
    ]);
    expect(parseDecisionUsage(body)).toEqual({ inputTokens: 56, outputTokens: 1 });
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
      { type: 'choice', name: 'dept', choice: 'billing', confidence: 0.93, probabilities: [{ value: 'billing', probability: 0.95 }, { value: 'other', probability: 0.05 }] },
      { type: 'score', name: 'sev', score: 1.1, confidence: 0.55, probabilities: [{ value: 0, label: 'Cosmetic', probability: 0.1 }, { value: 2, label: 'Blocked', probability: 0.9 }], legend: { '0': 'Cosmetic', '2': 'Blocked' } },
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
    expect(renderDecisionResponse('typesafe-systemone', response)).toEqual({
      model: 'gpt-6-luna',
      answers: { damage: { type: 'noul', noul: 0.92 } },
      usage: { input_tokens: 12, output_tokens: 0 },
    });
  });
});

describe('OpenAI Decisions ingress', () => {

  test('renders an OpenAI answer array from a System One target response', () => {
    const response = parseDecisionResponse('typesafe-systemone', {
      answers: {
        is_bug: { type: 'noul', noul: 0.92 },
        team: { type: 'choice', choice: 'billing', confidence: 0.93, probabilities: { billing: 0.95, other: 0.05 } },
        sev: { type: 'score', score: 1.1, confidence: 0.55, probabilities: { '0': 0.1, '2': 0.9 }, legend: { '0': 'Cosmetic', '2': 'Blocked' } },
      },
      usage: { input_tokens: 12 },
    });
    expect(renderDecisionResponse('openai-decisions', response)).toEqual({
      answers: [
        { type: 'predicate', name: 'is_bug', probability: 0.92 },
        { type: 'choice', name: 'team', choice: 'billing', confidence: 0.93, probabilities: [{ value: 'billing', probability: 0.95 }, { value: 'other', probability: 0.05 }] },
        { type: 'score', name: 'sev', score: 1.1, confidence: 0.55, probabilities: [{ value: 0, label: 'Cosmetic', probability: 0.1 }, { value: 2, label: 'Blocked', probability: 0.9 }] },
      ],
      usage: { input_tokens: 12 },
    });
  });
});

describe('protocol-standard fields', () => {

  test('a typed choice collision is a serialization impossibility, not a content refusal', () => {
    const parsed = parseDecisionRequest('openai-decisions', {
      model: 'm',
      input: 'x',
      questions: [{ type: 'choice', name: 'q', instructions: 'i', choices: [{ value: true }, { value: 'true' }] }],
    });
    // It cannot be lowered to System One, whose option keys are strings.
    expect(() => serializeDecisionRequest('typesafe-systemone', 'raw', parsed.request)).toThrow(/collapse to the same System One label/);
  });
});

describe('image evidence', () => {
  const imageRequest = {
    model: 'm',
    input: [{
      role: 'user', content: [
        { type: 'input_text', text: 'Inspect this.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
      ],
    }],
    questions: [{ type: 'predicate', name: 'damaged', instructions: 'Is it damaged?' }],
  };

  test('lowers image parts into System One assets', () => {
    const parsed = parseDecisionRequest('openai-decisions', imageRequest);
    const wire = serializeDecisionRequest('typesafe-systemone', 'raw', parsed.request) as {
      state: unknown; assets: Record<string, { format: string; data_base64: string }>;
    };
    expect(wire.assets).toEqual({ 'image-0': { type: 'image', format: 'png', data_base64: 'AAAA' } });
    expect(wire.state).toEqual(['Inspect this.', 'image-0']);
  });
});

describe('required answer fields', () => {

  test('the OpenAI shape requires confidence and probabilities too', () => {
    expect(() => parseDecisionResponse('openai-decisions', {
      answers: [{ type: 'choice', name: 'q', choice: 'a', probabilities: [{ value: 'a', probability: 1 }] }],
    })).toThrow(/answers\.q\.confidence/);
    expect(() => parseDecisionResponse('openai-decisions', {
      answers: [{ type: 'predicate', name: 'p', probability: 0.5 }, { type: 'score', name: 'q', score: 1, confidence: 1 }],
    })).toThrow(/answers\.q\.probabilities/);
  });
});

describe('refusal answers', () => {

  test('System One cannot express a refusal', () => {
    const response = parseDecisionResponse('openai-decisions', {
      answers: [{ type: 'refusal', name: 'private' }],
    });
    expect(() => renderDecisionResponse('typesafe-systemone', response)).toThrow(/refusal, which System One cannot express/);
  });
});

describe('number token fidelity', () => {
  test('a raw-number parse keeps a probability lexeme through a cross-dialect render', () => {
    const body = parseJSONWithRawNumbers('{"answers":{"q":{"type":"noul","noul":1.0}}}') as Record<string, unknown>;
    const response = parseDecisionResponse('typesafe-systemone', body);
    // The source wrote `1.0`; a plain JSON.parse would re-emit `1`.
    expect(JSON.stringify(renderDecisionResponse('openai-decisions', response))).toContain('"probability":1.0');
  });

  test('a value beyond the double range survives instead of becoming null', () => {
    const body = parseJSONWithRawNumbers('{"answers":{"q":{"type":"noul","noul":1e400}}}') as Record<string, unknown>;
    // Infinity is not a number the contract allows, so the answer is rejected
    // rather than silently written as null.
    expect(() => parseDecisionResponse('typesafe-systemone', body)).toThrow(/must be a finite number/);
  });
});
