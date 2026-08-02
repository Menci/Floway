import Prism from 'prismjs';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-toml';

import { prismTokenStyles } from './prism-token-styles';
import { ScrollArea } from './scroll-area';
import { copyOutcomeIcon, useCopyLabel, type CopyOutcome } from './use-copy-to-clipboard';
import { fluentComponents } from '../../fluent';

const { Button, makeStyles, mergeClasses } = fluentComponents;

// A code sample under a caption strip. WinUI has no code control, and its one
// surface that puts a strip above a content region inside a single frame is the
// Expander, so the two fills are taken from that relationship -- the strip a
// step up the ramp from the region it labels.
//
// Neither fill is the Expander's own CardBackgroundFill brush, and the frame is
// not its CardStroke. Those brushes are washes meant to sit over Mica: the card
// fill is a translucent white that disappears on the white panel this block
// sits on in light, and CardStrokeColorDefault is black at 10% in dark, which
// leaves a frame drawn with it invisible there. The solid background ramp
// carries the same step as opaque colours in both themes, and
// ControlStrokeColorDefault is a white wash in dark and a black hairline in
// light, so it draws an edge in both.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L39
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243
//
// Nothing in the frame or the strip repaints on pointer: the Expander declares
// one header background with no pointer-over counterpart to it, and the only
// things here that answer input are the copy button and the tab list a caller
// may pass as the header, each of which paints its own states in the layer.
// Under forced colours every fill, stroke and token colour below is replaced by
// the user agent with a system colour, which is the shape of WinUI's own
// HighContrast dictionary for this surface, so no rule restates it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L52-L60
// https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
const useStyles = makeStyles({
  // The block is an inline surface, so it takes ControlCornerRadius, the radius
  // the layer gives everything that does not float, and the page-canvas step of
  // the solid ramp, so the code reads as recessed from the panel around it in
  // both themes. The clip is what rounds the strip's fill and the scrolled code
  // to that radius, and it is why the region's focus visual below is drawn
  // inside the region rather than around it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L26
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L68
  root: {
    backgroundColor: 'var(--winui-solid-background-fill-tertiary)',
    border: '1px solid var(--winui-control-stroke-default)',
    borderRadius: 'var(--winui-control-corner-radius)',
    minWidth: 0,
    overflow: 'hidden',
  },
  // The strip one step up the ramp from the code, divided from it by the same
  // stroke the frame is drawn with, as the Expander divides its header from its
  // content with the one brush it frames both in.
  //
  // Its height and inset are ours: the Expander's header is a 48px click target
  // padded to 16, where this strip is sized to what it holds -- a caption and a
  // small subtle button.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L70
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9
  header: {
    alignItems: 'center',
    backgroundColor: 'var(--winui-solid-background-fill-quarternary)',
    borderBottom: '1px solid var(--winui-control-stroke-default)',
    display: 'flex',
    gap: '8px',
    justifyContent: 'space-between',
    minHeight: '38px',
    padding: '4px 8px 4px 12px',
  },
  // The caption names the sample rather than being it, so it takes the
  // secondary text fill; it is set in the code face at the code size, so it
  // reads as a label on that face rather than as prose above it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L6
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L210
  lang: {
    color: 'var(--winui-text-fill-secondary)',
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: 'var(--floway-font-size-mono)',
  },
  // The document sheet states the face, the size and the line height of every
  // `pre`, so only the box is stated here. Its inset is ours: the Expander pads
  // its content region to 16 around a form, where this holds a code sample.
  // The width is what makes that inset survive a scroll. Left to `auto` the
  // block is as wide as the viewport and only its text overflows, so the
  // scrollable region ends where the text does and the trailing padding is
  // never reachable -- scrolled fully right, the last character sits against
  // the frame. Sizing the block to its own content instead puts its padding
  // inside the scrollable region, and `min-width` rather than `width` keeps it
  // filling the viewport when the sample is short.
  pre: {
    margin: 0,
    minWidth: 'max-content',
    padding: '12px',
    tabSize: '2',
  },
  // The sample itself is primary text, with the highlighter's token colours
  // over it. Prism marks one token `table`, which the utility sheet would lay
  // out as a table, so its display is restated as the inline run it is.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L5
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L209
  code: {
    ...prismTokenStyles,
    '& .token.table': {
      display: 'inline',
    },
    color: 'var(--winui-text-fill-primary)',
    whiteSpace: 'pre',
  },
  // The scrolled region is a tab stop -- the scrollbar library makes its
  // viewport one wherever the platform's scrollbars take layout width, and a
  // browser makes a scroll container keyboard-focusable on its own -- so it
  // draws a focus visual. WinUI's is a 2px FocusStrokeColorOuter ring with a
  // 1px FocusStrokeColorInner ring immediately inside it. Both are drawn inside
  // the viewport's own box, because the frame above clips everything outside
  // it; the outline covers the outer two of the shadow's three pixels, which
  // leaves the inner ring as the third. The viewport is the only focusable
  // element the region contains, so the ring needs no more of a subject than
  // that. Under forced colours the shadow is dropped by the user agent and the
  // outline takes the system focus colour.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
  scroll: {
    maxHeight: '340px',
    '& :focus-visible': {
      boxShadow: 'inset 0 0 0 3px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '-2px',
    },
  },
});

export function CodeBlock({ code, copyOutcome, disabled = false, header, language, onCopy }: {
  code: string;
  copyOutcome: CopyOutcome;
  disabled?: boolean;
  /** Replaces the language caption in the header bar, for switchers that pick which code this block shows. */
  header?: ReactNode;
  language: string;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const copyLabel = useCopyLabel();
  // An unregistered language falls back to Prism's own empty `plain` grammar,
  // which tokenizes to a single text run and stringifies to the escaped source
  // -- so a caller naming a grammar nobody imported gets plain text rather than
  // an exception.
  const highlighted = useMemo(
    () => Prism.highlight(code, Prism.languages[language] ?? Prism.languages.plain, language),
    [code, language],
  );

  return (
    <div className={styles.root}>
      <div aria-live="polite" className={styles.header}>
        {header ?? <span className={styles.lang}>{language}</span>}
        <Button
          appearance="subtle"
          disabled={disabled}
          icon={copyOutcomeIcon(copyOutcome)}
          onClick={onCopy}
          size="small"
        >
          {copyLabel(copyOutcome, t('common.copy.action'))}
        </Button>
      </div>
      <ScrollArea axes="both" className={styles.scroll}>
        <pre className={mergeClasses(`language-${language}`, styles.pre)}>
          <code
            className={mergeClasses(`language-${language}`, styles.code)}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        </pre>
      </ScrollArea>
    </div>
  );
}
