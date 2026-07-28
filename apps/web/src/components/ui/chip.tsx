import type { TagProps } from '@fluentui/react-components';
import type { ReactElement, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Tag, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  root: { maxWidth: '100%' },
  // Fluent pads the primary text for a secondary line that a chip without
  // `secondaryText` never gets, leaving the glyphs a pixel above the chip's
  // centre and visibly out of line with an adjacent icon. Drop the padding
  // but keep the text spanning both grid rows: confined to the primary row
  // alone it rides even higher, because the empty secondary row still takes
  // space.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L1-L40
  text: {
    paddingBottom: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});

// The dashboard's one chip: a read-only Fluent Tag stating an attribute of
// the thing it sits next to. Not dismissible, so Tag renders it as a plain
// span rather than a button.
export function Chip({ children, className, icon, size = 'small', style, textClassName, title }: {
  children: ReactNode;
  className?: string;
  icon?: ReactElement;
  size?: TagProps['size'];
  style?: React.CSSProperties;
  textClassName?: string;
  title?: string;
}) {
  const styles = useStyles();

  return (
    <Tag
      appearance="outline"
      shape="circular"
      size={size}
      className={mergeClasses(styles.root, className)}
      icon={icon}
      primaryText={{ className: mergeClasses(styles.text, textClassName) }}
      style={style}
      title={title}
    >
      {children}
    </Tag>
  );
}
