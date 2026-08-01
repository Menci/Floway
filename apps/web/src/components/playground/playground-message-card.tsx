import type { PropsWithChildren } from 'react';

import { bingAccentGradient, bingCardShadow, bingOnAccentForeground } from './bing-chat-tokens';
import type { PlaygroundMessage } from './playground-logic';
import { fluentComponents } from '../../fluent';

const { Card, makeStyles } = fluentComponents;

// A transcript bubble is Bing's `.text-message`: one surface with a corner, a
// shadow and -- for the user's half -- the accent gradient and its white
// foreground. The transcript sits inside the layer's
// `data-winui-card-restyle='off'` subtree, so the WinUI card values are out of
// the way and what this Fluent Card paints is Fluent's own, which is why every
// trait Bing states differently is restated here.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L580-L594
//
// The Card is given no click, selection or focus behaviour, so Fluent adds
// none of its interactive, selected, disabled or forced-colors-interactive
// classes and the surface has exactly one paint per colour scheme. Bing agrees:
// `.text-message` states no pointer, selected or disabled counterpart -- what
// its `:hover` reveals is the feedback bar floating above the bubble, not a
// repaint of the bubble.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L714-L718
//
// `--cib-shadow-elevation-4`, the user bubble's shadow. In light it is the same
// two layers as the card shadow beside it; in dark the two part company -- the
// card shadow becomes a 1px white ring and this stays a drop shadow, which is
// what a saturated bubble on a dark page wants. Both themes are written out
// with the layers that do not apply made transparent, because `light-dark()`
// takes only colours.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L178-L179
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L155
const bingElevation4 = [
  '0px 0.3px 0.9px light-dark(rgba(0, 0, 0, 0.12), transparent)',
  '0px 1.6px 3.6px light-dark(rgba(0, 0, 0, 0.16), transparent)',
  '0px 2px 4px light-dark(transparent, rgba(0, 0, 0, 0.28))',
  '0px 0px 2px light-dark(transparent, rgba(0, 0, 0, 0.24))',
].join(', ');

// The two halves are exclusive so that one class carries the shadow and the
// merge Fluent performs on `className` is what displaces its own `shadow4`.
// The assistant half keeps Fluent's neutral surface and foreground: the
// dashboard's page is opaque where Bing's was a photograph under a translucent
// card, so only the edge is Bing's here.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L617-L624
const useStyles = makeStyles({
  assistant: {
    boxShadow: bingCardShadow,
  },
  user: {
    color: bingOnAccentForeground,
    backgroundImage: bingAccentGradient,
    boxShadow: bingElevation4,
  },
});

type PlaygroundMessageCardProps = PropsWithChildren<{
  role: PlaygroundMessage['role'];
}>;

export function PlaygroundMessageCard({ children, role }: PlaygroundMessageCardProps) {
  const s = useStyles();

  // `--cib-border-radius-extra-large`, stated as the pixel constant it is: a
  // rem step would move with the root size, which the corner of a bubble does
  // not. Both the box and the `::after` Fluent draws its border on take it, and
  // both need the important flag to outrank the layer's doubled-class rule.
  // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L192
  return (
    <Card
      className={`min-w-0 break-words overflow-hidden !rounded-[12px] after:!rounded-[12px] ${role === 'user' ? s.user : s.assistant}`}
      size="medium"
    >
      {children}
    </Card>
  );
}
