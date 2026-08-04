import type { ComponentProps, CSSProperties, ReactElement, ReactNode, Ref } from 'react';

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

// Fluent's `small` is the 24px step, which every badge in the dashboard stands
// on -- `StatusBadge` reaches the same height through Badge's `large`.
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
