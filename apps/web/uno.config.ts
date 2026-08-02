import { defineConfig, presetWind3 } from 'unocss';

export default defineConfig({
  presets: [
    presetWind3(),
  ],
  theme: {
    fontFamily: {
      sans: 'var(--fontFamilyBase)',
    },
    fontSize: {
      'fui-base200': 'var(--fontSizeBase200)',
      'fui-base300': 'var(--fontSizeBase300)',
      'fui-base400': 'var(--fontSizeBase400)',
      'fui-base500': 'var(--fontSizeBase500)',
      'fui-base600': 'var(--fontSizeBase600)',
    },
  },
  shortcuts: {
    // A route's own content region. `min-w-0` alone lets the region shrink but
    // leaves its single column at `auto`, which grows to the widest child's
    // min-content — one long message bar then pushes the whole page past the
    // viewport. The explicit track floors that column at zero.
    'dashboard-page': 'grid gap-[18px] min-w-0 grid-cols-[minmax(0,1fr)]',
    'text-fui-fg1': 'text-[var(--colorNeutralForeground1)]',
    'text-fui-fg2': 'text-[var(--colorNeutralForeground2)]',
    'text-fui-fg3': 'text-[var(--colorNeutralForeground3)]',
    // The hyperlink foreground. Named here rather than left to the caller,
    // because a bare `<a>` with an undefined colour falls through to the user
    // agent's visited purple, which is what happened while this was missing.
    'text-fui-brand1': 'text-[var(--colorBrandForeground1)]',
    'bg-fui-bg1': 'bg-[var(--colorNeutralBackground1)]',
    'bg-fui-bg2': 'bg-[var(--colorNeutralBackground2)]',
    'border-fui-stroke1': 'border-[var(--colorNeutralStroke1)]',
  },
  rules: [
    ['font-fui-regular', { 'font-weight': 'var(--fontWeightRegular)' }],
    ['font-fui-semibold', { 'font-weight': 'var(--fontWeightSemibold)' }],
  ],
  // `font-mono` is global.css's, not a utility: the class also has to reach the
  // form controls and code elements inside it, and it has to outrank Griffel's
  // atomic rules on those, which takes a selector list and `!important` that a
  // theme value cannot express. Generating the single-declaration version here
  // as well would only add a rule that is always overridden.
  blocklist: ['font-mono'],
  // The PostCSS integration reads these globs itself and never sees the module
  // graph, so a class only ships if a file here spells it out. It also applies
  // no source-level transformers: utilities must appear verbatim in the source,
  // not as variant groups.
  //
  // The `.css.ts` modules are excluded because their bodies are CSS text and
  // English prose, not class attributes. Extraction is substring-based, so a
  // word in a sentence there becomes a shipped rule -- "shrink-to-fit," in a
  // comment shipped as `.shrink-to-fit\,{flex-shrink:1}`.
  content: {
    filesystem: ['src/**/*.{ts,tsx}', '!src/**/*.css.ts'],
  },
});
