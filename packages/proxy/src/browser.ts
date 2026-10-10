// We let types follow their source modules, but enumerate runtime exports so
// adding a source export cannot implicitly expand the browser runtime API.

export type * from './constants.ts';

export { DEFAULT_DIAL_DEADLINE_MS } from './constants.ts';

export type * from './url.ts';

export { parseProxyUri, formatProxyUri } from './url.ts';

export type * from './url-kind.ts';

export { kindFromUri } from './url-kind.ts';

export type * from './proxy-config.ts';
