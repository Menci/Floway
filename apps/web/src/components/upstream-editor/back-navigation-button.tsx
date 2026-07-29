import { ArrowLeftRegular } from '@fluentui/react-icons';
import type { ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Button, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  root: {
    backgroundColor: 'transparent !important',
    color: 'var(--colorNeutralForeground1) !important',
    '&:hover': {
      backgroundColor: 'transparent !important',
      color: 'var(--colorCompoundBrandForeground1Hover) !important',
    },
    '&:active': {
      backgroundColor: 'transparent !important',
      color: 'var(--colorCompoundBrandForeground1Pressed) !important',
    },
  },
});

export function BackNavigationButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  const styles = useStyles();
  return <Button appearance="transparent" className={styles.root} icon={<ArrowLeftRegular />} onClick={onClick}>{children}</Button>;
}
