import { CubeRegular, MoreHorizontal16Regular, PeopleRegular, PersonRegular, TextAsteriskRegular } from '@fluentui/react-icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';

import type { ControlPlaneGroup, ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { GroupIdentity } from '../groups/identity';
import { FieldClearIcon } from '../ui/field-clear-icon';
import { InlineCombobox } from '../ui/inline-combobox';
import { highlight, prismTokenStyles } from '../ui/prism';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { ProviderBadge } from '../upstreams/provider-badge';
import { UserIdentity } from '../users/identity';
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

export function ScopeEditor(props: Omit<ComponentProps<typeof ScopeExpression>, 'framed'>) {
  return <ScopeExpression {...props} framed />;
}

function ScopeEditorSurface({ children, className, onRemove, readOnly }: { children: ReactNode; className?: string; onRemove?: () => void; readOnly: boolean }) {
  const { t } = useTranslation();
  const isWhitespace = (target: EventTarget, root: HTMLElement) => target === root || target === root.querySelector('.floway-scope-expression');
  return <div aria-disabled={readOnly ? true : undefined} className={mergeClasses('floway-scope-editor', className)}
    onMouseDown={event => {
      if (!readOnly && isWhitespace(event.target, event.currentTarget)) event.preventDefault();
    }}
    onClick={event => {
      if (!readOnly && isWhitespace(event.target, event.currentTarget)) {
        activateSegment(event.currentTarget.querySelector('.floway-scope-expression')!.lastElementChild!);
      }
    }}
  >
    {children}
    {onRemove && <TooltipIconButton disabled={readOnly} icon={<FieldClearIcon />} label={t('dashboard.accessControl.actions.removeScopeSegment')} onClick={onRemove} />}
  </div>;
}

const activateSegment = (segment: Element) => {
  const control = segment.querySelector<HTMLInputElement | HTMLButtonElement>('input, button')!;
  control.focus();
  control.click();
};

export function ScopeExpression({ className, data, framed = false, kindHint, onChange, onNavigate, purpose = 'scope', readOnly = false, value }: {
  className?: string;
  data: ScopeExpressionData;
  framed?: boolean;
  kindHint?: 'group';
  onChange?: (value: AccessScope | null, kindHint?: 'group') => void;
  onNavigate?: (value: AccessScope | null, kindHint?: 'group') => void;
  purpose?: 'scope' | 'filter';
  readOnly?: boolean;
  value: AccessScope | null;
}) {
  const { t } = useTranslation();
  const [editingPart, setActive] = useState<Part | null>(null);
  const active = readOnly ? null : editingPart;
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingKind, setPendingKind] = useState<ScopeKind | null>(null);
  const editRevision = useRef(0);
  // A deferred blur must not commit after replacement or a read-only transition.
  useEffect(() => () => { editRevision.current++; }, [readOnly]);
  if (readOnly && editingPart !== null) {
    setActive(null);
    setQuery('');
    setDirty(false);
  }
  const kind = (purpose === 'scope' ? pendingKind : null) ?? kindFor(value) ?? kindHint ?? null;
  const interactive = !readOnly || onNavigate !== undefined;

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
    if (onNavigate) {
      if (part === 'kind') onNavigate(kind === 'upstream' ? { kind: 'upstreams' } : kind === 'user' ? { kind: 'users' } : null, kind === 'group' ? 'group' : undefined);
      else if (part === 'instance' && hasUpstreamInstance(value)) onNavigate({ kind: 'upstream', upstreamId: value.upstreamId });
      else onNavigate(value);
      return;
    }
    if (readOnly) return;
    resetInput(part, partValue(part, kind, value, data, t));
  };
  const commitKind = (nextKind: ScopeKind) => {
    if (nextKind !== kindFor(value) || purpose === 'filter') {
      if (nextKind === 'group') onChange?.(null, 'group');
      else onChange?.(nextKind === 'upstream' ? { kind: 'upstreams' } : { kind: 'users' });
    }
    setPendingKind(nextKind);
    resetInput('instance');
  };
  const commitInstance = (id: string) => {
    if (kind === 'upstream') {
      const next = value?.kind === 'upstreamModel' && purpose !== 'filter'
        ? { ...value, upstreamId: id }
        : { kind: 'upstream' as const, upstreamId: id };
      onChange?.(next);
      setPendingKind(null);
      resetInput('model');
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
    else if (part === 'instance') commitInstance(option);
    else commitModel(option);
  };
  const commitBlur = () => {
    if (!dirty) {
      closeInput();
      return;
    }
    const trimmed = query.trim();
    if (active === 'model' && trimmed) commitModel(`exact:${trimmed}`);
    else closeInput();
  };
  const onInputBlur: NonNullable<ComponentProps<typeof InlineCombobox>['onBlur']> = event => {
    const next = event.relatedTarget;
    // A submit click reads the parent's scope after focus leaves this editor.
    // Internal focus and option selection must still be able to replace a draft.
    if (next instanceof HTMLElement && !next.closest('[role="listbox"]')
      && next.closest('.floway-scope-expression') !== event.currentTarget.closest('.floway-scope-expression')) {
      commitBlur();
      return;
    }
    const revision = editRevision.current;
    window.setTimeout(() => {
      if (editRevision.current === revision) commitBlur();
    });
  };

  const options = useMemo(
    () => optionsFor(active, kind, query, value, data, t),
    [active, data, kind, query, t, value],
  );
  const input = active === null ? null : <PartInput
    ariaLabel={t(`dashboard.accessControl.scope.${active === 'kind' ? 'kind' : active === 'instance' ? 'instance' : 'model'}`)}
    emptyMessage={t('dashboard.accessControl.scope.noMatches')}
    freeform={active === 'model'}
    model={active === 'model'}
    name={`scope-${active}`}
    onBlur={onInputBlur}
    onChange={next => {
      setDirty(true);
      setQuery(active === 'model' && purpose === 'scope' ? next.replace(/^\//, '').replace(/\/$/, '') : next);
    }}
    onSelect={option => commitOption(active, option)}
    onCancel={closeInput}
    options={options}
    query={query}
    resourceType={active === 'kind'}
    regex={active === 'model' && value?.kind === 'upstreamModel' && value.model.kind === 'regex'}
  />;
  const hasInstance = instanceMatchesKind(kind, value);
  const removeLast = () => {
    resetInput(null);
    if (value?.kind === 'upstreamModel') onChange?.({ kind: 'upstream', upstreamId: value.upstreamId });
    else if (value?.kind === 'upstream') onChange?.({ kind: 'upstreams' });
    else if (value?.kind === 'user') onChange?.({ kind: 'users' });
    else if (value?.kind === 'group') onChange?.(null, 'group');
    else onChange?.(null);
    setPendingKind(value?.kind === 'group' ? 'group' : null);
  };

  const expression = <div aria-label={interactive ? t('dashboard.accessControl.fields.scope') : undefined} className={mergeClasses('floway-scope-expression', !framed && className)} role={interactive ? 'group' : undefined}
    onMouseDown={event => {
      if (onNavigate || (interactive && (event.target as HTMLElement).classList.contains('floway-scope-expression-slash'))) event.preventDefault();
    }}
    onClick={event => {
      if (interactive && (event.target as HTMLElement).classList.contains('floway-scope-expression-slash')) {
        activateSegment((event.target as HTMLElement).parentElement!);
      }
    }}
  >
    <Segment active={active === 'kind'} dirty={dirty} input={input}>{editing => kind === null
      ? !readOnly && <AppendTrigger label={t('dashboard.accessControl.scope.kind')} onActivate={() => activate('kind')} readOnly={editing} />
      : <PartToken className="floway-scope-expression-kind" onActivate={() => activate('kind')} readOnly={editing || !interactive}>{kindLabel(kind, t)}</PartToken>}
    </Segment>

    {kind !== null && (active === 'instance' || hasInstance || !readOnly) && <Segment active={active === 'instance'} dirty={dirty} input={input}>{editing => hasInstance
      ? <InstancePart data={data} kind={kind} onActivate={() => activate('instance')} readOnly={editing || !interactive} t={t} value={value} />
      : <AppendTrigger label={t('dashboard.accessControl.scope.instance')} onActivate={() => activate('instance')} readOnly={editing} />}
    </Segment>}

    {kind === 'upstream' && hasUpstreamInstance(value) && (active === 'model' || value.kind === 'upstreamModel' || !readOnly) && <Segment active={active === 'model'} dirty={dirty} input={input}>{editing => value.kind === 'upstreamModel'
      ? <ModelPart onActivate={() => activate('model')} readOnly={editing || !interactive} scope={value} />
      : <AppendTrigger label={t('dashboard.accessControl.scope.model')} onActivate={() => activate('model')} readOnly={editing} />}
    </Segment>}
  </div>;
  return framed ? <ScopeEditorSurface className={className} onRemove={kind === null ? undefined : removeLast} readOnly={readOnly}>{expression}</ScopeEditorSurface> : expression;
}

function Segment({ active, children, dirty, input }: { active: boolean; children: (editing: boolean) => ReactNode; dirty: boolean; input: ReactNode }) {
  const content = children(active);
  return <span className="floway-scope-expression-segment"><Slash />{active
    ? <span className="floway-scope-expression-part-editor" data-pristine={!dirty ? true : undefined}>
        {!dirty && <span aria-hidden className="floway-scope-expression-part-preview" inert>{content}</span>}
        <span className="floway-scope-expression-part-control">{input}</span>
      </span>
    : content}
  </span>;
}

function PartInput({ ariaLabel, emptyMessage, freeform, model, name, onBlur, onCancel, onChange, onSelect, options, query, regex, resourceType }: {
  ariaLabel: string;
  emptyMessage: string;
  freeform: boolean;
  model: boolean;
  name: string;
  onBlur: ComponentProps<typeof InlineCombobox>['onBlur'];
  onCancel: () => void;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  options: ScopeOption[];
  query: string;
  regex: boolean;
  resourceType: boolean;
}) {
  const Icon = regex ? TextAsteriskRegular : CubeRegular;
  return <span className={mergeClasses('floway-scope-expression-part', resourceType && 'floway-scope-expression-kind')}>
    {model && <Icon className="floway-scope-expression-model-icon" />}
    <InlineCombobox
      aria-label={ariaLabel}
      autoComplete="off"
      autoFocus
      className={mergeClasses('floway-scope-expression-input', model && 'font-mono')}
      emptyMessage={emptyMessage}
      // Unmatched resources remain visible, but must not become an automatic
      // Tab completion just because they are first in the open list.
      disableAutoFocus={!freeform}
      freeform={freeform}
      onBlur={onBlur}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          const segment = event.currentTarget.closest('.floway-scope-expression-segment')!;
          onCancel();
          requestAnimationFrame(() => segment.querySelector('button')?.focus());
        }
      }}
      name={name}
      onChange={event => onChange(event.target.value)}
      defaultOpen
      onOptionSelect={(_, option) => option.optionValue && onSelect(option.optionValue)}
      spellCheck={false}
      value={query}
    >
      {options.map(option => <Option key={option.key} text={option.text} value={option.value}>
        <span className={mergeClasses('floway-scope-expression-option', option.dimmed && 'floway-scope-expression-dimmed')}>{option.content}</span>
      </Option>)}
    </InlineCombobox>
  </span>;
}

