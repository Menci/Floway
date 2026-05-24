import type { MessagesImageBlock } from '@floway-dev/protocols/messages';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export interface RemoteImageData {
  mediaType: string | null;
  data: Uint8Array;
}

export type RemoteImageLoader = (url: string) => Promise<RemoteImageData | null>;

const parseDataUrl = (url: string): { mediaType: string; data: string } | null => {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  return match ? { mediaType: match[1], data: match[2] } : null;
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

const uint8ArrayToBase64 = (bytes: Uint8Array): string => {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
};

const resolveRemoteImage = async (url: string, loadRemoteImage: RemoteImageLoader): Promise<MessagesImageBlock | null> => {
  const image = await loadRemoteImage(url);
  if (!image) return null;

  let mediaType = image.mediaType?.split(';')[0].trim() ?? '';
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
    mediaType = inferMediaTypeFromUrl(url) ?? '';
  }
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) return null;

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType as MessagesImageBlock['source']['media_type'],
      data: uint8ArrayToBase64(image.data),
    },
  };
};

export const resolveImageUrlToMessagesImage = async (url: string, loadRemoteImage: RemoteImageLoader): Promise<MessagesImageBlock | null> => {
  const dataUrl = parseDataUrl(url);

  if (dataUrl) {
    if (!ALLOWED_IMAGE_TYPES.has(dataUrl.mediaType)) return null;

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrl.mediaType as MessagesImageBlock['source']['media_type'],
        data: dataUrl.data,
      },
    };
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
  return await resolveRemoteImage(url, loadRemoteImage);
};

export const fetchRemoteImage = async (url: string): Promise<RemoteImageData | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) return null;

    return {
      mediaType: response.headers.get('content-type'),
      data: new Uint8Array(await response.arrayBuffer()),
    };
  } catch {
    return null;
  }
};
