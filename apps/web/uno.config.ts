import { defineConfig, presetWind3 } from 'unocss';

export default defineConfig({
  presets: [
    presetWind3(),
  ],
  theme: {
    fontFamily: {
      mono: 'var(--fontFamilyMonospace)',
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
    'text-fui-nav-default': 'text-[light-dark(#3f3f46,#ffffff)]',
    'text-fui-nav-hover': 'text-[light-dark(#242424,#ffffff)]',
    'text-fui-nav-active': 'text-[light-dark(#111827,#ffffff)]',
    'bg-fui-nav-active': 'bg-[light-dark(#ffffff,rgba(255,255,255,0.06))]',
    'bg-fui-nav-hover': 'bg-[light-dark(rgba(255,255,255,0.5),rgba(255,255,255,0.08))]',
    'border-fui-subtle': 'border-[light-dark(rgba(0,0,0,0.06),rgba(255,255,255,0.08))]',
  },
  rules: [
    ['font-fui-regular', { 'font-weight': 'var(--fontWeightRegular)' }],
    ['font-fui-medium', { 'font-weight': 'var(--fontWeightMedium)' }],
    ['font-fui-semibold', { 'font-weight': 'var(--fontWeightSemibold)' }],
  ],
  // The PostCSS integration reads these globs itself and never sees the module
  // graph, so a class only ships if a file here spells it out. It also applies
  // no source-level transformers: utilities must appear verbatim in the source,
  // not as variant groups.
  content: {
    filesystem: ['src/**/*.{ts,tsx}'],
  },
});
