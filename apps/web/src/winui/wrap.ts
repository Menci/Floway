// Every substitution this layer makes is the same shape: take a Fluent
// component, rewrite the props on their way in, forward the ref, and hand back
// something the original's type still describes. Fluent exports its components
// as opaque function types rather than element types, so a wrapper costs one
// cast inward and one outward; both live here so no wrapper restates them.
import * as React from 'react';

export type FluentComponents = typeof import('@fluentui/react-components');

export type PropCarrier = Record<string, unknown>;

export const wrapFluent = <Component, Props extends object = PropCarrier>(
  component: Component,
  mapProps: (props: Props) => object,
): Component => {
  const elementType = component as React.ElementType;

  const wrapped = React.forwardRef<unknown, Props>((props, ref) =>
    React.createElement(elementType, { ...mapProps(props), ref }));

  wrapped.displayName = (component as { displayName?: string }).displayName;

  return wrapped as Component;
};
