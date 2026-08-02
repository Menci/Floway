import type { TagProps } from '@fluentui/react-components';
import type { ComponentProps, CSSProperties, ReactElement, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Tag, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // Fluent sizes the chip to its content, so a long label carries the chip
  // past the column that holds it.
  root: { maxWidth: '100%' },
  // Fluent pads the primary text for a secondary line the chip never has; drop
  // the padding but leave the text spanning both grid rows, since confining it
  // to the primary row rides it higher still. `overflow: hidden` also drops the
  // grid item's automatic minimum size, without which the text never shrinks
  // below its content width and the ellipsis has nothing to stand for.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L320-L323
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L337-L341
  text: {
    paddingBottom: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});

// Fluent clones a Tooltip's trigger element, so any prop Chip drops -- the
// ref, the pointer and focus handlers, the aria attribute tying the two
// together -- leaves the tooltip with nothing to open on.
type ChipTriggerProps = Omit<
  ComponentProps<typeof Tag>,
  | 'appearance' | 'children' | 'className' | 'disabled' | 'dismissIcon' | 'dismissible' | 'icon'
  | 'media' | 'primaryText' | 'secondaryText' | 'selected' | 'shape' | 'size' | 'style' | 'value'
>;

export function Chip({ children, className, icon, size = 'small', style, ...trigger }: {
  children: ReactNode;
  className?: string;
  icon?: ReactElement;
  size?: TagProps['size'];
  style?: CSSProperties;
} & ChipTriggerProps) {
  const styles = useStyles();

  return (
    <Tag
      appearance="outline"
      shape="circular"
      size={size}
      className={mergeClasses(styles.root, className)}
      icon={icon}
      primaryText={{ className: styles.text }}
      style={style}
      {...trigger}
    >
      {children}
    </Tag>
  );
}
