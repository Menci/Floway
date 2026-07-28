import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';
import { Dropdown } from '../ui/fluent-form-controls';
import type { Flag, FlagDefaults, FlagOverrides } from '@floway-dev/provider/flags';

const { Option, Text } = fluentComponents;

type FlagGroupId = 'vendor' | 'shims' | 'apiCompatibility' | 'sanitization' | 'retry';

const flagGroups: readonly { id: FlagGroupId; flagIds: readonly string[] }[] = [
  {
    id: 'vendor',
    flagIds: ['vendor-deepseek', 'vendor-qwen', 'vendor-kimi'],
  },
  {
    id: 'shims',
    flagIds: [
      'messages-web-search-shim',
      'responses-web-search-shim',
      'responses-image-generation-shim',
      'responses-compact-shim',
    ],
  },
  {
    id: 'apiCompatibility',
    flagIds: [
      'disable-reasoning-on-forced-tool-choice',
      'demote-interleaved-system-to-user',
      'demote-developer-to-system',
      'promote-system-to-developer',
    ],
  },
  {
    id: 'sanitization',
    flagIds: ['strip-billing-attribution', 'strip-prompt-cache-key'],
  },
  {
    id: 'retry',
    flagIds: ['retry-cyber-policy'],
  },
];

export function FeatureFlagsEditor({
  defaults,
  flags,
  inherited,
  onChange,
  readOnly = false,
  value,
}: {
  defaults: FlagDefaults;
  flags: Flag[];
  inherited?: FlagOverrides;
  onChange: (value: FlagOverrides) => void;
  readOnly?: boolean;
  value: FlagOverrides;
}) {
  const { i18n, t } = useTranslation();
  const setState = (id: string, state: 'inherit' | 'on' | 'off') => {
    const next = { ...value } as Record<string, boolean>;
    if (state === 'inherit') delete next[id]; else next[id] = state === 'on';
    onChange(next);
  };
  const inheritedValue = (id: string) => inherited?.[id as keyof FlagOverrides] ?? defaults[id as keyof FlagDefaults] ?? false;
  const knownIds = new Set(flagGroups.flatMap(group => group.flagIds));
  const groupedFlags = flagGroups.map(group => ({
    ...group,
    flags: flags.filter(flag => group.flagIds.includes(flag.id)),
  }));
  const otherFlags = flags.filter(flag => !knownIds.has(flag.id));

  const renderFlag = (flag: Flag) => {
    const state = flag.id in value ? (value[flag.id as keyof FlagOverrides] ? 'on' : 'off') : 'inherit';
    const inheritedState = inheritedValue(flag.id) ? 'on' : 'off';
    const stateLabel = state === 'inherit'
      ? t('dashboard.upstreamEditor.flags.inheritResolved', {
          state: t(`dashboard.upstreamEditor.flags.${inheritedState}`),
        })
      : t(`dashboard.upstreamEditor.flags.${state}`);
    const labelKey = `dashboard.upstreamEditor.flags.entries.${flag.id}.label`;
    const descKey = `dashboard.upstreamEditor.flags.entries.${flag.id}.description`;
    const desc = i18n.exists(descKey) ? t(descKey) : flag.description;
    return <section className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-t border-t-solid border-fui-stroke1 px-4 py-3 first:border-t-0" key={flag.id}>
      <div className="grid gap-1 min-w-0">
        <Text weight="semibold">
          <InlineMarkdown>{i18n.exists(labelKey) ? t(labelKey) : flag.label}</InlineMarkdown>
        </Text>
        <div className="grid gap-1">
          {desc.split('\n').map((line, i) => (
            <Text key={i} size={200} className="text-fui-fg2 leading-[1.4]">
              <InlineMarkdown>{line}</InlineMarkdown>
            </Text>
          ))}
        </div>
      </div>
      <Dropdown
        aria-label={flag.label}
        className="w-[140px] !min-w-[140px]"
        disabled={readOnly}
        selectedOptions={[state]}
        value={stateLabel}
        onOptionSelect={(_, data) => {
          if (data.optionValue) setState(flag.id, data.optionValue as 'inherit' | 'on' | 'off');
        }}
      >
        <Option value="inherit">
          {t('dashboard.upstreamEditor.flags.inheritResolved', {
            state: t(`dashboard.upstreamEditor.flags.${inheritedState}`),
          })}
        </Option>
        <Option value="on">{t('dashboard.upstreamEditor.flags.on')}</Option>
        <Option value="off">{t('dashboard.upstreamEditor.flags.off')}</Option>
      </Dropdown>
    </section>;
  };

  return <div className="grid gap-5 min-w-0">
    {groupedFlags.filter(group => group.flags.length > 0).map(group => (
      <section className="grid gap-2" key={group.id}>
        <Text as="h2" size={300} weight="semibold" className="!m-0 px-1">
          {t(`dashboard.upstreamEditor.flags.groups.${group.id}`)}
        </Text>
        <div>
          {group.flags.map(renderFlag)}
        </div>
      </section>
    ))}
    {otherFlags.length > 0 && (
      <section className="grid gap-2">
        <Text as="h2" size={300} weight="semibold" className="!m-0 px-1">
          {t('dashboard.upstreamEditor.flags.groups.other')}
        </Text>
        <div>
          {otherFlags.map(renderFlag)}
        </div>
      </section>
    )}
  </div>;
}

function InlineMarkdown({ children }: { children: string }) {
  return <>{parseInlineMarkdown(children)}</>;
}

function parseInlineMarkdown(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);
  return tokens.filter(Boolean).map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code
          className="rounded bg-fui-bg1 px-1 py-0.5 font-mono text-[0.92em] text-fui-fg1"
          key={index}
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={index}>{parseInlineMarkdown(token.slice(2, -2))}</strong>;
    }
    if (token.startsWith('*') && token.endsWith('*')) {
      return <em key={index}>{parseInlineMarkdown(token.slice(1, -1))}</em>;
    }
    return token;
  });
}
