import type { CopilotService } from '../../service.ts';
import type { ImageSizeCalculator } from '@floway-dev/platform';
import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from '@floway-dev/provider';

export const compressBase64ImageToWebp = async (
  compress: CopilotService['compressImage'],
  base64: string,
  calculator: ImageSizeCalculator,
): Promise<string> => {
  const webp = await compress(base64ToBytes(base64), calculator);
  return bytesToBase64(webp);
};

// Recompresses a `data:image/*;base64,...` URL to a WebP data URL. Returns the
// original URL unchanged when it is not a base64 image data URL (e.g. a remote
// https image reference, which the egress forwards as-is).
export const compressImageDataUrlToWebp = async (
  compress: CopilotService['compressImage'],
  url: string,
  calculator: ImageSizeCalculator,
): Promise<string> => {
  const parsed = parseBase64ImageDataUrl(url);
  if (parsed === null) return url;
  const webp = await compressBase64ImageToWebp(compress, parsed.base64, calculator);
  return `data:image/webp;base64,${webp}`;
};
