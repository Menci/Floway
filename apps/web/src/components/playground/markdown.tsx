import { memo, useMemo } from 'react';
import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remend from 'remend';

import { fluentComponents } from '../../fluent';
import { MarkdownLink, markdownRemarkPlugins, markdownUrlTransform } from '../ui/markdown';
import { highlight, prismTokenStyles } from '../ui/prism';
import { ScrollArea } from '../ui/scroll-area';

const { makeStyles, tokens } = fluentComponents;

const useStyles = makeStyles({
  root: {
    minWidth: 0,
    lineHeight: tokens.lineHeightBase400,
    '& > :first-child': { marginTop: 0 },
    '& > :last-child': { marginBottom: 0 },
    '& p': { marginTop: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalS },
    // Semibold is where the dashboard's type stops; a heading's default 700
    // would outweigh anything else on the page.
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
  // An accent surface, so AccentFillColorDefault rather than Fluent's brand
  // stroke.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L329
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L125
  blockquote: {
    color: tokens.colorNeutralForeground2,
    borderLeft: '3px solid var(--winui-accent-fill-default)',
    margin: `${tokens.spacingVerticalM} 0`,
    paddingLeft: tokens.spacingHorizontalM,
  },
  // Chrome makes an overflowing scroller focusable when nothing inside it can
  // take focus, and a markdown table holds nothing that can, which is what the
  // focus rect on this host is for.
  tableScroll: {
    minWidth: 0,
    marginTop: tokens.spacingVerticalM,
    marginBottom: tokens.spacingVerticalM,
  },
  table: {
    borderCollapse: 'collapse',
    minWidth: '100%',
  },
  tableCell: {
    border: '1px solid var(--winui-divider-stroke-default)',
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    textAlign: 'left',
    verticalAlign: 'top',
  },
  // Weight alone: WinUI gives a ListViewHeaderItem a transparent background in
  // every dictionary.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L631
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L9451
  tableHeader: {
    fontWeight: tokens.fontWeightSemibold,
  },
  // The page canvas rather than a card fill, the one neutral that steps away
  // from the message card in both themes; the card outline is black in dark, so
  // the edge is the control stroke.
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
  // Inline code keeps the surrounding prose's colour and surface, its face
  // coming from global.css: WinUI has no inline-code chip.
  if (!match) return <code {...props}>{children}</code>;

  const language = match[1]!;
  const code = String(children).replace(/\n$/, '');
  const highlighted = streaming ? null : highlight(code, language);

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
    a: MarkdownLink,
    blockquote: ({ children, ...props }) => <blockquote {...props} className={s.blockquote}>{children}</blockquote>,
    code: props => <MarkdownCode {...props} streaming={streaming} />,
    img: () => null,
    pre: MarkdownPre,
    table: ({ children }) => <ScrollArea axes="horizontal" className={`winui-focus-rect-within ${s.tableScroll}`}><table className={s.table}>{children}</table></ScrollArea>,
    td: ({ children, ...props }) => <td {...props} className={s.tableCell}>{children}</td>,
    th: ({ children, ...props }) => <th {...props} className={`${s.tableCell} ${s.tableHeader}`}>{children}</th>,
  }), [s, streaming]);

  return (
    <div className={s.root}>
      <ReactMarkdown
        components={components}
        remarkPlugins={markdownRemarkPlugins}
        skipHtml
        urlTransform={markdownUrlTransform}
      >
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
});
