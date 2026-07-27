import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CheckmarkRegular, CopyRegular } from "@fluentui/react-icons";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-toml";

import { fluentComponents } from "../../fluent";

const { Button, makeStyles } = fluentComponents;

const useStyles = makeStyles({
  root: {
    border: "1px solid var(--colorNeutralStroke1)",
    borderRadius: "8px",
    minWidth: 0,
    overflow: "hidden",
  },
  header: {
    alignItems: "center",
    backgroundColor: "var(--colorNeutralBackground2)",
    borderBottom: "1px solid var(--colorNeutralStroke1)",
    display: "flex",
    justifyContent: "space-between",
    minHeight: "38px",
    padding: "4px 8px 4px 12px",
  },
  lang: {
    color: "var(--colorNeutralForeground2)",
    fontFamily: "monospace",
    fontSize: "12px",
  },
  pre: {
    fontFamily: "monospace",
    fontSize: "12px",
    lineHeight: "1.55",
    margin: 0,
    maxHeight: "340px",
    minHeight: "142px",
    minWidth: 0,
    overflow: "auto",
    padding: "12px",
    tabSize: "2",
  },
  code: {
    "& .token.table": {
      display: "inline",
    },
    fontFamily: "monospace",
    whiteSpace: "pre",
  },
});

interface CodeBlockProps {
  code: string;
  copied: boolean;
  disabled?: boolean;
  language: string;
  onCopy: () => void;
}

export function CodeBlock({ code, copied, disabled = false, language, onCopy }: CodeBlockProps) {
  const { t } = useTranslation();
  const s = useStyles();
  const highlighted = useMemo(() => {
    const grammar = Prism.languages[language] ?? Prism.languages.plain;
    return grammar ? Prism.highlight(code, grammar, language) : escapeHtml(code);
  }, [code, language]);

  return (
    <div className={s.root}>
      <div className={s.header}>
        <span className={s.lang}>{language}</span>
        <Button
          appearance="subtle"
          disabled={disabled}
          icon={copied ? <CheckmarkRegular /> : <CopyRegular />}
          onClick={onCopy}
          size="small"
        >
          {copied ? t("dashboard.apiKeys.copy.copied") : t("dashboard.apiKeys.actions.copy")}
        </Button>
      </div>
      <pre className={`language-${language} ${s.pre} !m-0`}>
        <code
          className={`language-${language} ${s.code}`}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
