import { BracesRegular, CubeRegular, DismissRegular, PeopleRegular, PersonRegular } from '@fluentui/react-icons';
import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ControlPlaneGroup, ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { Combobox } from '../ui/fluent-form-controls';
import { highlight, prismTokenStyles } from '../ui/prism';
import { ProviderBadge } from '../upstreams/provider-badge';
import type { AccessScope } from '@floway-dev/gateway/browser';

const { Option, Tooltip, makeStyles, mergeClasses } = fluentComponents;

type Part = 'kind' | 'instance' | 'model';
type ScopeKind = 'upstream' | 'user' | 'group';

const useStyles = makeStyles({
  regex: prismTokenStyles,
});

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
  const editRevision = useRef(0);
  const kind = pendingKind ?? kindFor(value);

  const resetInput = (nextActive: Part | null, nextQuery = '') => {
    editRevision.current++;
    setActive(nextActive);
    setQuery(nextQuery);
    setDirty(false);
  };
  const closeInput = () => {
    resetInput(null);
    if (value !== null) setPendingKind(null);
  };
  const activate = (part: Part) => {
    if (readOnly) return;
    resetInput(part, partValue(part, kind, value, data, t));
  };
  const commitKind = (nextKind: ScopeKind) => {
    if (nextKind !== kindFor(value)) {
      onChange?.(nextKind === 'upstream' ? { kind: 'upstreams' } : nextKind === 'user' ? { kind: 'users' } : null);
    }
    setPendingKind(nextKind);
    resetInput('instance');
  };
  const commitInstance = (id: string, advance: boolean) => {
    if (kind === 'upstream') {
      const next = value?.kind === 'upstreamModel'
        ? { ...value, upstreamId: id }
        : { kind: 'upstream' as const, upstreamId: id };
      onChange?.(next);
      setPendingKind(null);
      if (advance) resetInput('model'); else closeInput();
      return;
    }
    if (kind === 'user') onChange?.({ kind: 'user', userId: Number(id) });
    if (kind === 'group') onChange?.({ kind: 'group', groupId: Number(id) });
    setPendingKind(null);
    closeInput();
  };
  const commitModel = (option: string) => {
    if (!hasUpstreamInstance(value)) return;
    const [patternKind, pattern] = option.startsWith('regex:')
      ? ['regex', option.slice(6)] as const
      : ['exact', option.slice(6)] as const;
    onChange?.({ kind: 'upstreamModel', upstreamId: value.upstreamId, model: { kind: patternKind, value: pattern } });
    closeInput();
  };
  const commitOption = (part: Part, option: string) => {
    if (part === 'kind') commitKind(option as ScopeKind);
    else if (part === 'instance') commitInstance(option, true);
    else commitModel(option);
  };
  const commitBlur = () => {
    if (!dirty) {
      closeInput();
      return;
    }
    const trimmed = query.trim();
    if (active === 'instance' && kind === 'upstream' && trimmed) commitInstance(trimmed, false);
    else if (active === 'model' && trimmed) commitModel(`exact:${trimmed}`);
    else closeInput();
  };
  const onInputBlur = () => {
    const revision = editRevision.current;
    window.setTimeout(() => {
      if (editRevision.current === revision) commitBlur();
    });
  };

  const options = useMemo(
    () => optionsFor(active, kind, query, dirty, value, data, t),
    [active, data, dirty, kind, query, t, value],
  );
  const input = active === null ? null : <PartInput
    ariaLabel={t(`dashboard.accessControl.scope.${active === 'kind' ? 'kind' : active === 'instance' ? 'instance' : 'model'}`)}
    freeform={(active === 'instance' && kind === 'upstream') || active === 'model'}
    name={`scope-${active}`}
    onBlur={onInputBlur}
    onChange={next => {
      setDirty(true);
      setQuery(active === 'model' ? next.replace(/^\//, '').replace(/\/$/, '') : next);
    }}
    onSelect={option => commitOption(active, option)}
    options={options}
    query={query}
  />;
  const hasInstance = instanceMatchesKind(kind, value);

  return <div className="floway-scope-expression">
    {active === 'kind'
      ? <><Slash />{input}</>
      : kind === null
        ? <SlashTrigger label={t('dashboard.accessControl.scope.kind')} onActivate={() => activate('kind')} readOnly={readOnly} />
        : <><Slash /><PartToken onActivate={() => activate('kind')} readOnly={readOnly}>{kindLabel(kind, t)}</PartToken></>}

    {kind !== null && (active === 'instance'
      ? <><Slash />{input}</>
      : hasInstance
        ? <><Slash /><InstancePart data={data} kind={kind} onActivate={() => activate('instance')} readOnly={readOnly} t={t} value={value} /></>
        : !readOnly && <SlashTrigger label={t('dashboard.accessControl.scope.instance')} onActivate={() => activate('instance')} />)}

    {kind === 'upstream' && hasUpstreamInstance(value) && (active === 'model'
      ? <><Slash />{input}</>
      : value.kind === 'upstreamModel'
        ? <><Slash /><ModelPart onActivate={() => activate('model')} readOnly={readOnly} scope={value} /></>
        : !readOnly && <SlashTrigger label={t('dashboard.accessControl.scope.model')} onActivate={() => activate('model')} />)}
  </div>;
}

function PartInput({ ariaLabel, freeform, name, onBlur, onChange, onSelect, options, query }: {
  ariaLabel: string;
  freeform: boolean;
  name: string;
  onBlur: () => void;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  options: ScopeOption[];
  query: string;
}) {
  return <Combobox
    aria-label={ariaLabel}
    autoComplete="off"
    autoFocus
    className="floway-scope-expression-input"
    freeform={freeform}
    input={{ onBlur }}
    listWidth="content"
    name={name}
    onChange={event => onChange(event.target.value)}
    open
    onOptionSelect={(_, option) => option.optionValue && onSelect(option.optionValue)}
    spellCheck={false}
    value={query}
  >
    {options.map(option => <Option key={option.key} text={option.text} value={option.value}>
      <span className={mergeClasses('floway-scope-expression-option', option.dimmed && 'floway-scope-expression-dimmed')}>{option.content}</span>
    </Option>)}
  </Combobox>;
}

function Slash() {
  return <span aria-hidden="true" className="floway-scope-expression-slash">/</span>;
}

function SlashTrigger({ label, onActivate, readOnly = false }: {
  label: string;
  onActivate: () => void;
  readOnly?: boolean;
}) {
  if (readOnly) return <Slash />;
  return <button aria-label={label} className="floway-scope-expression-slash floway-scope-expression-slash-trigger" onClick={onActivate} onFocus={onActivate} type="button">/</button>;
}

function PartToken({ children, className, onActivate, readOnly }: {
  children: ReactNode;
  className?: string;
  onActivate: () => void;
  readOnly: boolean;
}) {
  const classes = mergeClasses('floway-scope-expression-part', className);
  return readOnly
    ? <span className={classes}>{children}</span>
    : <button className={classes} onClick={onActivate} type="button">{children}</button>;
}

interface ScopeOption { key: string; value: string; text: string; content: ReactNode; dimmed?: boolean }

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
      .filter(option => option.key.startsWith(needle) || option.text.toLowerCase().startsWith(needle));
  } else if (active === 'instance' && kind === 'upstream') {
    options = data.upstreams
      .filter(upstream => upstream.name.toLowerCase().includes(needle) || upstream.id.toLowerCase().includes(needle))
      .map(upstream => ({ key: upstream.id, value: upstream.id, text: upstream.name, content: <ProviderBadge label={upstream.name} upstream={upstream} /> }));
    if (query && !options.some(option => option.value === query)) {
      options.push({ key: `literal:${query}`, value: query, text: query, content: query, dimmed: true });
    }
  } else if (active === 'instance' && kind === 'user') {
    options = data.users
      .filter(user => user.username.toLowerCase().includes(needle))
      .map(user => ({ key: String(user.id), value: String(user.id), text: user.username, content: <><PersonRegular />{user.username}</> }));
  } else if (active === 'instance' && kind === 'group') {
    options = data.groups
      .filter(group => group.name.toLowerCase().includes(needle))
      .map(group => ({ key: String(group.id), value: String(group.id), text: group.name, content: <><PeopleRegular />{group.name}</> }));
  } else if (active === 'model' && hasUpstreamInstance(value)) {
    const ids = [...new Set(data.models.filter(model => model.upstreams.some(upstream => upstream.id === value.upstreamId)).map(model => model.id))]
      .sort((a, b) => a.localeCompare(b));
    options = ids
      .filter(id => id.toLowerCase().includes(needle))
      .map(id => ({ key: id, value: `exact:${id}`, text: id, content: <><CubeRegular /><span className="floway-scope-expression-mono" translate="no">{id}</span></> }));
    if (query && !ids.includes(query)) {
      options.push({ key: `literal:${query}`, value: `exact:${query}`, text: query, content: <><CubeRegular /><span className="floway-scope-expression-mono" translate="no">{query}</span></>, dimmed: true });
    }
    if (query) {
      options.push({ key: `regex:${query}`, value: `regex:${query}`, text: `/${query}/`, content: <><BracesRegular /><RegexPattern pattern={query} /></> });
    }
  }

  const current = dirty ? null : currentOption(active, kind, value, data, t);
  return current === null ? options : [current, ...options.filter(option => option.value !== current.value)];
};

