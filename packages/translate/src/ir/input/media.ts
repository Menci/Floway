import type { IRInputMedia } from './types.ts';
import { TranslateInputException } from '../../types.ts';

// RFC 2397: `data:[<mediatype>][;base64],<data>`, where a mediatype may carry
// parameters (`text/csv;charset=utf-8`). Only the base64 form is decoded here;
// anything else is left as the URL it is.
const DATA_URL = /^data:([^,]*),([\s\S]*)$/;
const BASE64_MARKER = ';base64';

/**
 * Reads a URL as media, decoding a base64 `data:` URL into the IR's base64 arm.
 *
 * Every wire that accepts an image or a file as a URL accepts this form, and
 * the decoding is the same whichever wire delivered it, so it belongs here
 * rather than in one protocol's reader.
 *
 * `undefined` means the value is a `data:` URL this cannot decode, which is not
 * the same as one that is not a data URL at all: a caller holding raw base64
 * must not mistake either for the other.
 */
export const mediaFromURL = (url: string): IRInputMedia | undefined => {
  const dataUrl = DATA_URL.exec(url);
  if (dataUrl === null) return { source_kind: 'url', url };
  const [, header = '', body = ''] = dataUrl;
  if (!header.endsWith(BASE64_MARKER)) return undefined;
  // The media type is everything before the parameters, which are separated by
  // `;`; a header that states none leaves the type unstated.
  const [mediaType = ''] = header.slice(0, -BASE64_MARKER.length).split(';');
  const essence = mediaType.trim();
  return { source_kind: 'base64', ...(essence === '' ? {} : { media_type: essence }), data: body };
};

/**
 * The media a URL states, refusing one whose `data:` form this cannot decode.
 *
 * A caller that only knows the value is a URL has nothing to fall back on: the
 * text of a data URL is not the payload it describes, so carrying it as one
 * would send something the upstream cannot read.
 */
export const mediaOrThrow = (media: IRInputMedia | undefined, url: string): IRInputMedia => {
  if (media === undefined) throw new TranslateInputException(`Cannot decode a data URL: ${url.slice(0, 32)}`);
  return media;
};
