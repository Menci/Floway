import type { TagProps } from '@fluentui/react-components';
import type { ComponentProps, CSSProperties, ReactElement, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { Tag, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // Fluent sizes the chip to its content and stops there, so a long label
  // carries the chip past the column that holds it.
  root: { maxWidth: '100%' },
  // Fluent pads the primary text for a secondary line a chip without
  // `secondaryText` never gets, leaving the glyphs a pixel above centre. Drop
  // the padding but keep the text spanning both grid rows: confined to the
  // primary row alone it rides higher still, because the empty secondary row
  // takes space regardless. `overflow: hidden` also drops the grid item's
  // automatic minimum size -- without it the text refuses to shrink below its
  // content width and the ellipsis has nothing to stand for.
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
// because those open states the chip does not have.
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