const currentOption = (active: Part | null, kind: ScopeKind | null, value: AccessScope | null, data: ScopeExpressionData, t: TFunction): ScopeOption | null => {
  if (active === 'kind' && kind !== null) {
    const label = kindLabel(kind, t);
    return { key: `current:${kind}`, value: kind, text: label, content: label };
  }
  if (active === 'instance' && hasUpstreamInstance(value)) {
    const upstream = data.upstreams.find(candidate => candidate.id === value.upstreamId);
    return {
      key: `current:${value.upstreamId}`,
      value: value.upstreamId,
      text: upstream?.name ?? value.upstreamId,
      content: upstream ? <ProviderBadge label={upstream.name} upstream={upstream} /> : <><DismissRegular />{t('dashboard.accessControl.scope.unknown', { id: value.upstreamId })}</>,
      dimmed: !upstream,
    };
  }
  if (active === 'instance' && value?.kind === 'user') {
    const user = data.users.find(candidate => candidate.id === value.userId);
    return { key: `current:${value.userId}`, value: String(value.userId), text: user?.username ?? String(value.userId), content: <><PersonRegular />{user?.username ?? t('dashboard.accessControl.scope.unknown', { id: String(value.userId) })}</>, dimmed: !user };
  }
  if (active === 'instance' && value?.kind === 'group') {
    const group = data.groups.find(candidate => candidate.id === value.groupId);
    return { key: `current:${value.groupId}`, value: String(value.groupId), text: group?.name ?? String(value.groupId), content: <><PeopleRegular />{group?.name ?? t('dashboard.accessControl.scope.unknown', { id: String(value.groupId) })}</>, dimmed: !group };
  }
  if (active === 'model' && value?.kind === 'upstreamModel') {
    const raw = value.model.value;
    return value.model.kind === 'regex'
      ? { key: `current:regex:${raw}`, value: `regex:${raw}`, text: `/${raw}/`, content: <><BracesRegular /><RegexPattern pattern={raw} /></> }
      : { key: `current:exact:${raw}`, value: `exact:${raw}`, text: raw, content: <><CubeRegular /><span className="floway-scope-expression-mono" translate="no">{raw}</span></> };
  }
  return null;
};

