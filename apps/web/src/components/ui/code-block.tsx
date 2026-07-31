import { CheckmarkRegular, CopyRegular, DismissRegular } from '@fluentui/react-icons';
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

interface CodeBlockProps {
  code: string;
  copied: boolean;
  copyFailed: boolean;
  disabled?: boolean;
  /** Replaces the language caption in the header bar, for switchers that pick which code this block shows. */
  header?: ReactNode;
  language: string;
  onCopy: () => void;
}

export function CodeBlock({ code, copied, copyFailed, disabled = false, header, language, onCopy }: CodeBlockProps) {
  const { t } = useTranslation();
  const s = useStyles();
  const highlighted = useMemo(() => {
    const grammar = Prism.languages[language] ?? Prism.languages.plain;
    return grammar ? Prism.highlight(code, grammar, language) : escapeHtml(code);
  }, [code, language]);

  return (
    <div className={s.root}>
      <div aria-live="polite" className={s.header}>
        {header ?? <span className={s.lang}>{language}</span>}
        <Button
          appearance="subtle"
          disabled={disabled}
          icon={copyFailed ? <DismissRegular /> : copied ? <CheckmarkRegular /> : <CopyRegular />}
          onClick={onCopy}
          size="small"
        >
          {copyFailed ? t('dashboard.apiKeys.copy.failed') : copied ? t('dashboard.apiKeys.copy.copied') : t('dashboard.apiKeys.actions.copy')}
        </Button>
      </div>
      <ScrollArea axes="both" className="max-h-[340px]">
        <pre className={mergeClasses(`language-${language}`, s.pre, 'm-0')}>
          <code
            className={mergeClasses(`language-${language}`, s.code)}
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
