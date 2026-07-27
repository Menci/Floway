import { memo, useMemo } from "react";
import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import type { Components, UrlTransform } from "react-markdown";
import remend from "remend";
import remarkGfm from "remark-gfm";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-typescript";

import { fluentComponents } from "../../fluent";

const { makeStyles, tokens } = fluentComponents;

const remarkPlugins = [remarkGfm];

const safeUrlTransform: UrlTransform = (url) => {
  if (url.startsWith("/") || url.startsWith("#")) return url;

  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
};

const useStyles = makeStyles({
  root: {
    minWidth: 0,
    lineHeight: tokens.lineHeightBase400,
    "& > :first-child": { marginTop: 0 },
    "& > :last-child": { marginBottom: 0 },
    "& p": { marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalS },
    "& h1": {
      fontSize: tokens.fontSizeBase600,
      lineHeight: tokens.lineHeightBase600,
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalS,
    },
    "& h2": {
      fontSize: tokens.fontSizeBase500,
      lineHeight: tokens.lineHeightBase500,
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalS,
    },
    "& h3, & h4, & h5, & h6": {
      fontSize: tokens.fontSizeBase400,
      lineHeight: tokens.lineHeightBase400,
      marginTop: tokens.spacingVerticalM,
      marginBottom: tokens.spacingVerticalXS,
    },
    "& ul, & ol": {
      marginTop: tokens.spacingVerticalS,
      marginBottom: tokens.spacingVerticalS,
      paddingLeft: tokens.spacingHorizontalXXL,
    },
    "& li": { marginTop: tokens.spacingVerticalXXS, marginBottom: tokens.spacingVerticalXXS },
    "& li > p": { marginTop: 0, marginBottom: 0 },
    "& hr": {
      border: 0,
      borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalL,
    },
    "& strong": { fontWeight: tokens.fontWeightSemibold },
  },
  link: {
    color: tokens.colorBrandForegroundLink,
    textDecorationLine: "none",
    "&:hover": { color: tokens.colorBrandForegroundLinkHover, textDecorationLine: "underline" },
  },
  inlineCode: {
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusSmall,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase300,
    padding: `1px ${tokens.spacingHorizontalXS}`,
  },
  blockquote: {
    color: tokens.colorNeutralForeground2,
    borderLeft: `3px solid ${tokens.colorBrandStroke1}`,
    margin: `${tokens.spacingVerticalM} 0`,
    paddingLeft: tokens.spacingHorizontalM,
  },
  tableScroll: {
    minWidth: 0,
    overflowX: "auto",
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
  },
  table: {
    borderCollapse: "collapse",
    minWidth: "100%",
  },
  tableCell: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    textAlign: "left",
    verticalAlign: "top",
  },
  tableHeader: {
    backgroundColor: tokens.colorNeutralBackground3,
    fontWeight: tokens.fontWeightSemibold,
  },
  codeBlock: {
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
    maxWidth: "100%",
    overflow: "auto",
    padding: tokens.spacingHorizontalM,
    "& pre": { margin: 0 },
    "& code": {
      color: tokens.colorNeutralForeground1,
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: tokens.fontSizeBase300,
      lineHeight: tokens.lineHeightBase400,
      whiteSpace: "pre",
    },
    "& .token.comment, & .token.prolog, & .token.doctype, & .token.cdata": {
      color: tokens.colorNeutralForeground3,
    },
    "& .token.punctuation": { color: tokens.colorNeutralForeground2 },
    "& .token.property, & .token.tag, & .token.constant, & .token.symbol, & .token.deleted": {
      color: tokens.colorPaletteRedForeground2,
    },
    "& .token.boolean, & .token.number": { color: tokens.colorPalettePurpleForeground2 },
    "& .token.selector, & .token.attr-name, & .token.string, & .token.char, & .token.builtin, & .token.inserted": {
      color: tokens.colorPaletteGreenForeground2,
    },
    "& .token.operator, & .token.entity, & .token.url, & .language-css .token.string": {
      color: tokens.colorPaletteMarigoldForeground2,
    },
    "& .token.atrule, & .token.attr-value, & .token.keyword": { color: tokens.colorBrandForeground1 },
    "& .token.function, & .token.class-name": { color: tokens.colorPaletteBlueForeground2 },
    "& .token.regex, & .token.important, & .token.variable": { color: tokens.colorPaletteMarigoldForeground2 },
  },
});

type MarkdownCodeProps = ComponentProps<"code"> & { streaming: boolean };

function MarkdownCode({ children, className, streaming, ...props }: MarkdownCodeProps) {
  const s = useStyles();
  const match = /language-([\w-]+)/.exec(className ?? "");
  if (!match) return <code {...props} className={s.inlineCode}>{children}</code>;

  const language = match[1] ?? "plain";
  const code = String(children).replace(/\n$/, "");
  const grammar = Prism.languages[language] ?? Prism.languages.plain;
  const highlighted = !streaming && grammar
    ? Prism.highlight(code, grammar, language)
    : null;

  return (
    <code
      {...props}
      className={`language-${language}`}
      {...(highlighted ? { dangerouslySetInnerHTML: { __html: highlighted } } : { children: code })}
    />
  );
}

function MarkdownPre({ children }: ComponentProps<"pre">) {
  const s = useStyles();
  return <div className={s.codeBlock}><pre>{children}</pre></div>;
}

type PlaygroundMarkdownProps = {
  content: string;
  streaming: boolean;
};

export const PlaygroundMarkdown = memo(function PlaygroundMarkdown({ content, streaming }: PlaygroundMarkdownProps) {
  const s = useStyles();
  const renderedContent = useMemo(
    () => streaming ? remend(content, { linkMode: "text-only" }) : content,
    [content, streaming],
  );
  const components = useMemo<Components>(() => ({
    a: ({ children, ...props }) => <a {...props} className={s.link} target="_blank" rel="noopener noreferrer">{children}</a>,
    blockquote: ({ children, ...props }) => <blockquote {...props} className={s.blockquote}>{children}</blockquote>,
    code: (props) => <MarkdownCode {...props} streaming={streaming} />,
    img: () => null,
    pre: MarkdownPre,
    table: ({ children }) => <div className={s.tableScroll}><table className={s.table}>{children}</table></div>,
    td: ({ children, ...props }) => <td {...props} className={s.tableCell}>{children}</td>,
    th: ({ children, ...props }) => <th {...props} className={`${s.tableCell} ${s.tableHeader}`}>{children}</th>,
  }), [s, streaming]);

  return (
    <div className={s.root}>
      <ReactMarkdown
        components={components}
        remarkPlugins={remarkPlugins}
        skipHtml
        urlTransform={safeUrlTransform}
      >
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
});