function InstancePart({ data, kind, onActivate, readOnly, t, value }: {
  data: ScopeExpressionData;
  kind: ScopeKind;
  onActivate: () => void;
  readOnly: boolean;
  t: TFunction;
  value: AccessScope | null;
}) {
  if (kind === 'upstream' && hasUpstreamInstance(value)) {
    const upstream = data.upstreams.find(candidate => candidate.id === value.upstreamId);
    return upstream
      ? <PartToken onActivate={onActivate} readOnly={readOnly}><ProviderBadge label={upstream.name} upstream={upstream} /></PartToken>
      : <UnknownPart label={t('dashboard.accessControl.scope.unknown', { id: value.upstreamId })} onActivate={onActivate} readOnly={readOnly} />;
  }
  if (kind === 'user' && value?.kind === 'user') {
    const user = data.users.find(candidate => candidate.id === value.userId);
    return user
      ? <PartToken onActivate={onActivate} readOnly={readOnly}><PersonRegular />{user.username}</PartToken>
      : <UnknownPart icon={<PersonRegular />} label={t('dashboard.accessControl.scope.unknown', { id: String(value.userId) })} onActivate={onActivate} readOnly={readOnly} />;
  }
  if (kind === 'group' && value?.kind === 'group') {
    const group = data.groups.find(candidate => candidate.id === value.groupId);
    return group
      ? <PartToken onActivate={onActivate} readOnly={readOnly}><PeopleRegular />{group.name}</PartToken>
      : <UnknownPart icon={<PeopleRegular />} label={t('dashboard.accessControl.scope.unknown', { id: String(value.groupId) })} onActivate={onActivate} readOnly={readOnly} />;
  }
  return null;
}

