import type { DumpBrokerMessage } from './types.ts';
import type { ChannelBroker } from '@floway-dev/platform';

export type DumpBroker = ChannelBroker<DumpBrokerMessage>;

export const DUMP_DISABLED_REASON = 'dump retention disabled';
