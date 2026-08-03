import Prism from 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-typescript';

import { fluentComponents } from '../../fluent';

const { tokens } = fluentComponents;

// Every grammar the dashboard can render is registered above, so this module
// is the whole of Prism as far as the app is concerned. A language it does not
// name resolves to the empty plain grammar, which stringifies to escaped
// source rather than throwing.
const grammarFor = (language: string) => Prism.languages[language] ?? Prism.languages.plain;

export const highlight = (code: string, language: string): string =>
  Prism.highlight(code, grammarFor(language), language);

export const prismTokenStyles = {
  '& .token.comment, & .token.prolog, & .token.doctype, & .token.cdata': {
    color: tokens.colorNeutralForeground3,
  },
  '& .token.punctuation': { color: tokens.colorNeutralForeground2 },
  '& .token.property, & .token.tag, & .token.constant, & .token.symbol, & .token.deleted': {
    color: tokens.colorPaletteRedForeground2,
  },
  '& .token.boolean, & .token.number': { color: tokens.colorPalettePurpleForeground2 },
  '& .token.selector, & .token.attr-name, & .token.string, & .token.char, & .token.builtin, & .token.inserted': {
    color: tokens.colorPaletteGreenForeground2,
  },
  '& .token.operator, & .token.entity, & .token.url, & .language-css .token.string': {
    color: tokens.colorPaletteMarigoldForeground2,
  },
  '& .token.atrule, & .token.attr-value, & .token.keyword': { color: tokens.colorBrandForeground1 },
  '& .token.function, & .token.class-name': { color: tokens.colorPaletteBlueForeground2 },
  '& .token.regex, & .token.important, & .token.variable': { color: tokens.colorPaletteMarigoldForeground2 },
} as const;
