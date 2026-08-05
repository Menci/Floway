import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { highlight, prismTokenStyles } from './prism';
import { ScrollArea } from './scroll-area';
import { copyOutcomeIcon, useCopyLabel, type CopyOutcome } from './use-copy-to-clipboard';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Button, makeStyles, mergeClasses } = fluentComponents;

// The two fills come from the Expander, WinUI's one surface that stacks a strip
// above a content region in a single frame. Deliberately not the Expander's own
// CardBackgroundFill and CardStroke: those are washes meant to sit over Mica, so
// the card fill disappears on the white panel this block sits on in light and
// CardStrokeColorDefault is black at 10%, invisible, in dark. The solid ramp and
// ControlStrokeColorDefault carry in both themes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L39
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L243
const useStyles = makeStyles({
  // ControlCornerRadius. The clip is why the region's focus visual below is
  // drawn inside the viewport rather than around it.
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
  // padded to 16, where this strip is sized to what it holds.
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
  // TextFillSecondary, in the code face so the caption reads as a label on that
  // face rather than as prose above it.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L6
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L210
  lang: {
    color: 'var(--winui-text-fill-secondary)',
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: 'var(--floway-font-size-mono)',
  },
  // Under an auto min-width the scrollable region ends where the text does, so
  // the trailing padding is never reachable and the last character sits against
  // the frame. min-width rather than width keeps it filling a short sample.
  pre: {
    margin: 0,
    minWidth: 'max-content',
    padding: '12px',
    tabSize: '2',
  },
  // Prism marks one token "table", which the utility sheet would otherwise lay
  // out as a table.
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
  scroll: {
    maxHeight: '340px',
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
  const highlighted = useMemo(
    () => highlight(code, language),
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
      <ScrollArea axes="both" className={mergeClasses('winui-focus-rect-within', styles.scroll)}>
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