function AppendTrigger({ label, onActivate, readOnly = false }: { label: string; onActivate: () => void; readOnly?: boolean }) {
  const className = 'floway-scope-expression-part floway-scope-expression-append';
  return readOnly
    ? <span className={className}><MoreHorizontal16Regular /></span>
    : <button aria-label={label} className={className} onClick={onActivate} type="button"><MoreHorizontal16Regular /></button>;
}

function Slash() {
  return <span aria-hidden="true" className="floway-scope-expression-slash">/</span>;
}

function PartToken({ children, className, onActivate, readOnly }: {
  children: ReactNode;
  className?: string;
  onActivate: () => void;
  readOnly: boolean;
}) {
  const classes = mergeClasses('floway-scope-expression-part', className);
  const content = typeof children === 'string' ? <span className="floway-control-label">{children}</span> : children;
  return readOnly
    ? <span className={classes}>{content}</span>
    : <button className={classes} onClick={onActivate} type="button">{content}</button>;
}

interface ScopeOption { key: string; value: string; text: string; content: ReactNode; dimmed?: boolean }

const optionsFor = (
  active: Part | null,
  kind: ScopeKind | null,
  query: string,
  value: AccessScope | null,
  data: ScopeExpressionData,
  t: TFunction,
): ScopeOption[] => {
  const needle = query.toLowerCase();
  const matching: ScopeOption[] = [];
  const unmatched: ScopeOption[] = [];
  const custom: ScopeOption[] = [];
  const add = (option: ScopeOption, matches: boolean) => (matches ? matching : unmatched).push(option);
  if (active === 'kind') {
    for (const candidate of ['user', 'upstream', 'group'] as const) {
      const label = kindLabel(candidate, t);
      add({ key: candidate, value: candidate, text: label, content: label }, candidate.startsWith(needle) || label.toLowerCase().startsWith(needle));
    }
  } else if (active === 'instance' && kind === 'upstream') {
    for (const upstream of data.upstreams) {
      add({ key: upstream.id, value: upstream.id, text: upstream.name, content: <ProviderBadge label={upstream.name} upstream={upstream} /> }, upstream.name.toLowerCase().includes(needle) || upstream.id.toLowerCase().includes(needle));
    }
  } else if (active === 'instance' && kind === 'user') {
    for (const user of data.users) {
      add({ key: String(user.id), value: String(user.id), text: user.username, content: <UserIdentity username={user.username} /> }, user.username.toLowerCase().includes(needle));
    }
  } else if (active === 'instance' && kind === 'group') {
    for (const group of data.groups) {
      add({ key: String(group.id), value: String(group.id), text: group.name, content: <GroupIdentity group={group} /> }, group.name.toLowerCase().includes(needle));
    }
  } else if (active === 'model' && hasUpstreamInstance(value)) {
    const ids = [...new Set(data.models.filter(model => model.upstreams.some(upstream => upstream.id === value.upstreamId)).map(model => model.id))]
      .sort((a, b) => a.localeCompare(b));
    const pattern = query ? draftPattern(query) : null;
    for (const id of ids) {
      add({ key: id, value: `exact:${id}`, text: id, content: <><CubeRegular className="floway-scope-expression-model-icon" /><span className="floway-control-label font-mono" translate="no">{id}</span></> }, id.toLowerCase().includes(needle) || pattern?.test(id) === true);
    }
    if (query && !ids.includes(query)) {
      custom.push({ key: `literal:${query}`, value: `exact:${query}`, text: query, content: <><CubeRegular className="floway-scope-expression-model-icon" /><span className="floway-control-label font-mono" translate="no">{query}</span></>, dimmed: true });
    }
    if (pattern !== null) {
      custom.push({ key: `regex:${query}`, value: `regex:${query}`, text: `/${query}/`, content: <><TextAsteriskRegular className="floway-scope-expression-model-icon" /><RegexPattern pattern={query} /></> });
    }
  }

  return [...matching, ...custom, ...unmatched];
};

