import type { TagProps } from '@fluentui/react-components';
import type { ComponentProps, CSSProperties, ReactElement, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Tag, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // Fluent sizes the chip to its content and stops there, so a long label
  // carries the chip past the column that holds it. Bounding the chip at the
  // width it is given is what leaves the label below with room to truncate in.
  root: { maxWidth: '100%' },
  // Fluent pads the primary text for a secondary line that a chip without
  // `secondaryText` never gets, leaving the glyphs a pixel above the chip's
  // centre and visibly out of line with an adjacent icon. Drop the padding
  // but keep the text spanning both grid rows: confined to the primary row
  // alone it rides even higher, because the empty secondary row still takes
  // space.
  //
  // The label truncates inside that bound rather than overflowing it. Fluent
  // already holds it on one line, so `overflow: hidden` is what both clips it
  // and drops the grid item's automatic minimum size -- without that the text
  // would refuse to shrink below its own content width, and an ellipsis would
  // have nothing to stand for.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L320-L323
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L337-L341
  text: {
    paddingBottom: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
});

// What a Tooltip hands its trigger: the ref, the pointer and focus handlers,
// and the aria attribute tying the two together. Chip passes them straight
// through so it can be a trigger itself -- Fluent clones the trigger element,
// and props a component drops leave the tooltip with nothing to open on.
// Everything Tag turns into a variant, a slot or a group membership stays out,
// so what is left is that trigger contract and the plain DOM attributes: the
// chip states one attribute on one line, and the states the withheld props
// would open -- an accent selected fill, a disabled label, a dismiss glyph
// with its own hover and press -- are ones it does not have.
type ChipTriggerProps = Omit<
  ComponentProps<typeof Tag>,
  | 'appearance' | 'children' | 'className' | 'disabled' | 'dismissIcon' | 'dismissible' | 'icon'
  | 'media' | 'primaryText' | 'secondaryText' | 'selected' | 'shape' | 'size' | 'style' | 'value'
>;

// The dashboard's one chip: a read-only Fluent Tag stating an attribute of
// the thing it sits next to. Not dismissible, so Tag renders it as a plain
// span rather than a button.
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
