// The reveal a popper surface plays as it opens: the surface grows out of a
// band instead of fading in, so a sheet that owns such a surface states its own
// key frames and takes the mechanism and the timing below.
//
// Written as an animation rather than a transition because the element enters
// already in its final state, and on clip-path rather than transform because
// transform is where Fluent's positioning already lives: a surface is placed by
// translating it to the coordinates the positioning engine computed, and a key
// frame naming transform would replace that outright and play the reveal at the
// origin of the containing block.
//
// The direction is carried by custom properties inside one set of key frames
// rather than by two animation names: Fluent's positioning writes
// data-popper-placement a few milliseconds after the element mounts, and
// swapping animation-name once the attribute lands restarts the animation from
// zero, where swapping a custom property leaves it running and recomputes.
// Fluent reached the same conclusion and deprecated its own attribute-keyed
// helper for it. The animation is gated on the attribute existing at all, so an
// unplaced surface does not animate the wrong way and then correct itself --
// the gate Radix puts on its own popper content, for the same reason.

// The edges the reveal does not travel along are clipped outside the border box
// so the surface's own shadow is not cut square while it runs. 32px is headroom
// over what shadow16 needs: a blur spreads a shadow by about its own length
// past the offset edge, so its key term, 0 8px 16px, reaches about 24px below
// the border box and 16px to either side.
// https://www.w3.org/TR/css-backgrounds-3/#shadow-blur
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/tokens/src/utils/shadows.ts#L11
export const REVEAL_HEADROOM = '-32px';

/**
 * The timing every reveal shares and the placement gate that starts it.
 * `properties` are the direction custom properties the surface's own key frames
 * read, declared in the same rule so a surface states its geometry once.
 */
export const revealAnimation = ({ root, keyframes, properties }: {
  root: string;
  keyframes: string;
  properties: readonly string[];
}) => `${root} {
${properties.map(property => `  ${property}`).join('\n')}
  animation-duration: var(--winui-control-normal-animation-duration);
  animation-timing-function: var(--winui-control-fast-out-slow-in-easing);
}

${root}[data-popper-placement] {
  animation-name: ${keyframes};
}`;
