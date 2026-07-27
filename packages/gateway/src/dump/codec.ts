import type { DumpMetadata } from './types.ts';
import type { ChannelCodec } from '@floway-dev/platform';

const APPENDED_EVENT = 'appended';

interface AppendedFrame {
  event: typeof APPENDED_EVENT;
  data: DumpMetadata;
}

export const dumpCodec: ChannelCodec<DumpMetadata> = {
  encode: meta => JSON.stringify({ event: APPENDED_EVENT, data: meta } satisfies AppendedFrame),
  decode: text => {
    const parsed = JSON.parse(text) as { event: unknown; data: unknown };
    if (parsed.event !== APPENDED_EVENT) {
      throw new Error(`dump broker frame had unexpected event ${String(parsed.event)}`);
    }
    return parsed.data as DumpMetadata;
  },
};
