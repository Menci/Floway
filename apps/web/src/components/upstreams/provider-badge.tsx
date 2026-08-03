import { ServerRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import azureIconUrl from '../../assets/azure-color.svg?no-inline';
import claudeIconUrl from '../../assets/claude-color.svg?no-inline';
import githubCopilotIconUrl from '../../assets/githubcopilot.svg?no-inline';
import ollamaIconUrl from '../../assets/ollama.svg?no-inline';
import openaiIconUrl from '../../assets/openai.svg?no-inline';
import { fluentComponents } from '../../fluent';
import { badgeHueStyle } from '../../lib/color';
import { hueBadgeTone } from '../../lib/hue';
import { Chip } from '../ui/chip';
import { MaskedIcon } from '../ui/masked-icon';
import type { UpstreamProviderKind } from '@floway-dev/provider/model';

const { Tooltip, makeStyles } = fluentComponents;

const providerLabels: Record<UpstreamProviderKind, string> = {
  custom: 'Custom',
  azure: 'Azure',
  copilot: 'Copilot',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  ollama: 'Ollama',
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

export const providerLabel = (kind: UpstreamProviderKind) => providerLabels[kind];

// WinUI states no per-upstream identity colour, so the badge is ours. Only the
// operator's hue is picked: the wash, the outline and the label all come out of
// the one badge algorithm in lib/color.ts, which solves the label against the
// wash for 4.5:1 rather than it being chosen and then checked.
export function ProviderBadge({ label, title, upstream }: {
  label?: string;
  title?: string;
  // Null where a row names an upstream id the caller has nothing to render it
  // from, which leaves neither a provider to name nor a hue to paint. The
  // badge then carries no identity at all and reads as the neutral chip every
  // other piece of metadata is stated in.
  upstream: { hue: number; kind: UpstreamProviderKind } | null;
}) {
  const { t } = useTranslation();
  const visibleLabel = label
    ?? (upstream === null ? t('provider.unknown') : t(`provider.${upstream.kind}`, providerLabel(upstream.kind)));

  // A caller-supplied title describes the badge; the default is the clipped
  // label restored, which names it.
  return (
    <Tooltip content={title ?? visibleLabel} relationship={title === undefined ? 'label' : 'description'}>
      <Chip
        style={upstream === null ? undefined : badgeHueStyle(hueBadgeTone(upstream.hue))}
        icon={upstream === null ? undefined : <ProviderIcon kind={upstream.kind} className="h-4 w-4" />}
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
  kind: UpstreamProviderKind;
  className: string;
}) {
  const styles = useStyles();
  const baseClassName = `block flex-none ${className}`;
  if (kind === 'custom') return <ServerRegular className={baseClassName} />;
  return (
    <MaskedIcon
      className={`${className} ${styles.maskedGlyph}`}
      maskSize={providerIconMaskSizes[kind]}
      url={providerIconUrls[kind]}
    />
  );
}
