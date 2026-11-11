import type { IRInputMedia } from './types.ts';
import { TranslateInputException } from '../../shared/input-error.ts';

// RFC 2397 data URLs may include media-type parameters before ;base64.
// https://www.rfc-editor.org/rfc/rfc2397#section-2
const DATA_URL = /^data:([^,]*),([\s\S]*)$/;
const BASE64_MARKER = ';base64';

/**
 * Supported base64 data URLs become inline media; ordinary URLs remain references.
 * Undefined identifies a data URL with an unsupported encoding.
 */
export const mediaFromURL = (url: string): IRInputMedia | undefined => {
  const dataUrl = DATA_URL.exec(url);
  if (dataUrl === null) return { source_kind: 'url', url };
  const header = dataUrl[1]!;
  const body = dataUrl[2]!;
  if (!header.endsWith(BASE64_MARKER)) return undefined;
  const mediaType = header.slice(0, -BASE64_MARKER.length).split(';')[0]!;
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
