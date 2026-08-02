import type { PropsWithChildren } from 'react';

import { bingAccentGradient, bingCardShadow, bingOnAccentForeground } from './bing-chat-tokens';
import type { PlaygroundMessage } from './request';
import { fluentComponents } from '../../fluent';

const { Card, makeStyles } = fluentComponents;

// A transcript bubble is Bing's `.text-message`, and it sits inside the layer's
// `data-winui-card-restyle='off'` subtree, so every trait Bing states
// differently is restated here.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L580-L594
//
// `--cib-shadow-elevation-4`. The layers that do not apply to a theme are
// written out transparent so `light-dark()` takes only colours.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L178-L179
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L155
const bingElevation4 = [
  '0px 0.3px 0.9px light-dark(rgba(0, 0, 0, 0.12), transparent)',
  '0px 1.6px 3.6px light-dark(rgba(0, 0, 0, 0.16), transparent)',
  '0px 2px 4px light-dark(transparent, rgba(0, 0, 0, 0.28))',
  '0px 0px 2px light-dark(transparent, rgba(0, 0, 0, 0.24))',
].join(', ');

// The halves are exclusive so that a single class carries the shadow and
// Fluent's own `shadow4` is displaced by the `className` merge. The assistant
// half keeps Fluent's neutral surface: the dashboard's page is opaque where
// Bing's was a photograph under a translucent card.
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

  // `--cib-border-radius-extra-large` as a pixel constant, since a rem step
  // would move with the root size. The `::after` Fluent draws its border on
  // needs it too, and both need to outrank the layer's doubled-class rule.
  // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L192
  return (
    <Card
      className={`min-w-0 break-words overflow-hidden !rounded-[12px] after:!rounded-[12px] ${role === 'user' ? s.user : s.assistant}`}
    >
      {children}
    </Card>
  );
}
