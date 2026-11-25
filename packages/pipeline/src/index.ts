import { composeFor, composeGroupFor } from './compose.ts';
import { defineStageFor } from './stage.ts';

export type { Pipeline } from './compose.ts';
export type { RunEvent } from './events.ts';
export { run } from './run.ts';
export { Secret } from './secret.ts';
export { transform } from './stage.ts';
export type { Deferred, Facts, ManagedStream, Result } from './values.ts';

export const factSpace = <Space, Services = {}>() => Object.freeze({
  defineStage: defineStageFor<Space, Services>(),
  compose: composeFor<Space, Services>(),
  composeGroup: composeGroupFor<Space, Services>(),
});
