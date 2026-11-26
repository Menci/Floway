import { composeFor } from './compose.ts';
import { defineStageFor } from './stage.ts';

export { asEntry } from './compose.ts';
export type { Entry, Pipeline } from './compose.ts';
export { run } from './run.ts';
export { secret } from './secret.ts';
export type { Secret } from './secret.ts';
export { transform } from './stage.ts';
export type { Deferred, Facts, ManagedStream, Result } from './values.ts';

export const factSpace = <Request extends object, Response extends object, Services extends object = object>() => Object.freeze({
  defineStage: defineStageFor<Request, Response, Services>(),
  compose: composeFor<Request, Response, Services>(),
});
