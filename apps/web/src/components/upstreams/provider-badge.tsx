import { ServerRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import azureIconUrl from '../../assets/azure-color.svg?no-inline';
import claudeIconUrl from '../../assets/claude-color.svg?no-inline';
import githubCopilotIconUrl from '../../assets/githubcopilot.svg?no-inline';
import ollamaIconUrl from '../../assets/ollama.svg?no-inline';
import openaiIconUrl from '../../assets/openai.svg?no-inline';
import { fluentComponents } from '../../fluent';
import { badgeHueStyle, isHexColor, type BadgeHue } from '../../lib/color';
import { Chip } from '../ui/chip';
import { MaskedIcon } from '../ui/masked-icon';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '@floway-dev/provider/model';

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

// WinUI states no per-upstream identity colour, so these hues are ours. Only the
// hue is: the wash, the outline and the label all come out of the one badge
// algorithm in lib/color.ts, which solves the label against the wash for 4.5:1
// instead of it being picked and checked. An operator-typed colour enters the
// same way, so a preset and a hand-typed hue cannot paint by different rules.
const PROVIDER_HUES: Record<ProviderTone, BadgeHue> = {
  amber: { light: '#8a4b00', dark: '#f5c778' },
  emerald: { light: '#0f6c4f', dark: '#7cd9b2' },
  cyan: { light: '#006b75', dark: '#79d7df' },
  violet: { light: '#5b2e91', dark: '#cbb6f4' },
  rose: { light: '#9f1d35', dark: '#f2a1b4' },
  orange: { light: '#b14f2f', dark: '#f3ad8f' },
  zinc: { light: '#616161', dark: '#d6d6d6' },
};

const useStyles = makeStyles({
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
        style={badgeHueStyle(isHexColor(color) ? color : PROVIDER_HUES[tone])}
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
