import type { ReactNode } from 'react';

import { TIGHT_STACK_CLASS } from './layout';
import { fluentComponents } from '../../fluent';

const { Text } = fluentComponents;

// The row a header shares with its own actions. WinUI's `PART_ContentPresenter`
// is a bare presenter with no panel or spacing opinion, so both the 12px and
// the width at which the actions drop under the title are ours.
const HEADER_ROW_CLASS = 'flex items-center justify-between gap-3 min-w-0 max-[900px]:flex-col max-[900px]:items-stretch';

// Level 4 is WinUI's own section heading — BodyStrong, 14px SemiBold, per
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Samples/ControlPagesSampleCode/SettingsCard/SettingsPageExample.xaml#L17-L24
// — and the 12px description at the secondary foreground is `SettingsCard`'s,
// per
// https://github.com/CommunityToolkit/Windows/blob/c076d3dd722e43204ffbeb16057090f8498c8166/components/SettingsControls/src/SettingsCard/SettingsCard.xaml#L102
// and #L427-L432. WinUI runs one section-heading size; we run three depths, so
// the 20px and 16px above it are ours.
const TITLE_SIZE = { 2: 500, 3: 400, 4: 300 } as const;

export function SectionHeader({ actions, description, level, title, titleId, truncate = false }: {
  actions?: ReactNode;
  description?: ReactNode;
  level: 2 | 3 | 4;
  title: ReactNode;
  titleId?: string;
  truncate?: boolean;
}) {
  const heading = <Text
    as={(`h${level}`) as 'h2'}
    className={description === undefined ? 'm-0 min-w-0' : 'm-0'}
    id={titleId}
    size={TITLE_SIZE[level]}
    truncate={truncate}
    weight="semibold"
  >{title}</Text>;

  const block = description === undefined
    ? heading
    : <div className={`${TIGHT_STACK_CLASS} min-w-0`}>
        {heading}
        <Text className="text-fui-fg2" size={200}>{description}</Text>
      </div>;

  if (actions === undefined) return block;
  return <div className={HEADER_ROW_CLASS}>{block}{actions}</div>;
}
