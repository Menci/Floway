import type { DumpMetadata } from './types.ts';
import type { ChannelBroker } from '@floway-dev/platform';

export type DumpBroker = ChannelBroker<DumpMetadata>;

export const DUMP_DISABLED_REASON = 'dump retention disabled';
