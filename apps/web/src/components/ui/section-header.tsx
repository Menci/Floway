import type { ReactNode } from 'react';

import { HEADER_ROW_CLASS, TIGHT_STACK_CLASS } from './layout';
import { fluentComponents } from '../../fluent';

const { Text, mergeClasses } = fluentComponents;

// Level 2 is WinUI's Subtitle (20px), level 4 its BodyStrong (14px, the WinUI
// Gallery settings section heading); level 3's 16px is ours, as WinUI steps
// 14 → 18 → 20 with nothing between Body and Subtitle.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L3-L9
// (sizes), #L10-L18 (shared SemiBold), #L26 (BodyStrong), #L36-L38 (Subtitle)
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Pages/SettingsPage.xaml#L13-L17
// The 12px secondary-foreground description is SettingsCard's:
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L102
// and #L421-L424
const TITLE_SIZE = { 2: 500, 3: 400, 4: 300 } as const;

export function SectionHeader({ actions, description, level, title, titleId, truncate = false }: {
  actions?: ReactNode;
  description?: ReactNode;
  level: 2 | 3 | 4;
  title: ReactNode;
  titleId?: string;
  truncate?: boolean;
}) {
  // Fluent's `truncate` contributes the ellipsis alone; the clip and the single
  // line come from `wrap={false}`, so a title that trims needs both.
  const heading = <Text
    as={(`h${level}`) as 'h2'}
    className={description === undefined ? 'm-0 min-w-0' : 'm-0'}
    id={titleId}
    size={TITLE_SIZE[level]}
    truncate={truncate}
    weight="semibold"
    wrap={!truncate}
  >{title}</Text>;

  const block = description === undefined
    ? heading
    : <div className={mergeClasses(TIGHT_STACK_CLASS, 'min-w-0')}>
        {heading}
        <Text className="text-fui-fg2" size={200}>{description}</Text>
      </div>;

  if (actions === undefined) return block;
  return <div className={mergeClasses(HEADER_ROW_CLASS, 'gap-3')}>
    {block}
    <div className="flex items-center gap-2 flex-none">{actions}</div>
  </div>;
}
