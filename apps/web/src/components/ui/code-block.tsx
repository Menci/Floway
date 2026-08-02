import Prism from 'prismjs';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { prismTokenStyles } from './prism-token-styles';
import { ScrollArea } from './scroll-area';
import { copyOutcomeIcon, useCopyLabel, type CopyOutcome } from './use-copy-to-clipboard';
import { fluentComponents } from '../../fluent';

const { Button, makeStyles, mergeClasses } = fluentComponents;

// A code sample under a caption strip. WinUI has no code control, so the two
// fills are taken from the Expander -- its one surface that puts a strip above
// a content region inside a single frame -- the strip a step up the ramp from
// the region it labels.
//
// Deliberately not the Expander's own CardBackgroundFill and CardStroke: those
// are washes meant to sit over Mica, so the card fill disappears on the white
// panel this block sits on in light and CardStrokeColorDefault is black at 10%
// in dark, invisible there. The solid ramp and ControlStrokeColorDefault carry
// in both themes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L39
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243
//
// Nothing here repaints on pointer, and under forced colours the user agent
// replaces every fill, stroke and token colour below, which matches WinUI's own
// HighContrast dictionary for this surface, so no rule restates it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L52-L60
// https://drafts.csswg.org/css-color-adjust/#forced-colors-properties
const useStyles = makeStyles({
  // ControlCornerRadius, the radius the layer gives everything that does not
  // float. The clip rounds the strip's fill and the scrolled code to it, and is
  // why the region's focus visual below is drawn inside rather than around.
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
  // Height and inset are ours: the Expander's header is a 48px click target
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
  // secondary text fill, set in the code face so it reads as a label on that
  // face rather than as prose above it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L6
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L210
  lang: {
    color: 'var(--winui-text-fill-secondary)',
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: 'var(--floway-font-size-mono)',
  },
  // `min-width: max-content` is what makes the inset survive a scroll. Left to
  // `auto` the block is only as wide as the viewport, so the scrollable region
  // ends where the text does and the trailing padding is never reachable --
  // scrolled fully right, the last character sits against the frame. `min-width`
  // rather than `width` keeps it filling the viewport when the sample is short.
  pre: {
    margin: 0,
    minWidth: 'max-content',
    padding: '12px',
    tabSize: '2',
  },
  // Prism marks one token `table`, which the utility sheet would lay out as a
  // table, so its display is restated as the inline run it is.
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
  // The scrolled region is a tab stop, so it draws WinUI's focus visual: a 2px
  // FocusStrokeColorOuter ring with a 1px FocusStrokeColorInner ring inside it.
  // Both sit inside the viewport's own box because the frame above clips
  // everything outside it, so the outline covers the outer two of the shadow's
  // three pixels and leaves the inner ring as the third.
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
  // Prism registers a grammar as a module side effect, so the module that names
  // a language is the one that imports it. A name nobody registered falls back
  // to the empty `plain` grammar, which stringifies to the escaped source, so
  // the sample reads as plain text rather than throwing.
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
