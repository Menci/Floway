import type { ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components, UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { fluentComponents } from '../../fluent';

const { makeStyles } = fluentComponents;

// One dialect for every piece of markdown the dashboard renders, so a backtick,
// an emphasis run or a link means the same thing in a chat reply and in
// operator-facing copy.
export const markdownRemarkPlugins = [remarkGfm];

export const markdownUrlTransform: UrlTransform = url => {
  if (url.startsWith('/') || url.startsWith('#')) return url;

  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
};

const useStyles = makeStyles({
  // A link in running prose is WinUI's inline Hyperlink, so it walks the accent
  // TEXT ramp -- primary, secondary, tertiary -- and, because WinUI 3 ships
  // HyperlinkUnderlineVisible as False, is underlined only at rest: the pointer
  // states drop the underline rather than gaining one.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Hyperlink_themeresources.xaml#L5-L7
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Hyperlink_themeresources.xaml#L20
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297-L299
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L93-L95
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/text/TextBlock/Hyperlink.cpp#L669-L671
  link: {
    color: 'var(--winui-accent-text-fill-primary)',
    textDecorationLine: 'underline',
    '&:hover': { color: 'var(--winui-accent-text-fill-secondary)', textDecorationLine: 'none' },
    '&:active': { color: 'var(--winui-accent-text-fill-tertiary)', textDecorationLine: 'none' },
    // Two concentric rings so the indicator survives on any surface, at the 4px
    // radius WinUI rounds a hyperlink's to.
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
});

export function MarkdownLink({ children, ...props }: ComponentProps<'a'>) {
  const s = useStyles();
  return <a {...props} className={s.link} target="_blank" rel="noopener noreferrer">{children}</a>;
}

// Inline markdown carries no block structure: the caller owns the element the
// prose sits in, so the paragraph the parser wraps a run of text in is
// unwrapped again here.
const inlineComponents: Components = {
  a: MarkdownLink,
  p: ({ children }) => <>{children}</>,
};

export function InlineMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      components={inlineComponents}
      remarkPlugins={markdownRemarkPlugins}
      skipHtml
      urlTransform={markdownUrlTransform}
    >
      {children}
    </ReactMarkdown>
  );
}
