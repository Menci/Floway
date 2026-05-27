import { defineConfig, presetIcons, presetWebFonts, presetWind3, transformerDirectives, transformerVariantGroup } from 'unocss';
import presetAnimations from 'unocss-preset-animations';

// Brand tokens lifted verbatim from the prerender dashboard's tailwind config
// (apps/web/src/layout.tsx in the pre-SPA tree). Migrating without these means
// throwing away the dashboard's whole visual identity; the SPA's job here is
// the wiring, not a redesign.
export default defineConfig({
  presets: [
    presetWind3(),
    presetAnimations(),
    presetIcons({
      scale: 1.2,
      warn: true,
    }),
    presetWebFonts({
      provider: 'google',
      fonts: {
        sans: [{ name: 'DM Sans', weights: ['300', '400', '500', '600', '700'] }, 'system-ui', 'sans-serif'],
        mono: [{ name: 'JetBrains Mono', weights: ['300', '400', '500', '600'] }, 'monospace'],
      },
    }),
  ],
  theme: {
    colors: {
      surface: {
        900: '#06080a',
        800: '#0c1015',
        700: '#13181f',
        600: '#1a2029',
        500: '#242c38',
      },
      accent: {
        cyan: '#00e5ff',
        'cyan-dim': '#00b8d4',
        'cyan-glow': 'rgba(0, 229, 255, 0.15)',
        emerald: '#00e676',
        amber: '#ffd740',
        rose: '#ff5252',
      },
    },
    fontFamily: {
      sans: '"DM Sans", system-ui, sans-serif',
      mono: '"JetBrains Mono", monospace',
    },
  },
  shortcuts: {
    // Glass-morphism card — gradient surface + soft border + radius 16.
    'glass-card': 'bg-gradient-to-br from-[rgba(19,24,31,0.8)] to-[rgba(12,16,21,0.95)] backdrop-blur-md border border-white/[0.06] rounded-2xl',
    // Subtle cyan glow used on featured surfaces (login card, primary buttons hover).
    'glow-cyan': 'shadow-[0_0_20px_rgba(0,229,255,0.1),0_0_60px_rgba(0,229,255,0.05)]',
    'glow-border': 'border border-[rgba(0,229,255,0.15)]',
    // Primary CTA — cyan gradient on dark text.
    'btn-primary': 'inline-flex items-center justify-center gap-1.5 bg-gradient-to-br from-[#00b8d4] to-[#00e5ff] text-surface-900 font-semibold rounded-[10px] px-6 py-3 text-sm tracking-[0.02em] transition-all hover:brightness-110 hover:shadow-[0_4px_16px_rgba(0,229,255,0.25)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:brightness-100 disabled:hover:shadow-none',
    // Ghost button — translucent slab with soft border.
    'btn-ghost': 'inline-flex items-center justify-center gap-1.5 bg-white/[0.04] text-[#b0bec5] font-medium rounded-[10px] px-5 py-2.5 text-[13px] border border-white/[0.08] transition-all hover:bg-white/[0.08] hover:border-white/[0.15] disabled:opacity-50 disabled:cursor-not-allowed',
    // Destructive — rose-themed ghost.
    'btn-danger': 'inline-flex items-center justify-center gap-1.5 bg-accent-rose/10 text-accent-rose font-medium rounded-[10px] px-5 py-2.5 text-[13px] border border-accent-rose/30 transition-all hover:bg-accent-rose/20 disabled:opacity-50 disabled:cursor-not-allowed',
  },
  transformers: [
    transformerDirectives(),
    transformerVariantGroup(),
  ],
  content: {
    pipeline: {
      include: [
        /\.(vue|html|[jt]sx?)($|\?)/,
        /\/@floway-dev\/ui\/src\/.*\.vue/,
      ],
    },
  },
});
