import type { IRInputMedia } from '../../../ir/input/types.ts';
import type { RemoteImageLoader } from '../../../types.ts';
import type { AnthropicMessagesImageBlock } from '@floway-dev/protocols/anthropic-messages';
import { encodeBase64, mediaTypeEssence } from '@floway-dev/protocols/common';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const parseDataUrl = (url: string): { mediaType: string; data: string } | null => {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mediaType = mediaTypeEssence(match[1]);
  return mediaType === null ? null : { mediaType, data: match[2] };
};

const inferMediaTypeFromUrl = (url: string): string | null => {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.gif')) return 'image/gif';
    if (path.endsWith('.webp')) return 'image/webp';
  } catch {
    return null;
  }

  return null;
};

const resolveRemoteImage = async (url: string, loadRemoteImage: RemoteImageLoader): Promise<AnthropicMessagesImageBlock | null> => {
  const image = await loadRemoteImage(url);
  if (!image) return null;

  let mediaType = mediaTypeEssence(image.mediaType) ?? '';
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
    mediaType = inferMediaTypeFromUrl(url) ?? '';
  }
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) return null;

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType as Extract<AnthropicMessagesImageBlock['source'], { type: 'base64' }>['media_type'],
      data: encodeBase64(image.data),
    },
  };
};

export const resolveImageUrlToAnthropicMessagesImage = async (url: string, loadRemoteImage: RemoteImageLoader): Promise<AnthropicMessagesImageBlock | null> => {
  const dataUrl = parseDataUrl(url);

  if (dataUrl) {
    if (!ALLOWED_IMAGE_TYPES.has(dataUrl.mediaType)) return null;

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrl.mediaType as Extract<AnthropicMessagesImageBlock['source'], { type: 'base64' }>['media_type'],
        data: dataUrl.data,
      },
    };
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
  return await resolveRemoteImage(url, loadRemoteImage);
};

/**
 * Resolves an input IR image into a Messages image block.
 *
 * A base64 image is validated through the same data-URL path the source used,
 * so an unsupported media type is dropped exactly as it was there. A file ID is
 * passed through: Messages accepts one, and whether the upstream behind this
 * Messages endpoint knows that ID is the upstream's question, not ours.
 */
export const resolveAnthropicMessagesImage = (loadRemoteImage: RemoteImageLoader) => async (media: IRInputMedia): Promise<AnthropicMessagesImageBlock | null> => {
  switch (media.source_kind) {
  case 'file': return { type: 'image', source: { type: 'file', file_id: media.file_id } };
  case 'url': return await resolveImageUrlToAnthropicMessagesImage(media.url, loadRemoteImage);
  case 'base64': return await resolveImageUrlToAnthropicMessagesImage(`data:${media.media_type ?? ''};base64,${media.data}`, loadRemoteImage);
  }
};
