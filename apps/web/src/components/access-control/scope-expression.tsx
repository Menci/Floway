import { BracesRegular, CodeRegular, CubeRegular, DismissRegular, PeopleRegular, PersonRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';

import type { ControlPlaneGroup, ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { Combobox } from '../ui/fluent-form-controls';
import { highlight } from '../ui/prism';
import { ProviderBadge } from '../upstreams/provider-badge';
import type { AccessScope } from '@floway-dev/gateway/browser';

const { Option, Tooltip } = fluentComponents;

type Part = 'kind' | 'instance' | 'model';
type ScopeKind = 'upstream' | 'user' | 'group';

export interface ScopeExpressionData {
  groups: ControlPlaneGroup[];
  models: ControlPlaneModel[];
  upstreams: UpstreamOption[];
  users: ControlPlaneUser[];
}

export function ScopeExpression({ data, onChange, readOnly = false, value }: {
  data: ScopeExpressionData;
  onChange?: (value: AccessScope | null) => void;
  readOnly?: boolean;
  value: AccessScope | null;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<Part | null>(null);
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingKind, setPendingKind] = useState<ScopeKind | null>(null);
  const kind = pendingKind ?? kindFor(value);

  const activate = (part: Part) => {
    if (readOnly) return;
    setActive(part);
    setDirty(false);
    setQuery(partValue(part, value, data, t));
  };
  const commit = (part: Part, option: string) => {
    if (part === 'kind') {
      const nextKind = option as ScopeKind;
      setPendingKind(nextKind);
      onChange?.(nextKind === 'upstream' ? { kind: 'upstreams' } : nextKind === 'user' ? { kind: 'users' } : null);
    } else if (part === 'instance') {
      if (kind === 'upstream') onChange?.({ kind: 'upstream', upstreamId: option });
      else if (kind === 'user') onChange?.({ kind: 'user', userId: Number(option) });
      else if (kind === 'group') onChange?.({ kind: 'group', groupId: Number(option) });
    } else if (kind === 'upstream' && value?.kind === 'upstream') {
      const [patternKind, pattern] = option.startsWith('regex:') ? ['regex', option.slice(6)] as const : ['exact', option.slice(6)] as const;
      onChange?.({ kind: 'upstreamModel', upstreamId: value.upstreamId, model: { kind: patternKind, value: pattern } });
    } else if (kind === 'upstream' && value?.kind === 'upstreamModel') {
      const [patternKind, pattern] = option.startsWith('regex:') ? ['regex', option.slice(6)] as const : ['exact', option.slice(6)] as const;
      onChange?.({ ...value, model: { kind: patternKind, value: pattern } });
    }
    setPendingKind(null);
    setActive(null);
    setQuery('');
  };
  const commitFreeform = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (active === 'instance' && kind === 'upstream') commit('instance', trimmed);
    else if (active === 'model') commit('model', `exact:${trimmed}`);
  };

  const options = useMemo(
    () => optionsFor(active, kind, query, dirty, value, data, t),
    [active, data, dirty, kind, query, t, value],
  );

  return (
    <div className="floway-scope-expression">
      <span className="floway-scope-expression-slash">/</span>
      {active === 'kind'
        ? <PartInput ariaLabel={t('dashboard.accessControl.scope.kind')} onBlur={commitFreeform} onChange={value => { setDirty(true); setQuery(value); }} onSelect={value => commit('kind', value)} options={options} query={query} />
        : kind
          ? <button className="floway-scope-expression-part" disabled={readOnly} onClick={() => activate('kind')} type="button">{kindLabel(kind, t)}</button>
          : <button className="floway-scope-expression-part floway-scope-expression-dimmed" disabled={readOnly} onClick={() => activate('kind')} type="button">{t('dashboard.accessControl.scope.select')}</button>}

      {kind !== null && (
        <>
          <span className="floway-scope-expression-slash">/</span>
          {active === 'instance'
            ? <PartInput ariaLabel={t('dashboard.accessControl.scope.instance')} onBlur={commitFreeform} onChange={value => { setDirty(true); setQuery(value); }} onSelect={value => commit('instance', value)} options={options} query={query} />
            : <InstancePart data={data} kind={kind} onActivate={() => activate('instance')} readOnly={readOnly} t={t} value={value} />}
        </>
      )}

      {kind === 'upstream' && hasUpstreamInstance(value) && (
        <>
          <span className="floway-scope-expression-slash">/</span>
          {active === 'model'
            ? <PartInput ariaLabel={t('dashboard.accessControl.scope.model')} onBlur={commitFreeform} onChange={value => { setDirty(true); setQuery(value.replace(/^\//, '').replace(/\/$/, '')); }} onSelect={value => commit('model', value)} options={options} query={query} />
            : value.kind === 'upstreamModel'
              ? <button className="floway-scope-expression-part floway-scope-expression-mono" disabled={readOnly} onClick={() => activate('model')} type="button"><CubeRegular />{patternLabel(value)}</button>
              : <button className="floway-scope-expression-part floway-scope-expression-dimmed" disabled={readOnly} onClick={() => activate('model')} type="button">{t('dashboard.accessControl.scope.model')}</button>}
        </>
      )}
    </div>
  );
}

function PartInput({ ariaLabel, onBlur, onChange, onSelect, options, query }: {
  ariaLabel: string;
  onBlur: () => void;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  options: ScopeOption[];
  query: string;
}) {
  return <Combobox
    aria-label={ariaLabel}
    autoFocus
    className="floway-scope-expression-input"
    freeform
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) onBlur(); }}
    onChange={event => onChange(event.target.value)}
    open
    onOptionSelect={(_, option) => option.optionValue && onSelect(option.optionValue)}
    value={query}
  >
    {options.map(option => <Option key={option.key} text={option.text} value={option.value}>
      <span className={option.dimmed ? 'floway-scope-expression-dimmed' : undefined}>{option.content}</span>
    </Option>)}
  </Combobox>;
}

interface ScopeOption { key: string; value: string; text: string; content: React.ReactNode; dimmed?: boolean }

const optionsFor = (
  active: Part | null,
  kind: ScopeKind | null,
  query: string,
  dirty: boolean,
  value: AccessScope | null,
  data: ScopeExpressionData,
  t: TFunction,
): ScopeOption[] => {
  const needle = query.toLowerCase();
  let options: ScopeOption[] = [];
  if (active === 'kind') {
    options = (['user', 'upstream', 'group'] as const)
      .map(candidate => {
        const label = kindLabel(candidate, t);
        return { key: candidate, value: candidate, text: label, content: label };
      })
      .filter(option => option.key.includes(needle) || option.text.toLowerCase().includes(needle));
  } else if (active === 'instance' && kind === 'upstream') {
    options = data.upstreams.filter(upstream => upstream.name.toLowerCase().includes(needle) || upstream.id.toLowerCase().includes(needle)).map(upstream => ({
      key: upstream.id, value: upstream.id, text: upstream.name,
      content: <ProviderBadge label={upstream.name} upstream={upstream} />,
    }));
    if (query && !options.some(option => option.value === query)) options.push({ key: `literal:${query}`, value: query, text: query, content: query, dimmed: true });
  } else if (active === 'instance' && kind === 'user') {
    options = data.users.filter(user => user.username.toLowerCase().includes(needle)).map(user => ({ key: String(user.id), value: String(user.id), text: user.username, content: <><PersonRegular />{user.username}</> }));
  } else if (active === 'instance' && kind === 'group') {
    options = data.groups.filter(group => group.name.toLowerCase().includes(needle)).map(group => ({ key: String(group.id), value: String(group.id), text: group.name, content: <><PeopleRegular />{group.name}</> }));
  } else if (active === 'model' && hasUpstreamInstance(value)) {
    const ids = data.models.filter(model => model.upstreams.some(upstream => upstream.id === value.upstreamId)).map(model => model.id);
    options = ids.filter(id => id.toLowerCase().includes(needle)).map(id => ({ key: id, value: `exact:${id}`, text: id, content: <><CubeRegular />{id}</> }));
    if (query && !ids.includes(query)) options.push({ key: `literal:${query}`, value: `exact:${query}`, text: query, content: <><CodeRegular />{query}</>, dimmed: true });
    if (query) options.push({
      key: `regex:${query}`, value: `regex:${query}`, text: `/${query}/`,
      content: <><BracesRegular /><span className="floway-scope-expression-mono">/<span dangerouslySetInnerHTML={{ __html: highlight(query, 'regex') }} />/</span></>,
    });
  }
  const current = dirty ? null : currentOption(active, value, data, t);
  return current === null || options.some(option => option.value === current.value)
    ? options
    : [current, ...options];
};

const currentOption = (active: Part | null, value: AccessScope | null, data: ScopeExpressionData, t: TFunction): ScopeOption | null => {
  if (active === 'kind' && value) {
    const kind = kindFor(value)!;
    const label = kindLabel(kind, t);
    return { key: `current:${kind}`, value: kind, text: label, content: label };
  }
  if (active === 'instance' && value?.kind === 'upstream') {
    const upstream = data.upstreams.find(candidate => candidate.id === value.upstreamId);
    return { key: `current:${value.upstreamId}`, value: value.upstreamId, text: upstream?.name ?? value.upstreamId, content: upstream ? <ProviderBadge label={upstream.name} upstream={upstream} /> : t('dashboard.accessControl.scope.unknown', { id: value.upstreamId }), dimmed: !upstream };
  }
  if (active === 'instance' && value?.kind === 'upstreamModel') return currentOption(active, { kind: 'upstream', upstreamId: value.upstreamId }, data, t);
  if (active === 'instance' && value?.kind === 'user') {
    const user = data.users.find(candidate => candidate.id === value.userId);
    return { key: `current:${value.userId}`, value: String(value.userId), text: user?.username ?? String(value.userId), content: <><PersonRegular />{user?.username ?? t('dashboard.accessControl.scope.unknown', { id: String(value.userId) })}</>, dimmed: !user };
  }
  if (active === 'instance' && value?.kind === 'group') {
    const group = data.groups.find(candidate => candidate.id === value.groupId);
    return { key: `current:${value.groupId}`, value: String(value.groupId), text: group?.name ?? String(value.groupId), content: <><PeopleRegular />{group?.name ?? t('dashboard.accessControl.scope.unknown', { id: String(value.groupId) })}</>, dimmed: !group };
  }
  if (active === 'model' && value?.kind === 'upstreamModel') {
    const label = patternLabel(value);
    const raw = value.model.value;
    return { key: `current:${label}`, value: `${value.model.kind}:${raw}`, text: label, content: label };
  }
  return null;
};

function InstancePart({ data, kind, onActivate, readOnly, t, value }: { data: ScopeExpressionData; kind: ScopeKind; onActivate: () => void; readOnly: boolean; t: TFunction; value: AccessScope | null }) {
  if (kind === 'upstream' && hasUpstreamInstance(value)) {
    const upstream = data.upstreams.find(candidate => candidate.id === value.upstreamId);
    return upstream
      ? <button className="floway-scope-expression-part" disabled={readOnly} onClick={onActivate} type="button"><ProviderBadge label={upstream.name} upstream={upstream} /></button>
      : <UnknownPart label={t('dashboard.accessControl.scope.unknown', { id: value.upstreamId })} onActivate={onActivate} readOnly={readOnly} />;
  }
  if (kind === 'user' && value?.kind === 'user') {
    const user = data.users.find(candidate => candidate.id === value.userId);
    return user ? <button className="floway-scope-expression-part" disabled={readOnly} onClick={onActivate} type="button"><PersonRegular />{user.username}</button> : <UnknownPart label={t('dashboard.accessControl.scope.unknown', { id: String(value.userId) })} onActivate={onActivate} readOnly={readOnly} />;
  }
  if (kind === 'group' && value?.kind === 'group') {
    const group = data.groups.find(candidate => candidate.id === value.groupId);
    return group ? <button className="floway-scope-expression-part" disabled={readOnly} onClick={onActivate} type="button"><PeopleRegular />{group.name}</button> : <UnknownPart label={t('dashboard.accessControl.scope.unknown', { id: String(value.groupId) })} onActivate={onActivate} readOnly={readOnly} />;
  }
  return <button className="floway-scope-expression-part floway-scope-expression-dimmed" disabled={readOnly} onClick={onActivate} type="button">{t('dashboard.accessControl.scope.all')}</button>;
}

function UnknownPart({ label, onActivate, readOnly }: { label: string; onActivate: () => void; readOnly: boolean }) {
  return <Tooltip content={label} relationship="description"><button className="floway-scope-expression-part floway-scope-expression-dimmed" disabled={readOnly} onClick={onActivate} type="button"><DismissRegular />{label}</button></Tooltip>;
}

const kindFor = (scope: AccessScope | null): ScopeKind | null => scope?.kind === 'upstreams' || scope?.kind === 'upstream' || scope?.kind === 'upstreamModel'
  ? 'upstream'
  : scope?.kind === 'users' || scope?.kind === 'user'
    ? 'user'
    : scope?.kind === 'group' ? 'group' : null;
const kindLabel = (kind: ScopeKind, t: TFunction) => t(`dashboard.accessControl.scope.kinds.${kind}`);
const hasUpstreamInstance = (scope: AccessScope | null): scope is Extract<AccessScope, { kind: 'upstream' | 'upstreamModel' }> => scope?.kind === 'upstream' || scope?.kind === 'upstreamModel';
const patternLabel = (scope: Extract<AccessScope, { kind: 'upstreamModel' }>) => scope.model.kind === 'regex' ? `/${scope.model.value}/` : scope.model.value;
const partValue = (part: Part, value: AccessScope | null, data: ScopeExpressionData, t: TFunction): string => currentOption(part, value, data, t)?.text.replace(/^\/(.*)\/$/, '$1') ?? '';
