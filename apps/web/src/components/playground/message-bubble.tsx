import type { PropsWithChildren } from 'react';

import { bingAccentGradient, bingCardShadow, bingElevation4, bingMessageRadius, bingOnAccentForeground } from './bing-chat-tokens';
import type { PlaygroundMessage } from './request';
import { fluentComponents } from '../../fluent';

const { makeStyles, tokens } = fluentComponents;

// Bing's `.text-message` and its user half, built as an element of this app's
// own rather than as a restyled Fluent surface.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L580-L594
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L617-L624
const useStyles = makeStyles({
  bubble: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    // Bing insets `.text-message-content` by 10/16/4/16 against its 24px line;
    // the dashboard's line is 20px and the bubble carries one uniform spacing
    // step instead, the way every other surface here is inset.
    // https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L720-L731
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalM,
    borderRadius: bingMessageRadius,
    // The corner has to clip: a code block or table inside the bubble paints its
    // own edge out to the bubble's own.
    overflow: 'hidden',
    overflowWrap: 'break-word',
    // The edge is the shadow, and the transparent outline beside it is the edge
    // in forced colors, where the shadow is gone and `outline-color` is
    // force-adjusted:
    // https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
    outline: '1px solid transparent',
    // Both halves stand on the neutral surface, the user half with its gradient
    // over it: an antialiased corner blends the fill with whatever is behind it,
    // and behind a bubble is the transcript's own scrolling background.
    backgroundColor: tokens.colorNeutralBackground1,
  },
  // The assistant half keeps the dashboard's neutral surface: the page here is
  // opaque where Bing's was a photograph under a translucent card.
  assistant: bingCardShadow,
  user: {
    color: bingOnAccentForeground,
    backgroundImage: bingAccentGradient,
    ...bingElevation4,
  },
});

type PlaygroundMessageBubbleProps = PropsWithChildren<{
  role: PlaygroundMessage['role'];
}>;

export function PlaygroundMessageBubble({ children, role }: PlaygroundMessageBubbleProps) {
  const s = useStyles();

  return (
    <div className={`${s.bubble} ${role === 'user' ? s.user : s.assistant}`}>
      {children}
    </div>
  );
}
