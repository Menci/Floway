import type { IRProjectedContent as IRContent, IRStringProjection as IRProjection } from './projection.ts';

export interface IRStringProjection extends IRProjection { round_trip: boolean }
export interface IRProjectedContent extends IRContent { round_trip: boolean }
export interface IRProjectionResult { contents: IRProjectedContent[]; projections: IRStringProjection[] }
