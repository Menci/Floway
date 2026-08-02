import { ServerRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types';
import azureIconUrl from '../../assets/azure-color.svg?no-inline';
import claudeIconUrl from '../../assets/claude-color.svg?no-inline';
import githubCopilotIconUrl from '../../assets/githubcopilot.svg?no-inline';
import ollamaIconUrl from '../../assets/ollama.svg?no-inline';
import openaiIconUrl from '../../assets/openai.svg?no-inline';
import { fluentComponents } from '../../fluent';
import { badgeHueStyle, isHexColor } from '../../lib/color';
import { Chip } from '../ui/chip';
import { MaskedIcon } from '../ui/masked-icon';

const { Tooltip, makeStyles } = fluentComponents;

type ProviderBadgeKind = UpstreamProviderKind | null;
type ProviderTone = UpstreamColorPreset | 'zinc';

const providerLabels: Record<UpstreamProviderKind, string> = {
  custom: 'Custom',
  azure: 'Azure',
  copilot: 'Copilot',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  ollama: 'Ollama',
};

export const KIND_DEFAULT_TONES: Record<UpstreamProviderKind, UpstreamColorPreset> = {
  custom: 'amber',
  azure: 'emerald',
  copilot: 'cyan',
  codex: 'violet',
  'claude-code': 'orange',
  ollama: 'rose',
};

// WinUI states no per-upstream identity colour, so this palette is ours. Every
// label clears 4.5:1 against its own fill — the floor lib/color.ts holds an
// operator-typed hue to.
//
// The stroke is published under a name the WinUI layer reads, because the layer
// flattens a chip's stroke under a press the way Button does and an identity
// colour has to outlive that.
//
// It is then spelled one edge at a time, because Fluent states the chip's own
// stroke that way and a shorthand against a longhand at equal specificity is
// decided by which sheet was written last -- which neither side can see, and
// which differs between the rest state and the pressed one.
const useStyles = makeStyles({
  amber: {
    backgroundColor: 'light-dark(#fff8f0, #4d2d0a)',
    '--floway-chip-stroke': 'light-dark(#d69b52, #8f642d)',
    borderTopColor: 'var(--floway-chip-stroke)',
    borderRightColor: 'var(--floway-chip-stroke)',
    borderBottomColor: 'var(--floway-chip-stroke)',
    borderLeftColor: 'var(--floway-chip-stroke)',
    color: 'light-dark(#8a4b00, #f5c778)',
  } as any,
  emerald: {
    backgroundColor: 'light-dark(#f0faf5, #103d30)',
    '--floway-chip-stroke': 'light-dark(#5da98b, #397c65)',
    borderTopColor: 'var(--floway-chip-stroke)',
    borderRightColor: 'var(--floway-chip-stroke)',
    borderBottomColor: 'var(--floway-chip-stroke)',
    borderLeftColor: 'var(--floway-chip-stroke)',
    color: 'light-dark(#0f6c4f, #7cd9b2)',
  } as any,
  cyan: {
    backgroundColor: 'light-dark(#eff9fb, #103b42)',
    '--floway-chip-stroke': 'light-dark(#58aeb8, #347b84)',
    borderTopColor: 'var(--floway-chip-stroke)',
    borderRightColor: 'var(--floway-chip-stroke)',
    borderBottomColor: 'var(--floway-chip-stroke)',
    borderLeftColor: 'var(--floway-chip-stroke)',
    color: 'light-dark(#006b75, #79d7df)',
  } as any,
  violet: {
    backgroundColor: 'light-dark(#f7f3ff, #342453)',
    '--floway-chip-stroke': 'light-dark(#9a7bc2, #705b94)',
    borderTopColor: 'var(--floway-chip-stroke)',
    borderRightColor: 'var(--floway-chip-stroke)',
    borderBottomColor: 'var(--floway-chip-stroke)',
    borderLeftColor: 'var(--floway-chip-stroke)',
    color: 'light-dark(#5b2e91, #cbb6f4)',
  } as any,
  rose: {
    backgroundColor: 'light-dark(#fff3f5, #4b202b)',
    '--floway-chip-stroke': 'light-dark(#cf7187, #8a4b5a)',
    borderTopColor: 'var(--floway-chip-stroke)',
    borderRightColor: 'var(--floway-chip-stroke)',
    borderBottomColor: 'var(--floway-chip-stroke)',
    borderLeftColor: 'var(--floway-chip-stroke)',
    color: 'light-dark(#9f1d35, #f2a1b4)',
  } as any,
  orange: {
    backgroundColor: 'light-dark(#fff4ef, #4b291d)',
    '--floway-chip-stroke': 'light-dark(#d17e60, #8d5944)',
    borderTopColor: 'var(--floway-chip-stroke)',
    borderRightColor: 'var(--floway-chip-stroke)',
    borderBottomColor: 'var(--floway-chip-stroke)',
    borderLeftColor: 'var(--floway-chip-stroke)',
    color: 'light-dark(#b14f2f, #f3ad8f)',
  } as any,
  zinc: {
    backgroundColor: 'light-dark(#f5f5f5, #303030)',
    '--floway-chip-stroke': 'light-dark(#a8a8a8, #666666)',
    borderTopColor: 'var(--floway-chip-stroke)',
    borderRightColor: 'var(--floway-chip-stroke)',
    borderBottomColor: 'var(--floway-chip-stroke)',
    borderLeftColor: 'var(--floway-chip-stroke)',
    color: 'light-dark(#616161, #d6d6d6)',
  } as any,
  // A mask over a background-color disappears under forced colours; opting the
  // mask box out keeps the `currentColor` the chip already resolved.
  // https://drafts.csswg.org/css-color-adjust-1/#forced-colors-properties
  maskedGlyph: {
    '@media (forced-colors: active)': {
      forcedColorAdjust: 'none',
    },
  },
});

export const providerLabel = (kind: ProviderBadgeKind) =>
  kind === null ? 'Unknown' : providerLabels[kind];

// An operator-typed colour is one literal for both schemes, so lib/color.ts
// composites it instead of taking a preset's per-scheme values.
export function ProviderBadge({ color, kind, label, title }: {
  color: UpstreamColor | null;
  kind: ProviderBadgeKind;
  label?: string;
  title?: string;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const tone: ProviderTone = color && !isHexColor(color)
    ? color
    : kind === null ? 'zinc' : KIND_DEFAULT_TONES[kind];
  const providerName = t(`provider.${kind ?? 'unknown'}`, providerLabel(kind));
  const visibleLabel = label ?? providerName;

  // A caller-supplied title describes the badge; the default is the clipped
  // label restored, which names it.
  return (
    <Tooltip content={title ?? visibleLabel} relationship={title === undefined ? 'label' : 'description'}>
      <Chip
        className={styles[tone]}
        style={isHexColor(color) ? badgeHueStyle(color) : undefined}
        icon={<ProviderIcon kind={kind} className="h-4 w-4" />}
      >
        {visibleLabel}
      </Chip>
    </Tooltip>
  );
}

// `?no-inline` because Vite inlines an asset under 4 KB as a data URI, and an
// unquoted `url(data:image/svg+xml,<svg …>)` is not a valid CSS value — the
// mask-image declaration is dropped and the mask box paints as a solid block.
// https://github.com/vitejs/vite/blob/5e7fe129a4dde4f41934083b25e490059985f4e6/docs/guide/assets.md#explicit-url-imports
const providerIconUrls: Record<Exclude<UpstreamProviderKind, 'custom'>, string> = {
  azure: azureIconUrl,
  copilot: githubCopilotIconUrl,
  // Codex is the ChatGPT subscription, so it wears OpenAI's mark.
  codex: openaiIconUrl,
  'claude-code': claudeIconUrl,
  ollama: ollamaIconUrl,
};

// The source SVGs share a 24×24 viewBox but not optical weight; these scales
// normalize each silhouette to ServerRegular's 16px height inside a 20px box.
const providerIconMaskSizes: Record<Exclude<UpstreamProviderKind, 'custom'>, string> = {
  azure: '85% 85%',
  copilot: '100% 100%',
  codex: '80% 80%',
  'claude-code': '80% 80%',
  ollama: '86% 86%',
};

export function ProviderIcon({
  kind,
  className,
}: {
  kind: ProviderBadgeKind;
  className: string;
}) {
  const styles = useStyles();
  const baseClassName = `block flex-none ${className}`;
  if (kind === null) return null;
  if (kind === 'custom') return <ServerRegular className={baseClassName} />;
  return (
    <MaskedIcon
      className={`${className} ${styles.maskedGlyph}`}
      maskSize={providerIconMaskSizes[kind]}
      url={providerIconUrls[kind]}
    />
  );
}
