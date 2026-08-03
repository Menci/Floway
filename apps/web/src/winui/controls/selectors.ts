// Selector shapes the sheets share.

/** Joins selectors into the one list a rule takes. */
export const list = (selectors: readonly string[]) => selectors.join(',\n');

/** Crosses a list of roots with the descendants stated under each of them. */
export const under = (roots: readonly string[], descendants: readonly string[]) => list(
  roots.flatMap(root => descendants.map(descendant => `${root} ${descendant}`)),
);

/**
 * Every selector interpolated into a guard below starts a line, so the indent
 * it would have been written with has to come from here.
 */
export const nested = (selectorList: string) => selectorList
  .split('\n')
  .map(line => `  ${line}`)
  .join('\n');

/**
 * The pressed subject of a control that paints from its root while a nested
 * input owns the activation. Neither element alone sees both presses: Chrome
 * sets :active on the input for a keyboard activation without propagating it
 * to the root, while a pointer capture taken on the root moves the pointer's
 * hover and active chain off the input for the whole gesture. Any rule
 * restating a WinUI pressed value on such a control reads this union; a rule
 * that only neutralises a Fluent atom keeps Fluent's own subject, since that
 * atom stops matching in exactly the same conditions.
 */
export const pressedRoots = (root: string, input: string) => [
  `${root}:active`,
  `${root}:has(${input}:active)`,
];

/**
 * Fluent's disabledFocusable keeps the element enabled to the browser and says
 * so with aria-disabled, so both spellings name the disabled visual.
 */
export const disabledStates = [':disabled', `[aria-disabled='true']`];

/**
 * WinUI's VisualStateManager never leaves Disabled, so no interaction keyframe
 * can run over a disabled control. CSS has no such exclusivity: a pressed
 * selector carries two pseudo-classes where the disabled one carries a single
 * class-level part, so it outranks the disabled rule and source order cannot
 * rescue it. Every interactive state therefore excludes both disabled
 * spellings in the state itself, which keeps the exclusion attached to the
 * state rather than to each rule that happens to notice the collision.
 */
export const notDisabled = disabledStates.map(state => `:not(${state})`).join('');

/**
 * The clamp a sheet states for a motion of its own under the reduced-motion
 * preference. The duration is a token rather than a literal, since the reason
 * it is not zero belongs with the value.
 */
export const reducedMotion = (
  selectors: readonly string[],
  property: 'animation-duration' | 'transition-duration',
  alsoDeclared: readonly string[] = [],
) => `@media (prefers-reduced-motion: reduce) {
${nested(list(selectors))} {
    ${[`${property}: var(--winui-reduced-motion-duration);`, ...alsoDeclared].join('\n    ')}
  }
}`;

/**
 * A subject stated twice, which is how every rule in this layer outranks the
 * single-class atoms Griffel composes: two class-level parts against one, with
 * no id and no important. A subject Fluent gives no class of its own cannot be
 * written this way, and each such rule says so where it departs.
 */
export const doubled = (selector: string) => `${selector}${selector}`;
