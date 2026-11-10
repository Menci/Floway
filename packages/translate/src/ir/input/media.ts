import type { IRInputMedia } from './types.ts';

const DATA_URL = /^data:([^;,]+)?;base64,(.*)$/s;

/**
 * Reads a URL as media, decoding a `data:` URL into the IR's base64 arm.
 *
 * Every wire that accepts an image or a file as a URL accepts this form, and
 * the decoding is the same whichever wire delivered it, so it belongs here
 * rather than in one protocol's reader.
 */
export const mediaFromURL = (url: string): IRInputMedia => {
  const dataUrl = DATA_URL.exec(url);
  if (dataUrl === null) return { source_kind: 'url', url };
  const mediaType = dataUrl[1]?.trim();
  return { source_kind: 'base64', ...(mediaType === undefined || mediaType === '' ? {} : { media_type: mediaType }), data: dataUrl[2] };
};
