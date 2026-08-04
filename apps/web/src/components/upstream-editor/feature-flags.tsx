import { EditorSection } from './section';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Dropdown } from '../ui/fluent-form-controls';
import { InlineMarkdown } from '../ui/markdown';
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
  'rewrite-mid-conv-system-to-user': 'apiCompatibility',
  'rewrite-developer-to-system': 'apiCompatibility',
  'rewrite-system-to-developer': 'apiCompatibility',
  'usage-exclusive-cached-tokens': 'apiCompatibility',
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

  // Deliberately not `SettingsCard`: a flag row carries a multi-paragraph
  // inline-markdown description, and the card's bordered, rounded, hover-lit
  // surface is more chrome than a list this long reads well with. These rows
  // are separated by a rule and nothing else.
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
    return <section className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-0 border-t border-solid border-fui-divider py-3 first:border-t-0" key={flagId}>
      <div className="grid gap-1 min-w-0">
        <Text weight="semibold">
          <InlineMarkdown>{label}</InlineMarkdown>
        </Text>
        <div className="grid gap-1">
          {/* A description separates its paragraphs with a single newline, which
              markdown reads as a soft break rather than a paragraph boundary, so
              the split is ours and each line is rendered as inline prose. */}
          {description.split('\n').map((line, i) => (
            <Text key={i} size={200} className="text-fui-fg2">
              <InlineMarkdown>{line}</InlineMarkdown>
            </Text>
          ))}
        </div>
      </div>
      <Dropdown
        aria-label={label}
        className="w-[140px]"
        readOnly={readOnly}
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
      <EditorSection key={group.id} level={3} title={t(`dashboard.upstreamEditor.flags.groups.${group.id}`)}>
        <div>
          {group.flags.map(renderFlag)}
        </div>
      </EditorSection>
    ))}
  </div>;
}
