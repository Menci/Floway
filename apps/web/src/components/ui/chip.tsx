import type { ComponentProps, CSSProperties, ReactElement, ReactNode, Ref } from 'react';

import { fluentComponents } from '../../fluent';

const { Tag, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // Fluent sizes the chip to its content, so a long label carries the chip
  // past the column that holds it.
  root: { maxWidth: '100%' },
  // Clipping removes the grid item's automatic minimum, so the label can
  // shrink below its content width and produce an ellipsis.
  text: {
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

// Fluent's small Tag is 24px high.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L127-L135
export function Chip({ children, className, icon, style, textRef, ...trigger }: {
  children: ReactNode;
  className?: string;
  icon?: ReactElement;
  style?: CSSProperties;
  // The text slot is the box that clips, so it is the one a caller has to
  // reach to measure what the chip shows.
  textRef?: Ref<HTMLSpanElement>;
} & ChipTriggerProps) {
  const styles = useStyles();

  return (
    <Tag
      appearance="outline"
      shape="circular"
      size="small"
      className={mergeClasses(styles.root, className)}
      icon={icon}
      primaryText={{ className: styles.text, ref: textRef }}
      style={style}
      {...trigger}
    >
      {children}
    </Tag>
  );
}
