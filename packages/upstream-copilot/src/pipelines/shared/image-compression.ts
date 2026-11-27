import type { CopilotService } from '../../service.ts';
import type { ImageSizeCalculator } from '@floway-dev/platform';
import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from '@floway-dev/upstream';

type CompressImage = CopilotService['compressImage'];

// One compression per distinct source content in this payload avoids racing
// identical platform cache writes when tool results replay a screenshot.
export const compressBase64Images = async (images: Iterable<string>, calculator: ImageSizeCalculator, compress: CompressImage): Promise<Map<string, string>> =>
  new Map(await Promise.all([...new Set(images)].map(async input => [input, bytesToBase64(await compress(base64ToBytes(input), calculator))] as const)));

export const compressDataUrlImages = async (urls: Iterable<string>, calculator: ImageSizeCalculator, compress: CompressImage): Promise<Map<string, string>> => {
  const sources = [...new Set(urls)].flatMap(url => {
    const source = parseBase64ImageDataUrl(url);
    return source === null ? [] : [{ url, base64: source.base64 }];
  });
  const compressed = await compressBase64Images(sources.map(source => source.base64), calculator, compress);
  return new Map(sources.map(({ url, base64 }) => {
    const webp = compressed.get(base64);
    if (webp === undefined) throw new Error('Missing compressed Copilot image');
    return [url, `data:image/webp;base64,${webp}`];
  }));
};
