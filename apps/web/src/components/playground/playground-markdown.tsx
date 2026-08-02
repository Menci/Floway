import Prism from 'prismjs';
import { memo, useMemo } from 'react';
import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remend from 'remend';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-typescript';

import { fluentComponents } from '../../fluent';
import { prismTokenStyles } from '../ui/prism-token-styles';
import { ScrollArea } from '../ui/scroll-area';

const { makeStyles, tokens } = fluentComponents;

const remarkPlugins = [remarkGfm];

const safeUrlTransform: UrlTransform = url => {
  if (url.startsWith('/') || url.startsWith('#')) return url;

  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
};

const useStyles = makeStyles({
  root: {
    minWidth: 0,
    lineHeight: tokens.lineHeightBase400,
    '& > :first-child': { marginTop: 0 },
    '& > :last-child': { marginBottom: 0 },
    '& p': { marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalS },
    // Semibold is where the dashboard's type stops, so the 700 a browser gives
    // a heading by default would outweigh anything else on the page.
    '& h1, & h2, & h3, & h4, & h5, & h6': { fontWeight: tokens.fontWeightSemibold },
    '& h1': {
      fontSize: tokens.fontSizeBase600,
      lineHeight: tokens.lineHeightBase600,
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalS,
    },
    '& h2': {
      fontSize: tokens.fontSizeBase500,
      lineHeight: tokens.lineHeightBase500,
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalS,
    },
    '& h3, & h4, & h5, & h6': {
      fontSize: tokens.fontSizeBase400,
      lineHeight: tokens.lineHeightBase400,
      marginTop: tokens.spacingVerticalM,
      marginBottom: tokens.spacingVerticalXS,
    },
    '& ul, & ol': {
      marginTop: tokens.spacingVerticalS,
      marginBottom: tokens.spacingVerticalS,
      paddingLeft: tokens.spacingHorizontalXXL,
    },
    '& li': { marginTop: tokens.spacingVerticalXXS, marginBottom: tokens.spacingVerticalXXS },
    '& li > p': { marginTop: 0, marginBottom: 0 },
    // The divider brush, not Fluent's colorNeutralStroke2: that is the card
    // outline, which in dark is black and disappears into its own surface.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L53
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L257
    '& hr': {
      border: 0,
      borderTop: '1px solid var(--winui-divider-stroke-default)',
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalL,
    },
  },
  // The accent TEXT ramp a WinUI Hyperlink walks -- primary at rest, secondary
  // under the pointer, tertiary while pressed. Dark states primary and
  // secondary as the same shade in WinUI's own table, so hover moves no colour
  // there. HyperlinkUnderlineVisible is True and the decoration is kept through
  // every state rather than arriving on hover.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L5-L7
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297-L299
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L93-L95
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L5926
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/text/TextBlock/Hyperlink.cpp#L662-L672
  link: {
    color: 'var(--winui-accent-text-fill-primary)',
    textDecorationLine: 'underline',
    '&:hover': { color: 'var(--winui-accent-text-fill-secondary)' },
    '&:active': { color: 'var(--winui-accent-text-fill-tertiary)' },
    // WinUI draws two concentric rings so the indicator survives on any
    // surface: 1px FocusStrokeColorInner against the element, contrasting 2px
    // FocusStrokeColorOuter around it, rounded at 4px for a hyperlink.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L195
    '&:focus-visible': {
      borderRadius: '4px',
      boxShadow: '0 0 0 1px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '1px',
    },
  },
  // An accent surface, so AccentFillColorDefault rather than Fluent's brand
  // stroke -- the fill every other accent marker in the app is drawn with.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L329
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125
  blockquote: {
    color: tokens.colorNeutralForeground2,
    borderLeft: '3px solid var(--winui-accent-fill-default)',
    margin: `${tokens.spacingVerticalM} 0`,
    paddingLeft: tokens.spacingHorizontalM,
  },
  // Chrome makes an overflowing scroller focusable when nothing inside it can
  // take focus, and a markdown table holds nothing that can, so this box is a
  // tab stop. The ring is drawn inward because the scrollport is the box that
  // clips, leaving no room outside it for a ring.
  tableScroll: {
    minWidth: 0,
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
    '& :focus-visible': {
      boxShadow: 'inset 0 0 0 3px var(--winui-focus-stroke-inner)',
      outline: '2px solid var(--winui-focus-stroke-outer)',
      outlineOffset: '-2px',
    },
  },
  table: {
    borderCollapse: 'collapse',
    minWidth: '100%',
  },
  // All four edges, not just the horizontal rule: a table in an answer arrives
  // without column widths or alignment, and the vertical edges hold its columns
  // apart.
  tableCell: {
    border: '1px solid var(--winui-divider-stroke-default)',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    textAlign: 'left',
    verticalAlign: 'top',
  },
  // Weight alone: WinUI gives a ListViewHeaderItem a transparent background in
  // every dictionary, and the dashboard's own tables carry no header fill.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L631
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L9451
  tableHeader: {
    fontWeight: tokens.fontWeightSemibold,
  },
  // The page canvas rather than a card fill, because it is the neutral that
  // steps away from the message card in both themes; the edge is the control
  // stroke, the card outline being black in dark and so edgeless there.
  codeBlock: {
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
    maxWidth: '100%',
    padding: tokens.spacingHorizontalM,
    '& pre': { margin: 0 },
    '& code': {
      color: tokens.colorNeutralForeground1,
      fontFamily: tokens.fontFamilyMonospace,
      fontSize: 'var(--floway-font-size-mono)',
      lineHeight: tokens.lineHeightBase400,
      whiteSpace: 'pre',
    },
    ...prismTokenStyles,
  },
});

type MarkdownCodeProps = ComponentProps<'code'> & { streaming: boolean };

function MarkdownCode({ children, className, streaming, ...props }: MarkdownCodeProps) {
  const match = /language-([\w-]+)/.exec(className ?? '');
  // Inline code takes its colour and surface from the prose around it: WinUI
  // has no inline-code chip, and a fill plus border plus foreground would turn
  // a word in a sentence into a control. Its face is global.css's.
  if (!match) return <code {...props}>{children}</code>;

  const language = match[1]!;
  const code = String(children).replace(/\n$/, '');
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

function MarkdownPre({ children }: ComponentProps<'pre'>) {
  const s = useStyles();
  return <ScrollArea axes="both" className={s.codeBlock}><pre>{children}</pre></ScrollArea>;
}

interface PlaygroundMarkdownProps {
  content: string;
  streaming: boolean;
}

export const PlaygroundMarkdown = memo(function PlaygroundMarkdown({ content, streaming }: PlaygroundMarkdownProps) {
  const s = useStyles();
  const renderedContent = useMemo(
    () => streaming ? remend(content, { linkMode: 'text-only' }) : content,
    [content, streaming],
  );
  const components = useMemo<Components>(() => ({
    a: ({ children, ...props }) => <a {...props} className={s.link} target="_blank" rel="noopener noreferrer">{children}</a>,
    blockquote: ({ children, ...props }) => <blockquote {...props} className={s.blockquote}>{children}</blockquote>,
    code: props => <MarkdownCode {...props} streaming={streaming} />,
    img: () => null,
    pre: MarkdownPre,
    table: ({ children }) => <ScrollArea axes="horizontal" className={s.tableScroll}><table className={s.table}>{children}</table></ScrollArea>,
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
