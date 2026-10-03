import { dumpBrokerFrameSchema } from './schemas.ts';
import type { DumpMetadata } from './types.ts';
import type { ChannelCodec } from '@floway-dev/platform';

export const dumpCodec: ChannelCodec<DumpMetadata> = {
  encode: meta => JSON.stringify(dumpBrokerFrameSchema.parse({ event: 'appended', data: meta })),
  decode: text => {
    try {
      return dumpBrokerFrameSchema.parse(JSON.parse(text)).data;
    } catch (cause) {
      const detail = cause instanceof Error ? `: ${cause.message}` : '';
      throw new Error(`Invalid dump broker frame${detail}`, { cause });
    }
  },
};
