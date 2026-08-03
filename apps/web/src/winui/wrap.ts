// Every substitution this layer makes is the same shape: take a Fluent
// component, rewrite the props on their way in, and hand back something the
// original's type still describes. Fluent exports its components as opaque
// function types rather than element types, so a wrapper costs one cast inward
// and one outward; both live here so no wrapper restates them.
//
// The ref rides in the props, which is what React hands a function component
// and what Fluent's own forwardRef components read on the way out, so a mapper
// that spreads its props forwards the ref by doing nothing.
// https://github.com/facebook/react/blob/v19.2.0/packages/react-reconciler/src/ReactChildFiber.js#L287-L294
import * as React from 'react';

export type FluentComponents = typeof import('@fluentui/react-components');

export type PropCarrier = Record<string, unknown>;

export const wrapFluent = <Component, Props extends object = PropCarrier>(
  component: Component,
  mapProps: (props: Props) => object,
): Component => {
  const elementType = component as React.ElementType;

  const wrapped = (props: Props) => React.createElement(elementType, mapProps(props));

  return Object.assign(wrapped, {
    displayName: (component as { displayName?: string }).displayName,
  }) as Component;
};
