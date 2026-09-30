import type { GatewayFacts } from './facts.ts';

export type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };
