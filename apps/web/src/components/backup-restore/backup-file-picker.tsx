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

// Filled, the region reports what it is holding and keeps accepting a
// replacement, with the command that asks for one at its trailing edge. The
// name over what the file carries is the title-over-description pair
// ../ui/layout.ts states the gap for.
export function BackupFileSummary({ accepting, action, contents, drop, name }: {
  accepting: boolean;
  action: ReactNode;
  contents: string;
  drop: FileDropHandlers;
  name: string;
}) {
  const styles = useStyles();
  return <div
    className={mergeClasses(styles.region, accepting && styles.accepting, 'flex items-center gap-3 flex-wrap')}
    {...drop}
  >
    <div className={mergeClasses(TIGHT_STACK_CLASS, 'min-w-0 flex-1')}>
      <Text>{name}</Text>
      <Text size={200} className="text-fui-fg2">{contents}</Text>
    </div>
    {action}
  </div>;
}
