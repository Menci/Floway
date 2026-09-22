import type { ReactNode } from 'react';

import { useBadgeHue, type BadgeHue } from './badge-hue';
import { fluentComponents } from '../../fluent';

const { Badge, makeStyles, mergeClasses } = fluentComponents;

export type BadgeTone = 'accent' | 'danger' | 'neutral' | 'success' | 'warning';

// Every badge in the dashboard is painted by one algorithm: the hue washes the
// surface at a tenth, outlines it at a bit over a third, and the label is solved
// against that wash for 4.5:1 rather than picked. Fluent instead ships a literal
// per severity per scheme, which is what let the method chips, the role pills
// and the proxy chips give three different answers to the same question.
//
// The hues are WinUI's own semantic fills, which the dictionaries state twice
// because a colour that carries a meaning against white does not carry it
// against black. Neutral has no system fill to take, so it is a mid grey: the
// wash and the outline need a hue with no meaning of its own, and the label is
// solved from it like any other.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L220-L231
const TONE_HUES: Record<BadgeTone, BadgeHue> = {
  accent: { light: '#0078d4', dark: '#4cc2ff' },
  danger: { light: '#c42b1c', dark: '#ff99a4' },
  neutral: { light: '#8a8a8a', dark: '#9a9a9a' },
  success: { light: '#0f7b0f', dark: '#6ccb5f' },
  warning: { light: '#9d5d00', dark: '#fce100' },
};

/** Fluent's private `tagSpacingSmall`, which is what ./chip.tsx's `small` step pads its root by.
 * https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L23
 * https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L185-L187
 * https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L199-L201 */
const CHIP_ROOT_PADDING = '5px';

// The dashboard has two badge shapes -- this one and ./chip.tsx -- and a label
// has to sit the same distance inside either. The chip reaches its inset in
// three parts: a real 1px border, the root padding above, and
// spacingHorizontalXXS on the label slot. Badge draws its stroke as an inset
// ::after so that a border costs no layout, which leaves padding as the whole
// inset -- and Fluent's large step, spacingHorizontalXS plus the same XXS it
// calls textPadding, lands two pixels short of the chip.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L46
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tags/library/src/components/Tag/useTagStyles.styles.ts#L320-L325
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-badge/library/src/components/Badge/useBadgeStyles.styles.ts#L14-L16
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-badge/library/src/components/Badge/useBadgeStyles.styles.ts#L77-L81
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-badge/library/src/components/Badge/useBadgeStyles.styles.ts#L99-L101
const LABEL_INSET = `calc(var(--strokeWidthThin) + ${CHIP_ROOT_PADDING} + var(--spacingHorizontalXXS))`;

const useStyles = makeStyles({
  root: {
    paddingLeft: LABEL_INSET,
    paddingRight: LABEL_INSET,
  },
});

/** Fluent's `medium` default has an empty size rule, leaving the 20px root reset box, so every dashboard badge is `large`. */
export function StatusBadge({ children, className, tone }: {
  children: ReactNode;
  className?: string;
  tone: BadgeTone;
}) {
  const hue = useBadgeHue(TONE_HUES[tone]);
  const styles = useStyles();
  return <Badge appearance="tint" className={mergeClasses(styles.root, hue.className, className)} size="large" style={hue.style}>{children}</Badge>;
}
