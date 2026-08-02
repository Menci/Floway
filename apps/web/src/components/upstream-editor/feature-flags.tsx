import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { fluentComponents } from '../../fluent';
import { Dropdown } from '../ui/fluent-form-controls';
import { SectionHeader } from '../ui/section-header';
import { OPTIONAL_FLAG_IDS, type FlagDefaults, type FlagId, type FlagOverrides } from '@floway-dev/provider/flags';

const { Option, Text } = fluentComponents;

type FlagGroupId = 'vendor' | 'shims' | 'apiCompatibility' | 'sanitization';

const flagGroupOrder: readonly FlagGroupId[] = ['vendor', 'shims', 'apiCompatibility', 'sanitization'];

const flagGroupById = {
  'vendor-deepseek': 'vendor',
  'vendor-qwen': 'vendor',
  'vendor-kimi': 'vendor',
  'messages-web-search-shim': 'shims',
  'responses-web-search-shim': 'shims',
  'responses-image-generation-shim': 'shims',
  'responses-compact-shim': 'shims',
  'disable-reasoning-on-forced-tool-choice': 'apiCompatibility',
  'demote-interleaved-system-to-user': 'apiCompatibility',
  'demote-developer-to-system': 'apiCompatibility',
  'promote-system-to-developer': 'apiCompatibility',
  'strip-billing-attribution': 'sanitization',
  'strip-prompt-cache-key': 'sanitization',
} as const satisfies Record<FlagId, FlagGroupId>;

export function FeatureFlagsEditor({
  defaults,
  inherited,
  onChange,
  readOnly = false,
  value,
}: {
  defaults: FlagDefaults;
  inherited?: FlagOverrides;
  onChange: (value: FlagOverrides) => void;
  readOnly?: boolean;
  value: FlagOverrides;
}) {
  const { t } = useTranslation();
  const setState = (id: string, state: 'inherit' | 'on' | 'off') => {
    const next = { ...value } as Record<string, boolean>;
    if (state === 'inherit') delete next[id]; else next[id] = state === 'on';
    onChange(next);
  };
  const inheritedValue = (id: string) => inherited?.[id as keyof FlagOverrides] ?? defaults[id as keyof FlagDefaults] ?? false;
  const groupedFlags = flagGroupOrder.map(id => ({
    id,
    flags: OPTIONAL_FLAG_IDS.filter(flagId => flagGroupById[flagId] === id),
  }));

  const renderFlag = (flagId: FlagId) => {
    const state = flagId in value ? (value[flagId] ? 'on' : 'off') : 'inherit';
    const inheritedState = inheritedValue(flagId) ? 'on' : 'off';
    const stateLabel = state === 'inherit'
      ? t('dashboard.upstreamEditor.flags.inheritResolved', {
          state: t(`dashboard.upstreamEditor.flags.${inheritedState}`),
        })
      : t(`dashboard.upstreamEditor.flags.${state}`);
    const label = t(`dashboard.upstreamEditor.flags.entries.${flagId}.label`);
    const description = t(`dashboard.upstreamEditor.flags.entries.${flagId}.description`);
    return <section className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-0 border-t border-solid border-fui-stroke1 py-3 first:border-t-0" key={flagId}>
      <div className="grid gap-1 min-w-0">
        <Text weight="semibold">
          <InlineMarkdown>{label}</InlineMarkdown>
        </Text>
        <div className="grid gap-1">
          {description.split('\n').map((line, i) => (
            <Text key={i} size={200} className="text-fui-fg2 leading-[1.4]">
              <InlineMarkdown>{line}</InlineMarkdown>
            </Text>
          ))}
        </div>
      </div>
      <Dropdown
        aria-label={label}
        className="w-[140px]"
        disabled={readOnly}
        selectedOptions={[state]}
        value={stateLabel}
        onOptionSelect={(_, data) => {
          if (data.optionValue) setState(flagId, data.optionValue as 'inherit' | 'on' | 'off');
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
    {groupedFlags.map(group => (
      <section className="grid gap-2" key={group.id}>
        <SectionHeader level={3} title={t(`dashboard.upstreamEditor.flags.groups.${group.id}`)} />
        <div>
          {group.flags.map(renderFlag)}
        </div>
      </section>
    ))}
  </div>;
}

function InlineMarkdown({ children }: { children: string }) {
  return <>{parseInlineMarkdown(children)}</>;
}

const parseInlineMarkdown = (text: string): ReactNode[] => {
  const tokens = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);
  return tokens.filter(Boolean).map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code key={index}>
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
};