const draftPattern = (query: string): RegExp | null => {
  try { return new RegExp(query); } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
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
      : <UnknownPart description={t('dashboard.accessControl.scope.unknownUpstreamId', { id: value.upstreamId })} onActivate={onActivate} readOnly={readOnly} />;
  }
  if (kind === 'user' && value?.kind === 'user') {
    const user = data.users.find(candidate => candidate.id === value.userId);
    return user
      ? <PartToken onActivate={onActivate} readOnly={readOnly}><UserIdentity username={user.username} /></PartToken>
      : <UnknownPart description={t('dashboard.accessControl.scope.unknownUserId', { id: String(value.userId) })} icon={<PersonRegular />} onActivate={onActivate} readOnly={readOnly} />;
  }
  if (kind === 'group' && value?.kind === 'group') {
    const group = data.groups.find(candidate => candidate.id === value.groupId);
    return group
      ? <PartToken onActivate={onActivate} readOnly={readOnly}><GroupIdentity group={group} /></PartToken>
      : <UnknownPart description={t('dashboard.accessControl.scope.unknownGroupId', { id: String(value.groupId) })} icon={<PeopleRegular />} onActivate={onActivate} readOnly={readOnly} />;
  }
  return null;
}

function ModelPart({ onActivate, readOnly, scope }: {
  onActivate: () => void;
  readOnly: boolean;
  scope: Extract<AccessScope, { kind: 'upstreamModel' }>;
}) {
  return <PartToken onActivate={onActivate} readOnly={readOnly}>
    {scope.model.kind === 'regex' ? <><TextAsteriskRegular className="floway-scope-expression-model-icon" /><RegexPattern pattern={scope.model.value} /></> : <><CubeRegular className="floway-scope-expression-model-icon" /><span className="floway-control-label font-mono" translate="no">{scope.model.value}</span></>}
  </PartToken>;
}

