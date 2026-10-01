import type { GatewayFacts } from '../pipeline/facts.ts';

export type Slice<K extends keyof GatewayFacts> = { [P in K]: GatewayFacts[P] };
