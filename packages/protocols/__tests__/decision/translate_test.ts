import { describe, expect, test } from 'vitest';

import { parseJSONWithRawNumbers } from '../../src/common/json.ts';
import { DecisionResponseValidationError, decodeDecisionResponse, parseDecisionRequest, parseDecisionResponse, parseDecisionUsage, renderDecisionResponse, serializeDecisionRequest } from '../../src/decision/index.ts';

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

  test('rejects unknown top-level arguments the way System One does', () => {
    expect(() => parseDecisionRequest('typesafe-systemone', { ...choiceRequest, stream: true })).toThrow();
  });
});

describe('decision request serialization', () => {

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
    expect(() => serializeDecisionRequest('typesafe-systemone', 'raw', parsed.request)).toThrow();
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

describe('refusal answers', () => {

  test('System One cannot express a refusal', () => {
    const response = parseDecisionResponse('openai-decisions', {
      answers: [{ type: 'refusal', name: 'private' }],
    });
    expect(() => renderDecisionResponse('typesafe-systemone', response)).toThrow();
  });
});

describe('number token fidelity', () => {
  test('a raw-number parse keeps a probability lexeme through a cross-dialect render', () => {
    const body = parseJSONWithRawNumbers('{"answers":{"q":{"type":"noul","noul":1.0}}}') as Record<string, unknown>;
    const response = parseDecisionResponse('typesafe-systemone', body);
    // The source wrote `1.0`; a plain JSON.parse would re-emit `1`.
    expect(JSON.stringify(renderDecisionResponse('openai-decisions', response))).toContain('"probability":1.0');
  });

});

describe('decision response decoding', () => {
  test('returns a validation failure for a malformed probability during cross-dialect decoding', () => {
    const body = { answers: { q: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: '1' } } } };
    const decoded = decodeDecisionResponse('typesafe-systemone', body);
    const message = 'answers.q.probabilities.yes must be a finite number';
    expect(decoded).toEqual({ ok: false, error: new DecisionResponseValidationError(message) });
    expect(() => parseDecisionResponse('typesafe-systemone', body)).toThrow(message);
  });

  test('renders nested System One probabilities into OpenAI Decisions with their original tokens', () => {
    const body = parseJSONWithRawNumbers('{"answers":{"q":{"type":"choice","choice":"yes","confidence":1e0,"probabilities":{"yes":1.00}}}}');
    const decoded = decodeDecisionResponse('typesafe-systemone', body);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw decoded.error;
    const rendered = JSON.stringify(renderDecisionResponse('openai-decisions', decoded.value));
    expect(rendered).toContain('"confidence":1e0');
    expect(rendered).toContain('"probability":1.00');
  });

  test('propagates unexpected response access failures', () => {
    const failure = new Error('injected access failure');
    let thrown: unknown;
    try {
      decodeDecisionResponse('openai-decisions', { get answers() { throw failure; } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
  });
});
