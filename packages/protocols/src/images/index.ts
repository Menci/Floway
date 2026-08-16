// The images protocol: POST /v1/images/generations and POST /v1/images/edits. One protocol
// over two endpoints — generations takes JSON, and edits takes either JSON, where every image
// is a URL, a data URL or a file id, or a multipart form carrying the files themselves.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12858-L12870
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12558-L12620

export type ImagesOperation = 'generations' | 'edits';

// JSON payload accepted by POST /v1/images/generations. Field set follows
// OpenAI's reference for gpt-image-* and legacy dall-e-* (dall-e is
// retired but the union shape is harmless). Declared as an interface with
// a trailing index signature so future OpenAI additions flow through
// without a gateway-side reject while named fields keep their narrow
// types when accessed directly — the `T & Record<string, unknown>`
// intersection form would widen every typed field to `unknown` on read.
export interface ImagesGenerationsPayload {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'low' | 'auto';
  response_format?: 'url' | 'b64_json';
  stream?: boolean;
  partial_images?: number;
  user?: string;
  [key: string]: unknown;
}

// POST /v1/images/edits accepts JSON references that point at a URL/data URL
// or an uploaded file.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12558-L12620
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L47542-L47673
export type ImageEditReference =
  | { image_url: string; file_id?: never; [key: string]: unknown }
  | { file_id: string; image_url?: never; [key: string]: unknown };

/** A file the client sent in a multipart form, held as bytes: a form is a parsed value like
 *  any other, and bytes are what survives being read once and what a dump can show. */
export interface ImagesUploadedFile {
  fileName: string;
  mediaType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** One image an edit reads. Multipart carries the file itself; JSON carries a reference for
 *  the upstream to resolve, kept exactly as the client wrote it — whether a data URL can be
 *  turned back into a file is the upstream serializer's question, not this one's. */
export type ImagesEditImage =
  | { kind: 'file'; file: ImagesUploadedFile }
  | { kind: 'reference'; reference: ImageEditReference };

export interface CanonicalImagesGenerationsRequest {
  operation: 'generations';
  /** Everything the client sent but `model`: routing owns the model id, and what is left is
   *  what the upstream is asked for. */
  parameters: Record<string, unknown>;
}

export interface CanonicalImagesEditsRequest {
  operation: 'edits';
  images: ImagesEditImage[];
  mask?: ImagesEditImage;
  parameters: Record<string, unknown>;
}

export type CanonicalImagesRequest = CanonicalImagesGenerationsRequest | CanonicalImagesEditsRequest;

export interface ParsedImagesRequest {
  model: string;
  request: CanonicalImagesRequest;
}

/** One image the upstream returned. `response_format` decides which arm carries it on the
 *  dall-e models, while the GPT image models answer base64 and do not serve a URL at all, so
 *  neither arm is the one to expect.
 *  https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L51044-L51067 */
export interface CanonicalImage {
  url?: string;
  base64?: string;
  revisedPrompt?: string;
}

/** Token counts as the images endpoints report them, disjoint: what the upstream attributed to
 *  images is taken out of the count beside it. Only the GPT image models report any of this —
 *  the dall-e models report nothing — which is why the whole reading is optional as well as
 *  each field.
 *  https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L78089-L78115 */
export interface CanonicalImagesUsage {
  inputTokens?: number;
  inputImageTokens?: number;
  outputTokens?: number;
  outputImageTokens?: number;
}

export interface CanonicalImagesResponse {
  /** The parsed body as it arrived. One protocol in and one out means rendering is
   *  re-serializing this, so the fields the gateway does not model still reach the client. */
  raw: Record<string, unknown>;
  images: CanonicalImage[];
  usage?: CanonicalImagesUsage;
}

export { parseImagesEditsRequest, parseImagesGenerationsRequest } from './request.ts';
export { imagesErrorMessage, parseImagesResponse, parseImagesUsage, renderImagesError, renderImagesResponse } from './response.ts';
