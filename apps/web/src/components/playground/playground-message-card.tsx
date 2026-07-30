import type { PropsWithChildren } from 'react';

import { bingAccentGradient } from './bing-chat-palette';
import type { PlaygroundMessage } from './playground-logic';
import { fluentComponents } from '../../fluent';

const { Card, makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  user: {
    color: tokens.colorNeutralForegroundOnBrand,
    backgroundImage: bingAccentGradient,
  },
});

type PlaygroundMessageCardProps = PropsWithChildren<{
  role: PlaygroundMessage['role'];
}>;

export function PlaygroundMessageCard({ children, role }: PlaygroundMessageCardProps) {
  const s = useStyles();

  return (
    <Card
      className={`min-w-0 break-words overflow-hidden !rounded-xl after:!rounded-xl ${role === 'user' ? s.user : ''}`}
      size="medium"
    >
      {children}
    </Card>
  );
}
