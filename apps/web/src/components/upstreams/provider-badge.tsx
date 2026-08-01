import type { TagProps } from '@fluentui/react-components';
import { ServerRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import { KIND_DEFAULT_TONES } from './upstream-paint';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types';
import azureIconUrl from '../../assets/azure-color.svg?no-inline';
import claudeIconUrl from '../../assets/claude-color.svg?no-inline';
import githubCopilotIconUrl from '../../assets/githubcopilot.svg?no-inline';
import ollamaIconUrl from '../../assets/ollama.svg?no-inline';
import openaiIconUrl from '../../assets/openai.svg?no-inline';
import { fluentComponents } from '../../fluent';
import { blendHex, isHexColor, readableTone } from '../../lib/color';
import { Chip } from '../ui/chip';
import { MaskedIcon } from '../ui/masked-icon';

const { Tooltip, makeStyles, tokens } = fluentComponents;

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
  // The tone classes paint the identity color; the chip supplies geometry.
  tagText: {
    fontSize: '12px',
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: '16px',
  },
});

export const providerLabel = (kind: ProviderBadgeKind) =>
  kind === null ? 'Unknown' : providerLabels[kind];

// A preset tone states a foreground per scheme; a colour the operator typed
// states one literal for both, and that literal was picked against whichever
// scheme they were in. Used raw it labels a chip on a near-white card and on a
// near-black one alike. The fill needs no such treatment: it is 10% of the hue,
// so it composites over whichever surface is beneath and follows the scheme on
// its own.
//
// The label is resolved against that composited fill rather than against the
// card, because the fill is the colour actually behind the glyph and a 10% wash
// of the hue moves the reading by enough to change the answer: a mid magenta
// clears the floor against bare white at 4.64:1, and against its own chip reads
// 4.03:1 in light and 2.41:1 in dark.
//
// The card is `--winui-solid-background-fill-quarternary` under the card fill
// the surface paints over it: in dark that is #ffffff0d over #2c2c2c, which
// composites to #373737, and in light both resolve to #ffffff.
const CARD_SURFACE = { light: '#FFFFFF', dark: '#373737' } as const;
const FILL_ALPHA = 0.1;

const customColorStyle = (color: `#${string}`) => {
  const label = (surface: string) => readableTone(color, blendHex(color, FILL_ALPHA, surface));
  return {
    '--provider-color': color,
    backgroundColor: `color-mix(in srgb, var(--provider-color) ${FILL_ALPHA * 100}%, transparent)`,
    borderColor: 'color-mix(in srgb, var(--provider-color) 35%, transparent)',
    color: `light-dark(${label(CARD_SURFACE.light)}, ${label(CARD_SURFACE.dark)})`,
  } as React.CSSProperties;
};

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

  // A caller-supplied title states more than the chip shows -- the kind and the
  // upstream id behind a display name -- so it describes the badge. The default
  // is the label itself, restored for a reader whose column clipped it, and
  // that is the badge's name rather than an addition to it.
  return (
    <Tooltip content={title ?? visibleLabel} relationship={title === undefined ? 'label' : 'description'}>
      <Chip
        className={styles[tone]}
        style={isHexColor(color) ? customColorStyle(color) : undefined}
        icon={<ProviderIcon kind={kind} className={size === 'extra-small' ? 'h-3 w-3' : 'h-4 w-4'} />}
        size={size}
        textClassName={styles.tagText}
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
// Vendor marks ship in their brand colors, and several carry gradients or a
// white knockout that only reads on the vendor's own background. The console
// wants one iconographic voice, so each mark is painted as a silhouette in
// the surrounding text color: inside a provider chip it picks up the identity
// tone, in a menu it is plain foreground, and dark mode needs no inversion.
// Masking keeps the negative space (Copilot's eyes, Ollama's outline) that a
// flat recolor would fill in.
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
  const baseClassName = `block flex-none ${className}`;
  if (kind === null) return null;
  if (kind === 'custom') return <ServerRegular className={baseClassName} />;
  return <MaskedIcon className={className} maskSize={providerIconMaskSizes[kind]} url={providerIconUrls[kind]} />;
}
