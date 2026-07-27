import { FileSystemIconLoader } from '@iconify/utils/lib/loader/node-loaders';
import { defineConfig, presetIcons, presetWind3, transformerDirectives, transformerVariantGroup } from 'unocss';

export default defineConfig({
  presets: [
    presetWind3(),
    presetIcons({
      scale: 1.2,
      warn: true,
      collections: {
        // Brand marks Iconify has no coverage for at all — a search across every
        // collection returns nothing for either. Vendored from lobe-icons
        // (MIT), which publishes them as monochrome currentColor paths so they
        // sit beside simple-icons without a seam:
        // https://github.com/lobehub/lobe-icons/tree/v1.94.0/packages/static-svg/icons
        brand: FileSystemIconLoader('./src/assets/icons'),
      },
    }),
  ],
  theme: {
    fontSize: {
      'fui-base200': 'var(--fontSizeBase200)',
      'fui-base300': 'var(--fontSizeBase300)',
      'fui-base400': 'var(--fontSizeBase400)',
      'fui-base500': 'var(--fontSizeBase500)',
      'fui-base600': 'var(--fontSizeBase600)',
    },
  },
  shortcuts: {
    'text-fui-fg1': 'text-[var(--colorNeutralForeground1)]',
    'text-fui-fg2': 'text-[var(--colorNeutralForeground2)]',
    'text-fui-fg3': 'text-[var(--colorNeutralForeground3)]',
    'bg-fui-bg1': 'bg-[var(--colorNeutralBackground1)]',
    'bg-fui-bg2': 'bg-[var(--colorNeutralBackground2)]',
    'border-fui-stroke1': 'border-[var(--colorNeutralStroke1)]',
    // Sidebar nav
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
  transformers: [transformerDirectives(), transformerVariantGroup()],
  content: {
    filesystem: ['src/**/*.{ts,tsx}'],
  },
});
