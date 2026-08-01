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
    // A heading is sized off Fluent's ramp and weighted at the top of it.
    // Semibold is where the dashboard's type stops -- global.css clamps
    // `strong` there for the same reason -- so the 700 a browser gives a
    // heading by default would be heavier than anything else on the page.
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
    // The rule between blocks is a divider, and WinUI names one brush for it.
    // Fluent's colorNeutralStroke2 is the card outline, which in dark is black
    // and disappears into the surface it is drawn on; the divider is a white
    // wash there and the same hairline in light.
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L53
    // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L257
    '& hr': {
      border: 0,
      borderTop: '1px solid var(--winui-divider-stroke-default)',
      marginTop: tokens.spacingVerticalL,
      marginBottom: tokens.spacingVerticalL,
    },
  },
  // A link walks the accent TEXT ramp a WinUI Hyperlink walks -- primary at
  // rest, secondary under the pointer, tertiary while pressed -- which is the
  // ramp the dashboard's own Link spends, so one link colour appears on
  // screen. Dark states primary and secondary as the same accent shade, so
  // hover moves no colour there; that is WinUI's table, not an omission.
  // The underline is WinUI's too: HyperlinkUnderlineVisible is True, and the
  // hyperlink keeps the decoration through pointer-over and pressed, so it is
  // stated once for every state instead of arriving on hover.
  // Nothing here can disable a link, so the ramp's disabled step has no
  // outlet, and forced colors are left to the UA, which replaces an author
  // foreground and outline with the system link and focus colours.
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
    // The focus visual. WinUI draws two concentric rings so the indicator
    // survives on any surface: the 1px FocusStrokeColorInner against the
    // element and the contrasting 2px FocusStrokeColorOuter around it. A
    // hyperlink's focus rectangle is rounded at 4px.
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
  // A quotation's leading bar is an accent surface, so it takes
  // AccentFillColorDefault rather than Fluent's brand stroke -- the same fill
  // every other accent marker in the app is drawn with.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L329
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125
  blockquote: {
    color: tokens.colorNeutralForeground2,
    borderLeft: '3px solid var(--winui-accent-fill-default)',
    margin: `${tokens.spacingVerticalM} 0`,
    paddingLeft: tokens.spacingHorizontalM,
  },
  tableScroll: {
    minWidth: 0,
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
  },
  table: {
    borderCollapse: 'collapse',
    minWidth: '100%',
  },
  // The grid between cells is the divider the horizontal rule above spends.
  // Keeping all four edges rather than the single horizontal rule a list draws
  // is ours: a table in an answer arrives without column widths or alignment,
  // and the vertical edges are what hold its columns apart.
  tableCell: {
    border: '1px solid var(--winui-divider-stroke-default)',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    textAlign: 'left',
    verticalAlign: 'top',
  },
  // A header row says header by weight alone. WinUI gives a ListViewHeaderItem
  // a transparent background in every dictionary, and the dashboard's own
  // tables carry no header fill either.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L631
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L9451
  tableHeader: {
    fontWeight: tokens.fontWeightSemibold,
  },
  // A fenced block is the one place code states its own surface. It takes the
  // page canvas rather than a card fill because that is the neutral that steps
  // away from the message card in both themes -- lighter than the card in
  // dark would be a card fill's job, and a card fill is white on a white card
  // in light. Its edge is the control stroke rather than the card outline for
  // the same reason the rule above is a divider: the card outline is black in
  // dark and would leave the block edgeless there.
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
  // Code set inside a sentence is the same text in a different face: it takes
  // its colour and its surface from the prose around it and states neither.
  // WinUI has no inline-code chip, and a fill plus a border plus its own
  // foreground would turn a word in a sentence into a control. The face and
  // the pixel it comes down by are the document's, in global.css.
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