function RegexPattern({ pattern }: { pattern: string }) {
  const styles = useStyles();
  return <span className={mergeClasses('floway-control-label font-mono floway-scope-expression-regex', styles.regex)} translate="no">
    <span className="token regex">/<span dangerouslySetInnerHTML={{ __html: highlight(pattern, 'regex') }} />/</span>
  </span>;
}

function UnknownPart({ description, icon, onActivate, readOnly }: {
  description: string;
  icon?: ReactNode;
  onActivate: () => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  return <Tooltip content={description} relationship="description">
    <span className="winui-focus-rect inline-flex max-w-full" tabIndex={readOnly ? 0 : undefined}>
      <PartToken className="floway-scope-expression-dimmed" onActivate={onActivate} readOnly={readOnly}>{icon}
        <span className="floway-control-label">{t('dashboard.accessControl.scope.unknownLabel')}</span>
      </PartToken>
    </span>
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
  if (part === 'kind' && kind !== null) return kindLabel(kind, t);
  if (part === 'model' && value?.kind === 'upstreamModel') return value.model.value;
  if (part === 'instance') {
    if (hasUpstreamInstance(value)) return data.upstreams.find(upstream => upstream.id === value.upstreamId)?.name ?? value.upstreamId;
    if (value?.kind === 'user') return data.users.find(user => user.id === value.userId)?.username ?? String(value.userId);
    if (value?.kind === 'group') return data.groups.find(group => group.id === value.groupId)?.name ?? String(value.groupId);
  }
  return '';
};
