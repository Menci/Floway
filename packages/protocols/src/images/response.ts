// Reading the upstream's answer, and writing the client's. There is one images protocol, so
// the two are the same shape and rendering a success is re-serializing what was parsed —
// which is what keeps the fields this file does not name from being dropped on the way out.

import type { CanonicalImage, CanonicalImagesResponse, CanonicalImagesUsage } from './index.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseImagesResponse = (value: unknown): CanonicalImagesResponse => {
  if (!isRecord(value)) throw new Error('Images response body must be an object');
  const usage = parseImagesUsage(value);
  return {
    raw: value,
    images: parseImages(value.data),
    ...(usage === undefined ? {} : { usage }),
  };
};

// An answer that carries no `data` at all is not malformed — an upstream reporting a
// moderation refusal in a 200 does exactly that — so it parses to no images, and only a `data`
// that is there but cannot be read is an error.
const parseImages = (data: unknown): CanonicalImage[] => {
  if (data === undefined) return [];
  if (!Array.isArray(data)) throw new Error('Images response data must be an array');
  return data.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Images response data[${index}] must be an object`);
    const url = optionalString(entry.url, `Images response data[${index}].url`);
    const base64 = optionalString(entry.b64_json, `Images response data[${index}].b64_json`);
    const revisedPrompt = optionalString(entry.revised_prompt, `Images response data[${index}].revised_prompt`);
    return {
      ...(url === undefined ? {} : { url }),
      ...(base64 === undefined ? {} : { base64 }),
      ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
    };
  });
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
};

/**
 * What the upstream said it charged for, or nothing when it said nothing readable. The
 * distinction is the whole point of the return type: an upstream that reported no usage is a
 * different fact from one that reported zero, and only one of them is a reading.
 */
export const parseImagesUsage = (value: unknown): CanonicalImagesUsage | undefined => {
  if (!isRecord(value) || !isRecord(value.usage)) return undefined;
  const {
    input_tokens: inputTotal,
    output_tokens: outputTotal,
    input_tokens_details: inputDetails,
    output_tokens_details: outputDetails,
  } = value.usage;
  if (inputTotal !== undefined && typeof inputTotal !== 'number') return undefined;
  if (outputTotal !== undefined && typeof outputTotal !== 'number') return undefined;
  if (inputTotal === undefined && outputTotal === undefined) return undefined;

  const input = splitModality(inputTotal, inputDetails);
  const output = splitModality(outputTotal, outputDetails);
  if (input === null || output === null) return undefined;
  return {
    ...(input.text === undefined ? {} : { inputTokens: input.text }),
    ...(input.image === undefined ? {} : { inputImageTokens: input.image }),
    ...(output.text === undefined ? {} : { outputTokens: output.text }),
    ...(output.image === undefined ? {} : { outputImageTokens: output.image }),
  };
};

// `input_tokens` counts images and text together and `input_tokens_details` says how much of it
// was images, so the two are made disjoint here: what stays under the plain count is the text.
// A details object carrying neither split says nothing and is as good as absent, while one that
// cannot be read discards the whole reading rather than half of it.
const splitModality = (
  total: number | undefined,
  details: unknown,
): { text?: number; image?: number } | null => {
  if (total === undefined) return {};
  if (details === undefined) return { text: total };
  if (!isRecord(details)) return null;
  const { text_tokens: text, image_tokens: image } = details;
  if (text !== undefined && typeof text !== 'number') return null;
  if (image !== undefined && typeof image !== 'number') return null;
  if (text === undefined && image === undefined) return { text: total };
  return { text: text ?? 0, image: image ?? 0 };
};

export const renderImagesResponse = (response: CanonicalImagesResponse): Record<string, unknown> => response.raw;

/** What an upstream that refused said about it, when it said it in the shape this protocol
 *  uses. Anything else has no message to lift and is reported as the body it was. */

