// We let types follow their source modules, but enumerate runtime exports so
// adding a source export cannot implicitly expand the browser runtime API.

export type * from './ingress-header-rules.ts';

export { customIngressHeaderNameIssue, isCustomIngressHeaderValue } from './ingress-header-rules.ts';
