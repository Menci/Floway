import type { DragEventHandler, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';
import { TIGHT_STACK_CLASS } from '../ui/layout';

const { Text, makeStyles, mergeClasses } = fluentComponents;

// WinUI ships no file drop target, so this is ../ui/code-block.tsx's bounded
// panel region instead: page-canvas step of the solid ramp, framed in
// ControlStrokeColorDefault at the control radius. Not the Card brushes -- they
// are washes for Mica, and on a panel the fill disappears in light while the
// stroke disappears in dark.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L68
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L39
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5
const useStyles = makeStyles({
  region: {
    backgroundColor: 'var(--winui-solid-background-fill-tertiary)',
    border: '1px solid var(--winui-control-stroke-default)',
    borderRadius: 'var(--winui-control-corner-radius)',
    boxSizing: 'border-box',
    padding: '16px',
  },
  // Empty, the region is the picker, so it takes SubtleButtonStyle's ramp. WinUI
  // wires its brush transitions only while UISettings.AnimationsEnabled is on,
  // which the web states as prefers-reduced-motion.
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
    // The system focus visual is two rings: the outline carries the 2px
    // FocusStrokeColorOuter one, a 1px spread shadow the inner one.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
    ':focus-visible': {
      boxShadow: '0 0 0 1px var(--winui-focus-stroke-inner)',
      outlineColor: 'var(--winui-focus-stroke-outer)',
      outlineOffset: '1px',
      outlineStyle: 'solid',
      outlineWidth: '2px',
    },
  },
  // During a drag the user agent matches :hover on nothing at all, so the
  // accepting state has to assert the wash the pointer would have drawn.
  // https://html.spec.whatwg.org/multipage/dnd.html#drag-and-drop-processing-model
  accepting: { backgroundColor: 'var(--winui-subtle-fill-secondary)' },
});

export interface FileDropHandlers {
  onDragLeave: DragEventHandler;
  onDragOver: DragEventHandler;
  onDrop: DragEventHandler;
}

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

// Windows ships no stat or readout control, so the two type steps are the ones
// the Gallery's own tiles pair: body strong over caption in the secondary fill.
// The figure is not enlarged beyond that.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Controls/HomePage/Tile.xaml#L69-L82
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBlock_themeresources.xaml#L19-L26
//
// Name above figure is the order the Gallery's properties pane reads a value
// out in; the strong step lands on the figure because that is what is read.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Samples/Iconography/IconographyPage.xaml#L131-L231
//
// Eight between one readout and the next: the step Windows names for the space
// between two controls.
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Samples/Spacing/SpacingPage.xaml#L137-L180
// https://github.com/microsoft/WinUI-Gallery/blob/f4dc3eb367f4bcecac1793829d9a221e924e5bfb/WinUIGallery/Samples/Iconography/IconographyPage.xaml#L124-L127
//
// Every entity is listed, zeros included: Windows clears a badge at zero, but
// that is a rule about un-actioned notifications, and a readout of what a file
// holds has to be able to answer that it holds none of something.
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
