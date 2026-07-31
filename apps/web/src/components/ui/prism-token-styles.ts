import { fluentComponents } from '../../fluent';

const { tokens } = fluentComponents;

export const prismTokenStyles = {
  '& .token.comment, & .token.prolog, & .token.doctype, & .token.cdata': {
    color: 'var(--colorNeutralForeground3)',
  },
  '& .token.punctuation': { color: 'var(--colorNeutralForeground2)' },
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
  '& .token.atrule, & .token.attr-value, & .token.keyword': { color: 'var(--colorBrandForeground1)' },
  '& .token.function, & .token.class-name': { color: tokens.colorPaletteBlueForeground2 },
  '& .token.regex, & .token.important, & .token.variable': { color: tokens.colorPaletteMarigoldForeground2 },
} as const;
