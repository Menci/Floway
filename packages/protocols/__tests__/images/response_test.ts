import { describe, expect, test } from 'vitest';

import { renderErrorEnvelope, upstreamErrorMessage } from '../../src/common/error-envelope.ts';
import { parseImagesResponse, parseImagesUsage, renderImagesResponse } from '../../src/images/response.ts';

describe('images response ingress', () => {
  test('the answer is parsed and rendered back whole, fields the gateway does not model included', () => {
    const body = {
      created: 1713833628,
      data: [{ b64_json: 'aGVsbG8=', revised_prompt: 'a shiba, in space' }, { url: 'https://example.com/a.png' }],
      background: 'transparent',
      output_format: 'png',
    };

    const parsed = parseImagesResponse(body);

    expect(parsed.images).toEqual([
      { base64: 'aGVsbG8=', revisedPrompt: 'a shiba, in space' },
      { url: 'https://example.com/a.png' },
    ]);
    expect(renderImagesResponse(parsed)).toBe(body);
  });

  test('an answer carrying no images at all is read as such, and one that cannot be read is an error', () => {
    expect(parseImagesResponse({ created: 1 }).images).toEqual([]);
    expect(() => parseImagesResponse({ data: 'one image' })).toThrow('Images response data must be an array');
    expect(() => parseImagesResponse({ data: [{ b64_json: 42 }] })).toThrow('Images response data[0].b64_json must be a string');
    expect(() => parseImagesResponse('an image')).toThrow('Images response body must be an object');
  });
});

describe('images usage', () => {
  test('what the upstream attributed to images is taken out of the count beside it', () => {
    expect(parseImagesUsage({
      usage: {
        total_tokens: 100,
        input_tokens: 50,
        output_tokens: 50,
        input_tokens_details: { text_tokens: 10, image_tokens: 40 },
      },
    })).toEqual({ inputTokens: 10, inputImageTokens: 40, outputTokens: 50 });
  });

  test('a count with no detail beside it is the whole count, and a detail saying nothing is as good as absent', () => {
    expect(parseImagesUsage({ usage: { input_tokens: 10, output_tokens: 50 } }))
      .toEqual({ inputTokens: 10, outputTokens: 50 });
    expect(parseImagesUsage({ usage: { input_tokens: 10, input_tokens_details: {} } }))
      .toEqual({ inputTokens: 10 });
    expect(parseImagesUsage({ usage: { output_tokens: 50, output_tokens_details: { image_tokens: 50 } } }))
      .toEqual({ outputTokens: 0, outputImageTokens: 50 });
  });

  // The distinction the return type exists for: an upstream that reported nothing is a
  // different fact from one that reported zero, and only the second is a reading.
  test('nothing readable is no reading, and a reported zero is one', () => {
    expect(parseImagesUsage({ data: [] })).toBeUndefined();
    expect(parseImagesUsage({ usage: {} })).toBeUndefined();
    expect(parseImagesUsage({ usage: { input_tokens: '50' } })).toBeUndefined();
    expect(parseImagesUsage({ usage: { input_tokens: 10, input_tokens_details: 'text' } })).toBeUndefined();
    expect(parseImagesUsage({ usage: { input_tokens: 0, output_tokens: 0 } }))
      .toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('images failures', () => {
  test('an upstream error object is what the client is sent, and anything else becomes the gateway envelope', () => {
    const upstream = { error: { message: 'Your request was rejected', type: 'image_generation_user_error', code: 'moderation_blocked' } };

    expect(upstreamErrorMessage(upstream)).toBe('Your request was rejected');
    expect(renderErrorEnvelope('Your request was rejected', upstream)).toBe(upstream);

    expect(upstreamErrorMessage('upstream is down')).toBeUndefined();
    expect(renderErrorEnvelope('Model gpt-image-1 is not available on any configured upstream.', undefined))
      .toEqual({ error: { message: 'Model gpt-image-1 is not available on any configured upstream.', type: 'api_error' } });
  });
});
