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

const useStyles = makeStyles({
  root: {
    border: '1px solid var(--colorNeutralStroke1)',
    borderRadius: '8px',
    minWidth: 0,
    overflow: 'hidden',
  },
  header: {
    alignItems: 'center',
    backgroundColor: 'var(--colorNeutralBackground2)',
    borderBottom: '1px solid var(--colorNeutralStroke1)',
    display: 'flex',
    gap: '8px',
    justifyContent: 'space-between',
    minHeight: '38px',
    padding: '4px 8px 4px 12px',
  },
  lang: {
    color: 'var(--colorNeutralForeground2)',
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: 'var(--floway-font-size-mono)',
  },
  pre: {
    fontFamily: 'var(--fontFamilyMonospace)',
    fontSize: 'var(--floway-font-size-mono)',
    lineHeight: 'var(--lineHeightBase300)',
    margin: 0,
    minWidth: 0,
    padding: '12px',
    tabSize: '2',
  },
  code: {
    ...prismTokenStyles,
    '& .token.table': {
      display: 'inline',
    },
    color: 'var(--colorNeutralForeground1)',
    fontFamily: 'var(--fontFamilyMonospace)',
    whiteSpace: 'pre',
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
  const highlighted = useMemo(() => {
    const grammar = Prism.languages[language] ?? Prism.languages.plain;
    return grammar ? Prism.highlight(code, grammar, language) : escapeHtml(code);
  }, [code, language]);

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
      <ScrollArea axes="both" className="max-h-[340px]">
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

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
