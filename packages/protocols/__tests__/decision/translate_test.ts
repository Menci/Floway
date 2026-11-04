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
    const parsed = parseDecisionRequest('systemone', choiceRequest);
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

  test('keeps noul criteria and score levels', () => {
    const parsed = parseDecisionRequest('systemone', {
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
    expect(parsed.request.questions[1]).toMatchObject({
      type: 'score',
      name: 'severity',
      levels: [{ label: 'Cosmetic' }, { label: 'Minor' }, { label: 'Critical' }],
    });
  });

  test('rejects a choice question outside the 2-255 option bound', () => {
    expect(() => parseDecisionRequest('systemone', {
      model: 'm',
      state: 's',
      questions: { q: { type: 'choice', instructions: 'i', criteria: { only: null } } },
    })).toThrow(/2-255 options/);
  });

  test('rejects a score question outside the 2-10 level bound', () => {
    expect(() => parseDecisionRequest('systemone', {
      model: 'm',
      state: 's',
      questions: { q: { type: 'score', instructions: 'i', criteria: ['one'] } },
    })).toThrow(/2-10 levels/);
  });

  test('rejects unknown top-level arguments the way System One does', () => {
    expect(() => parseDecisionRequest('systemone', { ...choiceRequest, stream: true })).toThrow(/does not support stream/);
  });

  test('rejects questions as an array', () => {
    expect(() => parseDecisionRequest('systemone', { model: 'm', state: 's', questions: [] })).toThrow(/questions must be an object/);
  });

  test('rejects an unsupported question type', () => {
    expect(() => parseDecisionRequest('systemone', {
      model: 'm',
      state: 's',
      questions: { q: { type: 'predicate', instructions: 'i' } },
    })).toThrow(/must be one of noul, choice, score/);
  });
});

