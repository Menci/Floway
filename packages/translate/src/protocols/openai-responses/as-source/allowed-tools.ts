import { TranslateInputException } from '../../../types.ts';

/**
 * The callable a selector names.
 *
 * `allowed_tools.tools` is the wire's own `Record<string, unknown>` array, so
 * this is where a member becomes a typed selector. A member that carries
 * anything beyond the three fields a selector may state is not one.
 */
export const requireCallableSelector = (selector: unknown): { readonly type: 'function' | 'custom'; readonly name: string; readonly namespace?: string } => {
  if (typeof selector !== 'object' || selector === null
    || ((selector as { type?: unknown }).type !== 'function' && (selector as { type?: unknown }).type !== 'custom')
    || typeof (selector as { name?: unknown }).name !== 'string'
    || ('namespace' in selector && selector.namespace !== undefined && typeof selector.namespace !== 'string')
    || Object.keys(selector).some(key => key !== 'type' && key !== 'name' && key !== 'namespace')) {
    throw new TranslateInputException('Cannot translate an allowed_tools selector that is not a function or custom tool.');
  }
  return selector as { readonly type: 'function' | 'custom'; readonly name: string; readonly namespace?: string };
};