function ModelPart({ onActivate, readOnly, scope }: {
  onActivate: () => void;
  readOnly: boolean;
  scope: Extract<AccessScope, { kind: 'upstreamModel' }>;
}) {
  return <PartToken className="floway-scope-expression-mono" onActivate={onActivate} readOnly={readOnly}>
    {scope.model.kind === 'regex' ? <><BracesRegular /><RegexPattern pattern={scope.model.value} /></> : <><CubeRegular /><span translate="no">{scope.model.value}</span></>}
  </PartToken>;
}

function RegexPattern({ pattern }: { pattern: string }) {
  const styles = useStyles();
  return <span className={mergeClasses('floway-scope-expression-regex', styles.regex)} dangerouslySetInnerHTML={{ __html: highlight(`/${pattern}/`, 'javascript') }} translate="no" />;
}

function UnknownPart({ icon = <DismissRegular />, label, onActivate, readOnly }: {
  icon?: ReactNode;
  label: string;
  onActivate: () => void;
  readOnly: boolean;
}) {
  return <Tooltip content={label} relationship="description">
    <span><PartToken className="floway-scope-expression-dimmed" onActivate={onActivate} readOnly={readOnly}>{icon}{label}</PartToken></span>
  </Tooltip>;
}

const kindFor = (scope: AccessScope | null): ScopeKind | null => scope?.kind === 'upstreams' || scope?.kind === 'upstream' || scope?.kind === 'upstreamModel'
  ? 'upstream'
  : scope?.kind === 'users' || scope?.kind === 'user'
    ? 'user'
    : scope?.kind === 'group' ? 'group' : null;
const kindLabel = (kind: ScopeKind, t: TFunction) => t(`dashboard.accessControl.scope.kinds.${kind}`);
const hasUpstreamInstance = (scope: AccessScope | null): scope is Extract<AccessScope, { kind: 'upstream' | 'upstreamModel' }> => scope?.kind === 'upstream' || scope?.kind === 'upstreamModel';
const instanceMatchesKind = (kind: ScopeKind | null, scope: AccessScope | null) => kind === 'upstream'
  ? hasUpstreamInstance(scope)
  : kind === 'user' ? scope?.kind === 'user' : kind === 'group' && scope?.kind === 'group';
const partValue = (part: Part, kind: ScopeKind | null, value: AccessScope | null, data: ScopeExpressionData, t: TFunction): string => {
  if (part === 'model' && value?.kind === 'upstreamModel') return value.model.value;
  return currentOption(part, kind, value, data, t)?.text ?? '';
};