describe('decision request serialization', () => {
  test('a same-protocol forward preserves the raw body and vendor extensions', () => {
    const parsed = parseDecisionRequest('systemone', choiceRequest);
    const wire = serializeDecisionRequest('systemone', 'microsoft-decision-1', parsed.request);
    expect(wire).toEqual(choiceRequest);
  });

  test('the OpenAI dialect renames noul to predicate and expands criteria', () => {
    const parsed = parseDecisionRequest('systemone', {
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
        probabilities: [
          { value: 'billing', probability: 0.00012339454562592273 },
          { value: 'engineering', probability: 0.9998766054543741 },
        ],
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
      probabilities: [
        { value: 0, label: 'Cosmetic', probability: 0.0005316274832540363 },
        { value: 1, label: 'Critical', probability: 0.9612051888060877 },
      ],
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
    expect(renderDecisionResponse('systemone', response)).toEqual({
      model: 'gpt-6-luna',
      answers: { damage: { type: 'noul', noul: 0.92 } },
      usage: { input_tokens: 12, output_tokens: 0 },
    });
  });
});

describe('OpenAI Decisions ingress', () => {
  test('parses the OpenAI shape into canonical questions', () => {
    const parsed = parseDecisionRequest('openai-decisions', {
      model: 'gpt-6-luna',
      input: 'I was charged twice for my order.',
      questions: [
        { type: 'predicate', name: 'duplicate', instructions: 'Is this a duplicate charge?' },
        { type: 'choice', name: 'department', instructions: 'Which department?', choices: [{ value: 'billing', description: 'Refunds' }, { value: 'other' }] },
        { type: 'score', name: 'severity', instructions: 'How severe?', levels: [{ label: 'Low' }, { label: 'High' }] },
      ],
    });
    expect(parsed.request.sourceProtocol).toBe('openai-decisions');
    expect(parsed.request.state).toEqual({ kind: 'text', value: 'I was charged twice for my order.' });
    expect(parsed.request.questions).toEqual([
      { type: 'noul', name: 'duplicate', instructions: 'Is this a duplicate charge?' },
      { type: 'choice', name: 'department', instructions: 'Which department?', options: [{ value: 'billing', description: 'Refunds' }, { value: 'other' }] },
      { type: 'score', name: 'severity', instructions: 'How severe?', levels: [{ label: 'Low' }, { label: 'High' }] },
    ]);
  });

  test('rejects an unknown top-level argument', () => {
    expect(() => parseDecisionRequest('openai-decisions', { model: 'm', input: 's', questions: [], state: 'x' }))
      .toThrow(/does not support state/);
  });

  test('rejects questions as an object', () => {
    expect(() => parseDecisionRequest('openai-decisions', { model: 'm', input: 's', questions: {} }))
      .toThrow(/must be an array/);
  });

  test('renders an OpenAI answer array from a System One target response', () => {
    const response = parseDecisionResponse('systemone', {
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

  test('a same-dialect forward preserves the raw OpenAI body', () => {
    const raw = {
      model: 'gpt-6-luna',
      input: 'x',
      questions: [{ type: 'predicate', name: 'p', instructions: 'i' }],
      prompt_cache_key: 'k',
    };
    const parsed = parseDecisionRequest('openai-decisions', raw);
    expect(serializeDecisionRequest('openai-decisions', 'raw-model', parsed.request)).toEqual({ ...raw, model: 'raw-model' });
  });
});

describe('protocol-standard fields', () => {
  test('keeps typed boolean choice values through OpenAI ingress', () => {
    const parsed = parseDecisionRequest('openai-decisions', {
      model: 'm',
      input: 'x',
      questions: [{
        type: 'choice',
        name: 'q',
        instructions: 'i',
        choices: [{ value: true, description: 'yes' }, { value: 'true' }],
      }],
    });
    expect(parsed.request.questions[0]).toEqual({
      type: 'choice',
      name: 'q',
      instructions: 'i',
      options: [{ value: true, description: 'yes' }, { value: 'true' }],
    });
  });

  test('a typed choice collision is a serialization impossibility, not a content refusal', () => {
    const parsed = parseDecisionRequest('openai-decisions', {
      model: 'm',
      input: 'x',
      questions: [{ type: 'choice', name: 'q', instructions: 'i', choices: [{ value: true }, { value: 'true' }] }],
    });
    // It cannot be lowered to System One, whose option keys are strings.
    expect(() => serializeDecisionRequest('systemone', 'raw', parsed.request)).toThrow(/collapse to the same System One label/);
  });

  test('keeps score level descriptions through OpenAI ingress and rendering', () => {
    const parsed = parseDecisionRequest('openai-decisions', {
      model: 'm',
      input: 'x',
      questions: [{
        type: 'score',
        name: 'sev',
        instructions: 'i',
        levels: [{ label: 'Low', description: 'Cosmetic only' }, { label: 'High' }],
      }],
    });
    expect(parsed.request.questions[0]).toMatchObject({ levels: [{ label: 'Low', description: 'Cosmetic only' }, { label: 'High' }] });
    const wire = serializeDecisionRequest('openai-decisions', 'raw', parsed.request) as { questions: readonly Record<string, unknown>[] };
    expect(wire.questions[0].levels).toEqual([{ label: 'Low', description: 'Cosmetic only' }, { label: 'High' }]);
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

  test('parses image parts into an ordered state', () => {
    const parsed = parseDecisionRequest('openai-decisions', imageRequest);
    expect(parsed.request.state).toEqual({
      kind: 'parts',
      parts: [
        { type: 'text', text: 'Inspect this.' },
        { type: 'image', imageUrl: 'data:image/png;base64,AAAA', detail: 'high' },
      ],
    });
  });

  test('lowers image parts into System One assets', () => {
    const parsed = parseDecisionRequest('openai-decisions', imageRequest);
    const wire = serializeDecisionRequest('systemone', 'raw', parsed.request) as {
      state: unknown; assets: Record<string, { format: string; data_base64: string }>;
    };
    expect(wire.assets).toEqual({ 'image-0': { type: 'image', format: 'png', data_base64: 'AAAA' } });
    expect(wire.state).toEqual(['Inspect this.', 'image-0']);
  });

  test('lifts System One assets back into image parts', () => {
    const parsed = parseDecisionRequest('systemone', {
      model: 'm',
      state: { photo: 'img-1' },
      assets: { 'img-1': { type: 'image', format: 'jpg', data_base64: 'BBBB' } },
      questions: { q: { type: 'noul', instructions: 'Is `photo` damaged?' } },
    });
    // The structure stays as sent; the images its references resolved to ride
    // alongside so a target speaking inline image parts still receives them.
    expect(parsed.request.state).toEqual({
      kind: 'json',
      value: { photo: 'img-1' },
      images: [{ type: 'image', imageUrl: 'data:image/jpeg;base64,BBBB' }],
    });
  });

  test('re-serializes image evidence back into the OpenAI shape', () => {
    const parsed = parseDecisionRequest('openai-decisions', imageRequest);
    const wire = serializeDecisionRequest('openai-decisions', 'raw', parsed.request) as Record<string, unknown>;
    expect(wire.input).toEqual([{
      role: 'user', content: [
        { type: 'input_text', text: 'Inspect this.' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
      ],
    }]);
  });

  test('a sole input_json part becomes a structured state', () => {
    const parsed = parseDecisionRequest('openai-decisions', {
      model: 'm',
      input: [{ role: 'user', content: [{ type: 'input_json', data: { ticket: 'x', count: 3 } }] }],
      questions: [{ type: 'predicate', name: 'p', instructions: 'i' }],
    });
    expect(parsed.request.state).toEqual({ kind: 'json', value: { ticket: 'x', count: 3 } });
  });
});

describe('required answer fields', () => {
  test('a Choice answer missing confidence is a broken response', () => {
    expect(() => parseDecisionResponse('systemone', {
      answers: { q: { type: 'choice', choice: 'a', probabilities: { a: 1 } } },
    })).toThrow(/answers\.q\.confidence/);
  });

  test('a Choice answer missing probabilities is a broken response', () => {
    expect(() => parseDecisionResponse('systemone', {
      answers: { q: { type: 'choice', choice: 'a', confidence: 1 } },
    })).toThrow(/answers\.q\.probabilities/);
  });

  test('a Score answer missing confidence is a broken response', () => {
    expect(() => parseDecisionResponse('systemone', {
      answers: { q: { type: 'score', score: 1, probabilities: { '0': 1 }, legend: { '0': 'low' } } },
    })).toThrow(/answers\.q\.confidence/);
  });

  test('the OpenAI shape requires confidence and probabilities too', () => {
    expect(() => parseDecisionResponse('openai-decisions', {
      answers: [{ type: 'choice', name: 'q', choice: 'a', probabilities: [{ value: 'a', probability: 1 }] }],
    })).toThrow(/answers\.q\.confidence/);
    expect(() => parseDecisionResponse('openai-decisions', {
      answers: [{ type: 'predicate', name: 'p', probability: 0.5 }, { type: 'score', name: 'q', score: 1, confidence: 1 }],
    })).toThrow(/answers\.q\.probabilities/);
  });

  test('a noul answer has no confidence, and none is required', () => {
    const response = parseDecisionResponse('systemone', { answers: { q: { type: 'noul', noul: 0.5 } } });
    expect(response.answers[0]).toEqual({ type: 'noul', name: 'q', noul: 0.5 });
  });
});

describe('refusal answers', () => {
  test('carries a refusal through while the other answers still resolve', () => {
    const response = parseDecisionResponse('openai-decisions', {
      answers: [
        { type: 'refusal', name: 'private' },
        { type: 'predicate', name: 'public', probability: 0.9 },
      ],
    });
    expect(response.answers).toEqual([
      { type: 'refusal', name: 'private' },
      { type: 'noul', name: 'public', noul: 0.9 },
    ]);
  });

  test('renders a refusal back into the OpenAI shape', () => {
    const response = parseDecisionResponse('openai-decisions', {
      answers: [{ type: 'refusal', name: 'private' }],
    });
    expect(renderDecisionResponse('openai-decisions', response)).toEqual({
      answers: [{ type: 'refusal', name: 'private' }],
    });
  });

  test('System One cannot express a refusal', () => {
    const response = parseDecisionResponse('openai-decisions', {
      answers: [{ type: 'refusal', name: 'private' }],
    });
    expect(() => renderDecisionResponse('systemone', response)).toThrow(/refusal, which System One cannot express/);
  });
});

describe('number token fidelity', () => {
  test('a raw-number parse keeps a probability lexeme through a cross-dialect render', () => {
    const body = parseJSONWithRawNumbers('{"answers":{"q":{"type":"noul","noul":1.0}}}') as Record<string, unknown>;
    const response = parseDecisionResponse('systemone', body);
    // The source wrote `1.0`; a plain JSON.parse would re-emit `1`.
    expect(JSON.stringify(renderDecisionResponse('openai-decisions', response))).toContain('"probability":1.0');
  });

  test('a value beyond the double range survives instead of becoming null', () => {
    const body = parseJSONWithRawNumbers('{"answers":{"q":{"type":"noul","noul":1e400}}}') as Record<string, unknown>;
    // Infinity is not a number the contract allows, so the answer is rejected
    // rather than silently written as null.
    expect(() => parseDecisionResponse('systemone', body)).toThrow(/must be a finite number/);
  });
});
