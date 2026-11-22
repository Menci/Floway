import { dumpBrokerFrameSchema } from './schemas.ts';
import type { DumpBrokerMessage } from './types.ts';
import type { ChannelCodec } from '@floway-dev/platform';

export const dumpCodec: ChannelCodec<DumpBrokerMessage> = {
  encode: frame => JSON.stringify(dumpBrokerFrameSchema.parse(frame)),
  decode: text => {
    try {
      return dumpBrokerFrameSchema.parse(JSON.parse(text));
    } catch (cause) {
      const detail = cause instanceof Error ? `: ${cause.message}` : '';
      throw new Error(`Invalid dump broker frame${detail}`, { cause });
    }
  },
};
