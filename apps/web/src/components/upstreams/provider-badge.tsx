import type { TagProps } from '@fluentui/react-components';
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

// Our own palette; WinUI states no per-upstream identity colour. Each tone
// states all three values per scheme, because a single literal would have been
// picked against whichever scheme its author was in. Every label clears 4.5:1
// against its own fill, the floor lib/color.ts holds an operator-typed hue to.
const useStyles = makeStyles({
  amber: {
    backgroundColor: 'light-dark(#fff8f0, #4d2d0a)',
    borderTopColor: 'light-dark(#d69b52, #8f642d)',
    borderRightColor: 'light-dark(#d69b52, #8f642d)',
    borderBottomColor: 'light-dark(#d69b52, #8f642d)',
    borderLeftColor: 'light-dark(#d69b52, #8f642d)',
    color: 'light-dark(#8a4b00, #f5c778)',
  } as any,
  emerald: {
    backgroundColor: 'light-dark(#f0faf5, #103d30)',
    borderTopColor: 'light-dark(#5da98b, #397c65)',
    borderRightColor: 'light-dark(#5da98b, #397c65)',
    borderBottomColor: 'light-dark(#5da98b, #397c65)',
    borderLeftColor: 'light-dark(#5da98b, #397c65)',
    color: 'light-dark(#0f6c4f, #7cd9b2)',
  } as any,
  cyan: {
    backgroundColor: 'light-dark(#eff9fb, #103b42)',
    borderTopColor: 'light-dark(#58aeb8, #347b84)',
    borderRightColor: 'light-dark(#58aeb8, #347b84)',
    borderBottomColor: 'light-dark(#58aeb8, #347b84)',
    borderLeftColor: 'light-dark(#58aeb8, #347b84)',
    color: 'light-dark(#006b75, #79d7df)',
  } as any,
  violet: {
    backgroundColor: 'light-dark(#f7f3ff, #342453)',
    borderTopColor: 'light-dark(#9a7bc2, #705b94)',
    borderRightColor: 'light-dark(#9a7bc2, #705b94)',
    borderBottomColor: 'light-dark(#9a7bc2, #705b94)',
    borderLeftColor: 'light-dark(#9a7bc2, #705b94)',
    color: 'light-dark(#5b2e91, #cbb6f4)',
  } as any,
  rose: {
    backgroundColor: 'light-dark(#fff3f5, #4b202b)',
    borderTopColor: 'light-dark(#cf7187, #8a4b5a)',
    borderRightColor: 'light-dark(#cf7187, #8a4b5a)',
    borderBottomColor: 'light-dark(#cf7187, #8a4b5a)',
    borderLeftColor: 'light-dark(#cf7187, #8a4b5a)',
    color: 'light-dark(#9f1d35, #f2a1b4)',
  } as any,
  orange: {
    backgroundColor: 'light-dark(#fff4ef, #4b291d)',
    borderTopColor: 'light-dark(#d17e60, #8d5944)',
    borderRightColor: 'light-dark(#d17e60, #8d5944)',
    borderBottomColor: 'light-dark(#d17e60, #8d5944)',
    borderLeftColor: 'light-dark(#d17e60, #8d5944)',
    color: 'light-dark(#b14f2f, #f3ad8f)',
  } as any,
  zinc: {
    backgroundColor: 'light-dark(#f5f5f5, #303030)',
    borderTopColor: 'light-dark(#a8a8a8, #666666)',
    borderRightColor: 'light-dark(#a8a8a8, #666666)',
    borderBottomColor: 'light-dark(#a8a8a8, #666666)',
    borderLeftColor: 'light-dark(#a8a8a8, #666666)',
    color: 'light-dark(#616161, #d6d6d6)',
  } as any,
  // A mask over a background-color would disappear under forced colours, where
  // the canvas replaces that fill. Opting the mask box out keeps its declared
  // `currentColor`, already resolved to the system text colour by the chip.
  // https://drafts.csswg.org/css-color-adjust-1/#forced-colors-properties
  maskedGlyph: {
    '@media (forced-colors: active)': {
      forcedColorAdjust: 'none',
    },
  },
});

export const providerLabel = (kind: ProviderBadgeKind) =>
  kind === null ? 'Unknown' : providerLabels[kind];

// An operator-typed colour is one literal for both schemes, so it is composited
// in lib/color.ts instead of taking a preset's per-scheme values; the proxy
// badge paints the same way from its own palette.
export function ProviderBadge({ color, kind, label, size = 'small', title }: {
  color: UpstreamColor | null;
  kind: ProviderBadgeKind;
  label?: string;
  size?: TagProps['size'];
  title?: string;
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const tone: ProviderTone = color && !isHexColor(color)
    ? color
    : kind === null ? 'zinc' : KIND_DEFAULT_TONES[kind];
  const providerName = t(`provider.${kind ?? 'unknown'}`, providerLabel(kind));
  const visibleLabel = label ?? providerName;

  // A caller-supplied title states more than the chip shows, so it describes
  // the badge; the default is the clipped label restored, which names it.
  return (
    <Tooltip content={title ?? visibleLabel} relationship={title === undefined ? 'label' : 'description'}>
      <Chip
        className={styles[tone]}
        style={isHexColor(color) ? badgeHueStyle(color) : undefined}
        icon={<ProviderIcon kind={kind} className={size === 'extra-small' ? 'h-3 w-3' : 'h-4 w-4'} />}
        size={size}
      >
        {visibleLabel}
      </Chip>
    </Tooltip>
  );
}

// Imported with `?no-inline` because Vite inlines an asset under 4 KB as a
// data URI, and an unquoted `url(data:image/svg+xml,<svg …>)` is not a valid
// CSS value — the whole mask-image declaration is dropped and the mask box
// paints as a solid block.
// https://github.com/vitejs/vite/blob/5e7fe129a4dde4f41934083b25e490059985f4e6/docs/guide/assets.md#explicit-url-imports
//
// Each mark is painted as a silhouette in the surrounding text color so the
// console keeps one iconographic voice; masking preserves negative space
// (Copilot's eyes, Ollama's outline) that a flat recolor would fill in.
const providerIconUrls: Record<Exclude<UpstreamProviderKind, 'custom'>, string> = {
  azure: azureIconUrl,
  copilot: githubCopilotIconUrl,
  // Codex is the ChatGPT subscription, so it wears OpenAI's mark.
  codex: openaiIconUrl,
  'claude-code': claudeIconUrl,
  ollama: ollamaIconUrl,
};

// ServerRegular paints 16px high inside its 20px box. These source-specific
// scales normalize every vendor silhouette to that optical height even though
// all source SVGs declare the same 24×24 viewBox.
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
