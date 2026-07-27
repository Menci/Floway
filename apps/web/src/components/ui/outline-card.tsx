import type { CardProps } from '@fluentui/react-components';

import { fluentComponents } from '../../fluent';

const { Card, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  root: {
    borderRadius: '8px',
    '&::after': {
      borderRadius: '8px',
    },
  },
});

export type OutlineCardProps = Omit<CardProps, 'appearance'>;

export function OutlineCard({ className, ...props }: OutlineCardProps) {
  const styles = useStyles();

  return (
    <Card
      {...props}
      appearance="outline"
      className={mergeClasses(styles.root, className)}
    />
  );
}
