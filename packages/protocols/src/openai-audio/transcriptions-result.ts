import { isJsonMediaType } from '../common/media-type.ts';
import type { Result } from '@floway-dev/pipeline';

export const decodeOpenAIAudioTranscriptionsResult = <Buffer extends ArrayBufferLike>(
  bytes: Uint8Array<Buffer>,
  mediaType: string | null | undefined,
): Result<Uint8Array<Buffer>, SyntaxError> => {
  if (isJsonMediaType(mediaType)) {
    const text = new TextDecoder().decode(bytes);
    try {
      JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { ok: false, error };
    }
  }
  return { ok: true, value: bytes };
};
