// Use `export type *` for types: these exports are erased at runtime.
// Export runtime functions, classes, and constants individually by name.
// Never use `export *` here: new source exports would silently expand
// the browser runtime API without an explicit review.

export type * from './ingress-header-rules.ts';

export { customIngressHeaderNameIssue, isCustomIngressHeaderValue } from './ingress-header-rules.ts';
