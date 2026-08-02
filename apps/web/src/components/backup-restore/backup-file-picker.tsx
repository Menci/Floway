import type { DragEventHandler, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { TIGHT_STACK_CLASS } from '../ui/layout';

const { Text, makeStyles, mergeClasses } = fluentComponents;

// The region a backup file is handed over in.
//
// Neither microsoft-ui-xaml nor the Community Toolkit ships a file drop target:
// no control, no brush, no corner radius, and the only drag affordance either
// states is the 0.80 opacity a ListViewItem takes while it is the thing being
// dragged. So nothing here transcribes a drop zone -- what it transcribes is a
// bounded region inside a panel, which ../ui/code-block.tsx already had to
// answer, and its answer is taken whole: the page-canvas step of the solid
// ramp, framed in ControlStrokeColorDefault at the control radius. The Card
// brushes are not used, for the reason that file states -- they are washes for
// Mica, and on a panel the fill disappears in light while the stroke
// disappears in dark.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L68
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L39
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5
//
// The height the empty region stands at is ours. A drop target has to be large
// enough to aim a file at, and no dictionary has an opinion about how large
// that is.
const useStyles = makeStyles({
  region: {
    backgroundColor: 'var(--winui-solid-background-fill-tertiary)',
    border: '1px solid var(--winui-control-stroke-default)',
    borderRadius: 'var(--winui-control-corner-radius)',
    boxSizing: 'border-box',
    padding: '16px',
  },
  // Empty, the region is the picker, so it takes SubtleButtonStyle's ramp: the
  // transparent fill it already shows through, the secondary and tertiary
  // subtle washes under the pointer and the press, and the drop to the
  // secondary text fill while pressed. Those washes are translucent, so they
  // composite over the region's own fill rather than replacing it.
  //
  // WinUI wires its brush transitions only while UISettings.AnimationsEnabled
  // is on, which the web states as prefers-reduced-motion.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L297-L303
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L17-L28
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/core/elements/panel.cpp#L68-L76
  picker: {
    alignItems: 'center',
    color: 'var(--winui-text-fill-primary)',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    font: 'inherit',
    gap: '8px',
    justifyContent: 'center',
    minHeight: '108px',
    textAlign: 'center',
    transitionDuration: 'var(--winui-control-faster-animation-duration)',
    transitionProperty: 'background-color, color',
    transitionTimingFunction: 'var(--winui-control-fast-out-slow-in-easing)',
    width: '100%',
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
    ':hover': { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
    ':active': {
      backgroundColor: 'var(--winui-subtle-fill-tertiary)',
      color: 'var(--winui-text-fill-secondary)',
    },
    // The system focus visual: a 2px FocusStrokeColorOuter ring with a 1px
    // FocusStrokeColorInner ring immediately inside it, around a rect that
    // FocusVisualMargin -3 grows three pixels past the control bounds. An
    // outline offset by one carries the outer ring and a 1px spread shadow
    // carries the inner one. A forced palette drops the shadow and repaints the
    // outline in a system colour, the same single-ring reduction the rest of
    // the layer takes.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L22-L25
    // https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
    ':focus-visible': {
      boxShadow: '0 0 0 1px var(--winui-focus-stroke-inner)',
      outlineColor: 'var(--winui-focus-stroke-outer)',
      outlineOffset: '1px',
      outlineStyle: 'solid',
      outlineWidth: '2px',
    },
  },
  // A file dragged over the region is the same proposition the pointer makes
  // when it rests on it, and during a drag the user agent matches `:hover` on
  // nothing at all -- so the accepting state asserts the wash the pointer would
  // have drawn rather than acquiring a colour of its own.
  // https://html.spec.whatwg.org/multipage/dnd.html#drag-and-drop-processing-model
  accepting: { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
});

/** The handlers that make a region accept a file as well as ask for one. */
export interface FileDropHandlers {
  onDragLeave: DragEventHandler;
  onDragOver: DragEventHandler;
  onDrop: DragEventHandler;
}

// Empty, the region asks for a file and takes one either way it is offered.
export function BackupFilePicker({ accepting, drop, glyph, onClick, prompt }: {
  accepting: boolean;
  drop: FileDropHandlers;
  glyph: ReactNode;
  onClick: () => void;
  prompt: string;
}) {
  const styles = useStyles();
  return <button
    className={mergeClasses(styles.region, styles.picker, accepting && styles.accepting)}
    onClick={onClick}
    type="button"
    {...drop}
  >
    {glyph}
    <Text>{prompt}</Text>
  </button>;
}

// Filled, the region reports which file it is holding and keeps accepting a
// replacement, with the command that asks for one at its trailing edge.
export function BackupFileSummary({ accepting, action, drop, name }: {
  accepting: boolean;
  action: ReactNode;
  drop: FileDropHandlers;
  name: string;
}) {
  const styles = useStyles();
  return <div
    className={mergeClasses(styles.region, accepting && styles.accepting, 'flex items-center gap-3 flex-wrap')}
    {...drop}
  >
    <Text className="min-w-0 flex-1">{name}</Text>
    {action}
  </div>;
}

// What the file carries, one readout per entity.
//
// Windows ships no stat, metric or readout control -- InfoBadge is the nearest
// thing and it is a dismissible notification, eleven pixels of type in a pill
// that never exceeds sixteen. So the figure is not enlarged: the two steps here
// are the ones the Gallery's own tiles pair, the body strong line over the
// caption in the secondary fill, four apart. Where Windows does read a count
// out beside its name -- "N Views", "N Likes" -- it sets both at the caption
// and spends no size contrast at all, so a larger number would be ours alone.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Controls/HomePage/Tile.xaml#L69-L82
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L19-L26
//
// The name sits above the figure rather than under it, which is the order the
// Gallery's own properties pane reads a value out in. That pane sets its label
// at the caption and leaves the value at the body step; the strong step comes
// from the tile above, because on this page the figure is what is being read
// and the name only says which figure it is.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Samples/Iconography/IconographyPage.xaml#L131-L231
//
// Eight between one readout and the next: the step Windows names for the space
// between two controls, and the one the Gallery gives its own repeaters.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Samples/Spacing/SpacingPage.xaml#L137-L180
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Samples/Iconography/IconographyPage.xaml#L124-L127
//
// Every entity is listed, zeros included. Windows clears a badge at zero, but
// that is a rule about un-actioned notifications; a readout of what a file
// holds has to be able to answer that it holds none of something, and a row
// whose meaning turned on absence would answer nothing. The column counts are
// ours, chosen so the row divides evenly at each width rather than leaving one
// readout standing alone.
// https://learn.microsoft.com/en-us/windows/apps/develop/notifications/badges
export function BackupFileStats({ items }: {
  items: { key: string; label: string; value: string }[];
}) {
  return <dl className="m-0 grid gap-2 grid-cols-7 max-[900px]:grid-cols-4 max-[560px]:grid-cols-2">
    {items.map(item => <div className={mergeClasses(TIGHT_STACK_CLASS, 'min-w-0')} key={item.key}>
      <dt><Text size={200} className="text-fui-fg2">{item.label}</Text></dt>
      <dd className="m-0"><Text size={300} weight="semibold">{item.value}</Text></dd>
    </div>)}
  </dl>;
}
