import { ServerRegular } from '@fluentui/react-icons';
import { useTranslation } from 'react-i18next';

import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '../../api/types';
import azureIconUrl from '../../assets/azure-color.svg';
import claudeIconUrl from '../../assets/claude-color.svg';
import codexIconUrl from '../../assets/codex.svg';
import githubCopilotIconUrl from '../../assets/githubcopilot.svg';
import ollamaIconUrl from '../../assets/ollama.svg';
import { fluentComponents } from '../../fluent';

const { makeStyles, Text } = fluentComponents;

type ProviderBadgeKind = UpstreamProviderKind | null;
type ProviderTone = UpstreamColorPreset | 'zinc';

const providerMeta: Record<UpstreamProviderKind, { label: string; tone: ProviderTone }> = {
  custom: { label: 'Custom', tone: 'amber' },
  azure: { label: 'Azure', tone: 'emerald' },
  copilot: { label: 'Copilot', tone: 'cyan' },
  codex: { label: 'Codex', tone: 'violet' },
  'claude-code': { label: 'Claude Code', tone: 'orange' },
  ollama: { label: 'Ollama', tone: 'rose' },
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
  monochromeIcon: {
    '@media (prefers-color-scheme: dark)': {
      filter: 'invert(1)',
    },
  },
});

export const providerLabel = (kind: ProviderBadgeKind) =>
  kind === null ? 'Unknown' : providerMeta[kind].label;

const customColorStyle = (color: `#${string}`) => ({
  '--provider-color': color,
  backgroundColor: 'color-mix(in srgb, var(--provider-color) 10%, transparent)',
  borderColor: 'color-mix(in srgb, var(--provider-color) 35%, transparent)',
  color: 'var(--provider-color)',
} as React.CSSProperties);

const isHexColor = (color: UpstreamColor | null): color is `#${string}` =>
  color?.startsWith('#') === true;

export function ProviderBadge({ color = null, kind }: { color?: UpstreamColor | null; kind: ProviderBadgeKind }) {
  const { t } = useTranslation();
  const styles = useStyles();
  const meta = kind === null ? { label: 'Unknown', tone: 'zinc' as const } : providerMeta[kind];
  const tone: ProviderTone = color && !isHexColor(color) ? color : meta.tone;
  const label = t(`provider.${kind ?? 'unknown'}`, meta.label);

  return (
    <span
      className={`${styles[tone]} inline-flex items-center gap-[5px] rounded-full border border-solid max-w-full min-h-[22px] py-0.5 px-2 whitespace-nowrap leading-[1.2]`}
      style={isHexColor(color) ? customColorStyle(color) : undefined}
      title={label}
    >
      <ProviderIcon kind={kind} className="h-[14px] w-[14px]" />
      <Text size={200} weight="semibold" truncate wrap={false} className="min-w-0">
        {label}
      </Text>
    </span>
  );
}

export function ProviderIcon({
  kind,
  className,
}: {
  kind: ProviderBadgeKind;
  className?: string;
}) {
  const styles = useStyles();
  const sizeClassName = className ?? 'h-[14px] w-[14px]';
  const baseClassName = `block flex-none ${sizeClassName}`;
  if (kind === 'custom') return <ServerRegular className={baseClassName} />;
  if (kind === 'azure') return <img alt="" src={azureIconUrl} className={baseClassName} />;
  if (kind === 'copilot') return <img alt="" src={githubCopilotIconUrl} className={`${styles.monochromeIcon} ${baseClassName}`} />;
  if (kind === 'codex') return <img alt="" src={codexIconUrl} className={baseClassName} />;
  if (kind === 'claude-code') return <img alt="" src={claudeIconUrl} className={baseClassName} />;
  if (kind === 'ollama') return <img alt="" src={ollamaIconUrl} className={`${styles.monochromeIcon} ${baseClassName}`} />;
  return null;
}
