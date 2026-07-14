import { dimensionsFromBytes, getImageProcessor } from '@floway-dev/platform';

export interface ImageEditSource {
  bytes: ArrayBuffer;
  mimeType: string;
}

export type ImageEditMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface PreparedImageEditSource extends ImageEditSource {
  mimeType: ImageEditMime;
}

const EDIT_MIME_ALIASES: Record<string, ImageEditMime> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

export const editSupportedMime = (mime: string): ImageEditMime | null => {
  const canonical = EDIT_MIME_ALIASES[mime] ?? mime;
  return canonical === 'image/png' || canonical === 'image/jpeg' || canonical === 'image/webp'
    ? canonical
    : null;
};

export const supportedImageMimeFromBytes = (bytes: Uint8Array): string | null => {
  if (dimensionsFromBytes(bytes) === null) return null;
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
};

export const prepareImageEditSources = async (sources: readonly ImageEditSource[]): Promise<readonly PreparedImageEditSource[]> => {
  const keyBySource = new Map<ImageEditSource, Promise<string>>();
  const preparedByContent = new Map<string, Promise<PreparedImageEditSource>>();
  return await Promise.all(sources.map(async source => {
    const mimeType = editSupportedMime(source.mimeType);
    if (mimeType !== null) return { bytes: source.bytes, mimeType };

    let keyPromise = keyBySource.get(source);
    if (keyPromise === undefined) {
      keyPromise = crypto.subtle.digest('SHA-256', source.bytes).then(buffer => {
        const digest = [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return `${source.mimeType}\u0000${digest}`;
      });
      keyBySource.set(source, keyPromise);
    }
    const key = await keyPromise;

    let prepared = preparedByContent.get(key);
    if (prepared === undefined) {
      // The standalone edits endpoint accepts PNG/JPEG/WebP, so encode other
      // raster formats before dispatch.
      // https://github.com/openai/openai-node/blob/ec2f57fd0d66e94782656b986d7b3eb03225369c/src/resources/images.ts#L560-L572
      prepared = getImageProcessor().compressToWebp(new Uint8Array(source.bytes), null).then(encoded => {
        const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
        return { bytes, mimeType: 'image/webp' } satisfies PreparedImageEditSource;
      });
      preparedByContent.set(key, prepared);
    }
    return await prepared;
  }));
};
