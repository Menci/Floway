import { CubeRegular, MoreHorizontal16Regular, PeopleRegular, PersonRegular, TextAsteriskRegular } from '@fluentui/react-icons';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, ReactNode, Ref, RefObject } from 'react';

import { scopeKind, scopeResourceId, scopeResourceName, type ScopeKind } from './scope';
import type { ControlPlaneModel, PermissionsGroup, PermissionsUser, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { GroupIdentity } from '../groups/identity';
import { FieldClearIcon } from '../ui/field-clear-icon';
import { InlineCombobox } from '../ui/inline-combobox';
import { highlight, prismTokenStyles } from '../ui/prism';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { UpstreamBadge } from '../upstreams/upstream-kind-badge';
import { UserIdentity } from '../users/identity';
import type { AccessScope } from '@floway-dev/gateway/browser';

const { Option, Tooltip, makeStyles, mergeClasses } = fluentComponents;

type Part = 'kind' | 'instance' | 'model';

interface SegmentContextValue {
  onActivate: () => void;
  readOnly: boolean;
  triggerRef: Ref<HTMLButtonElement>;
}

const SegmentContext = createContext<SegmentContextValue | null>(null);

const useStyles = makeStyles({
  regex: prismTokenStyles,
});

export interface ScopeExpressionData {
  groups: PermissionsGroup[];
  models: ControlPlaneModel[];
  upstreams: UpstreamOption[];
  users: PermissionsUser[];
}

export function ScopeEditor(props: Omit<ComponentProps<typeof ScopeExpression>, 'framed'>) {
  return <ScopeExpression {...props} framed />;
}

function ScopeEditorSurface({ children, className, expressionRef, onActivate, onRemove, readOnly }: {
  children: ReactNode;
  className?: string | undefined;
  expressionRef: RefObject<HTMLDivElement | null>;
  onActivate: () => void;
  onRemove?: (() => void) | undefined;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const isWhitespace = (target: EventTarget, root: HTMLElement) => target === root || target === expressionRef.current;
  return <div aria-disabled={readOnly ? true : undefined} className={mergeClasses('floway-scope-editor', className)}
    onMouseDown={event => {
      if (!readOnly && (isWhitespace(event.target, event.currentTarget)
        || (event.target instanceof Element && !expressionRef.current?.contains(event.target)))) {
        event.preventDefault();
      }
    }}
    onClick={event => {
      if (!readOnly && isWhitespace(event.target, event.currentTarget)) {
        onActivate();
      }
    }}
  >
    {children}
    {onRemove && <TooltipIconButton disabled={readOnly} icon={<FieldClearIcon />} label={t('permissions.actions.removeScopeSegment')} onClick={onRemove} />}
  </div>;
}

export function ScopeExpression({ className, data, framed = false, onChange, onNavigate, purpose = 'scope', readOnly = false, value }: {
  className?: string | undefined;
  data: ScopeExpressionData;
  framed?: boolean | undefined;
  onChange?: ((value: AccessScope | null) => void) | undefined;
  onNavigate?: ((value: AccessScope | null) => void) | undefined;
  purpose?: 'scope' | 'filter' | undefined;
  readOnly?: boolean | undefined;
  value: AccessScope | null;
}) {
  const { t } = useTranslation();
  const expressionRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editingPart, setActive] = useState<Part | null>(null);
  const active = readOnly ? null : editingPart;
  const [query, setQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingKind, setPendingKind] = useState<ScopeKind | null>(null);
  const editRevision = useRef(0);
  const activePartRef = useRef<Part | null>(null);
  const keyboardNavigatedRef = useRef(false);
  // A deferred blur must not commit after replacement or a read-only transition.
  useEffect(() => () => { editRevision.current++; activePartRef.current = null; keyboardNavigatedRef.current = false; }, [readOnly]);
  if (readOnly && editingPart !== null) {
    setActive(null);
    setQuery('');
    setDirty(false);
  }
  const kind = (purpose === 'scope' ? pendingKind : null) ?? scopeKind(value);
  const interactive = !readOnly || onNavigate !== undefined;

  const resetInput = (nextActive: Part | null, nextQuery = '') => {
    editRevision.current++;
    activePartRef.current = nextActive;
    keyboardNavigatedRef.current = false;
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
      if (part === 'kind') onNavigate(collectionScope(kind));
      else if (part === 'instance' && hasUpstreamInstance(value)) onNavigate({ kind: 'upstream', upstreamId: value.upstreamId });
      else onNavigate(value);
      return;
    }
    if (readOnly) return;
    if (active === part) {
      inputRef.current?.focus();
      return;
    }
    resetInput(part, partValue(part, kind, value, data, t));
  };
  const commitKind = (nextKind: ScopeKind, advance = true) => {
    if (nextKind !== scopeKind(value) || purpose === 'filter') {
      onChange?.(collectionScope(nextKind));
    }
    if (!advance || nextKind === 'self') {
      setPendingKind(null);
      resetInput(null);
      return;
    }
    setPendingKind(nextKind);
    resetInput('instance');
  };
  const commitInstance = (id: string, advance = true) => {
    if (kind === 'upstream') {
      const next = value?.kind === 'upstreamModel' && purpose !== 'filter'
        ? { ...value, upstreamId: id }
        : { kind: 'upstream' as const, upstreamId: id };
      onChange?.(next);
      setPendingKind(null);
      if (advance) resetInput('model');
      else resetInput(null);
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
  const commitOption = (part: Part, option: string, advance = true) => {
    if (part === 'kind') commitKind(option as ScopeKind, advance);
    else if (part === 'instance') commitInstance(option, advance);
    else commitModel(option);
  };
  const options = useMemo(
    () => optionsFor(active, kind, query, value, data, t),
    [active, data, kind, query, t, value],
  );
  const defaultOption = options.find(option => option.matched) ?? null;
  const commitBlur = () => {
    if (!dirty || active === null) {
      closeInput();
      return;
    }
    const trimmed = query.trim();
    if (!trimmed || defaultOption === null || defaultOption.value === currentOptionValue(active, kind, value)) {
      closeInput();
      return;
    }
    commitOption(active, defaultOption.value, false);
  };
  const onInputBlur = (part: Part, event: Parameters<NonNullable<ComponentProps<typeof InlineCombobox>['onBlur']>>[0]) => {
    if (activePartRef.current !== part) return;
    const next = event.relatedTarget;
    // A submit click reads the parent's scope after focus leaves this editor.
    // Internal focus and option selection must still be able to replace a draft.
    if (next instanceof HTMLElement && !next.closest('[role="listbox"]')
      && !expressionRef.current!.contains(next)) {
      commitBlur();
      return;
    }
    const revision = editRevision.current;
    window.setTimeout(() => {
      if (editRevision.current === revision && activePartRef.current === part) commitBlur();
    });
  };

  const commitEnter = () => {
    if (active === null) return;
    const candidate = query.trim() === '' ? (options[0] ?? null) : defaultOption;
    if (candidate !== null) commitOption(active, candidate.value);
    else closeInput();
  };
  const input = active === null ? null : <PartInput
    ariaLabel={t(`permissions.scope.${active === 'kind' ? 'kind' : active === 'instance' ? 'instance' : 'model'}`)}
    emptyMessage={t('permissions.scope.noMatches')}
    inputRef={inputRef}
    name={`scope-${active}`}
    onBlur={event => onInputBlur(active, event)}
    onChange={next => {
      keyboardNavigatedRef.current = false;
      setDirty(true);
      setQuery(active === 'model' && purpose === 'scope' ? next.replace(/^\//, '').replace(/\/$/, '') : next);
    }}
    onSelect={option => commitOption(active, option)}
    options={options}
    part={active}
    query={query}
    regex={active === 'model' && value?.kind === 'upstreamModel' && value.model.kind === 'regex'}
  />;
  const hasInstance = instanceMatchesKind(kind, value);
  const showInstance = kind !== null && kind !== 'self' && (active === 'instance' || hasInstance || (!readOnly && active === null));
  const showModel = kind === 'upstream' && hasUpstreamInstance(value) && (active === 'model' || value.kind === 'upstreamModel' || (!readOnly && active === null));
  const lastPart = showModel ? 'model' : showInstance ? 'instance' : 'kind';
  const editable = !readOnly && !onNavigate;
  const deepestPart: Part | null = value?.kind === 'upstreamModel' || active === 'model'
    ? 'model'
    : hasInstance || active === 'instance'
      ? 'instance'
      : kind !== null || active === 'kind'
        ? 'kind'
        : null;
  const discardSegment = (part: Part, reason: 'remove' | 'backspace') => {
    setPendingKind(null);
    if (part === 'model') {
      const next = value?.kind === 'upstreamModel' ? { kind: 'upstream' as const, upstreamId: value.upstreamId } : value;
      resetInput('instance', partValue('instance', kind, next, data, t));
      if (next !== value) onChange?.(next);
      inputRef.current?.focus();
    } else if (part === 'instance') {
      const next = hasInstance ? collectionScope(kind) : value;
      resetInput('kind', partValue('kind', kind, next, data, t));
      if (next !== value) onChange?.(next);
      inputRef.current?.focus();
    } else {
      resetInput(reason === 'backspace' ? 'kind' : null);
      if (value !== null) onChange?.(null);
    }
  };
  const removeLast = () => {
    if (deepestPart !== null) discardSegment(deepestPart, 'remove');
  };

  const expression = <div aria-label={interactive ? t('permissions.fields.scope') : undefined} className={mergeClasses('floway-scope-expression', !framed && className)} ref={expressionRef} role={interactive ? 'group' : undefined}
    onMouseDown={event => {
      if (onNavigate) event.preventDefault();
    }}
  >
    <Segment active={active === 'kind'} dirty={dirty} input={input} interactive={interactive} keyboardNavigatedRef={keyboardNavigatedRef} onActivate={() => activate('kind')} onBackspace={editable && active === 'kind' && query === '' && value !== null ? () => discardSegment('kind', 'backspace') : undefined} onCancel={closeInput} onEnter={commitEnter} part="kind">{kind === null
      ? !readOnly && <AppendTrigger label={t('permissions.scope.kind')} />
      : <PartToken className="floway-scope-expression-kind">{kindLabel(kind, t)}</PartToken>}
    </Segment>

    {showInstance && <Segment active={active === 'instance'} dirty={dirty} input={input} interactive={interactive} keyboardNavigatedRef={keyboardNavigatedRef} onActivate={() => activate('instance')} onBackspace={editable && (active === 'instance' ? query === '' : !hasInstance) ? () => discardSegment('instance', 'backspace') : undefined} onCancel={closeInput} onEnter={commitEnter} part="instance">{hasInstance
      ? <InstancePart data={data} kind={kind} t={t} value={value} />
      : <AppendTrigger label={t('permissions.scope.instance')} />}
    </Segment>}

    {showModel && <Segment active={active === 'model'} dirty={dirty} input={input} interactive={interactive} keyboardNavigatedRef={keyboardNavigatedRef} onActivate={() => activate('model')} onBackspace={editable && (active === 'model' ? query === '' : value.kind !== 'upstreamModel') ? () => discardSegment('model', 'backspace') : undefined} onCancel={closeInput} onEnter={commitEnter} part="model">{value.kind === 'upstreamModel'
      ? <ModelPart scope={value} />
      : <AppendTrigger label={t('permissions.scope.model')} />}
    </Segment>}
  </div>;
  return framed ? <ScopeEditorSurface className={className} expressionRef={expressionRef} onActivate={() => activate(lastPart)} onRemove={kind === null ? undefined : removeLast} readOnly={readOnly}>{expression}</ScopeEditorSurface> : expression;
}

function Segment({ active, children, dirty, input, interactive, keyboardNavigatedRef, onActivate, onBackspace, onCancel, onEnter, part }: {
  active: boolean;
  children: ReactNode;
  dirty: boolean;
  input: ReactNode;
  interactive: boolean;
  keyboardNavigatedRef: RefObject<boolean>;
  onActivate: () => void;
  onBackspace?: (() => void) | undefined;
  onCancel: () => void;
  onEnter: () => void;
  part: Part;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    if (!active && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [active]);
  return <SegmentContext value={{ onActivate, readOnly: active || !interactive, triggerRef }}><span className="floway-scope-expression-segment" data-scope-part={part} onKeyDownCapture={event => {
    if (active && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End' || event.key === 'PageDown' || event.key === 'PageUp') {
        keyboardNavigatedRef.current = true;
        return;
      }
      if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const navigatedOption = keyboardNavigatedRef.current
          && event.target instanceof HTMLElement
          && Boolean(event.target.getAttribute('aria-activedescendant'));
        if (!navigatedOption) {
          event.preventDefault();
          event.stopPropagation();
          onEnter();
          return;
        }
      }
    }
    if (active && event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      restoreFocus.current = true;
      onCancel();
    } else if (onBackspace && event.key === 'Backspace' && !event.nativeEvent.isComposing
      && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      onBackspace();
    }
  }}><Slash onActivate={interactive ? onActivate : undefined} />{active
      ? <span className="floway-scope-expression-part-editor" data-pristine={!dirty ? true : undefined}>
          {!dirty && <span aria-hidden className="floway-scope-expression-part-preview" inert>{children}</span>}
          <span className="floway-scope-expression-part-control">{input}</span>
        </span>
      : children}
  </span></SegmentContext>;
}

function PartInput({ ariaLabel, emptyMessage, inputRef, name, onBlur, onChange, onSelect, options, part, query, regex }: {
  ariaLabel: string;
  emptyMessage: string;
  inputRef: Ref<HTMLInputElement>;
  name: string;
  onBlur: ComponentProps<typeof InlineCombobox>['onBlur'];
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  options: ScopeOption[];
  part: Part;
  query: string;
  regex: boolean;
}) {
  const model = part === 'model';
  const Icon = regex ? TextAsteriskRegular : CubeRegular;
  return <span className={mergeClasses('floway-scope-expression-part', part === 'kind' && 'floway-scope-expression-kind')}>
    {model && <Icon className="floway-scope-expression-model-icon" />}
    <InlineCombobox
      aria-label={ariaLabel}
      autoComplete="off"
      autoFocus
      className={model ? 'font-mono' : undefined}
      emptyMessage={emptyMessage}
      // Unmatched resources remain visible, but must not become an automatic
      // Tab completion just because they are first in the open list.
      // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Listbox/useListbox.ts#L169-L183
      // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/utils/useTriggerSlot.ts#L216-L218
      disableAutoFocus={!model}
      freeform={model}
      onBlur={onBlur}
      name={name}
      onChange={event => onChange(event.target.value)}
      defaultOpen
      onOptionSelect={(_, option) => option.optionValue && onSelect(option.optionValue)}
      spellCheck={false}
      ref={inputRef}
      value={query}
    >
      {options.map(option => <Option key={option.key} text={option.text} value={option.value}>
        <span className={mergeClasses('floway-scope-expression-option', option.dimmed && 'floway-scope-expression-dimmed')}>{option.content}</span>
      </Option>)}
    </InlineCombobox>
  </span>;
}

function AppendTrigger({ label }: { label: string }) {
  const { onActivate, readOnly, triggerRef } = useContext(SegmentContext)!;
  const className = 'floway-scope-expression-part floway-scope-expression-append';
  return readOnly
    ? <span className={className}><MoreHorizontal16Regular /></span>
    : <button aria-label={label} className={className} onClick={onActivate} ref={triggerRef} type="button"><MoreHorizontal16Regular /></button>;
}

function Slash({ onActivate }: { onActivate?: (() => void) | undefined }) {
  return <span aria-hidden="true" className="floway-scope-expression-slash" onClick={onActivate} onMouseDown={onActivate ? event => event.preventDefault() : undefined}><span className="floway-control-label">/</span></span>;
}

function PartToken({ children, className }: {
  children: ReactNode;
  className?: string | undefined;
}) {
  const { onActivate, readOnly, triggerRef } = useContext(SegmentContext)!;
  const classes = mergeClasses('floway-scope-expression-part', className);
  const content = typeof children === 'string' ? <span className="floway-control-label">{children}</span> : children;
  return readOnly
    ? <span className={classes}>{content}</span>
    : <button className={classes} onClick={onActivate} ref={triggerRef} type="button">{content}</button>;
}

interface ScopeOption { key: string; value: string; text: string; content: ReactNode; dimmed?: boolean; matched: boolean }

const currentOptionValue = (part: Part | null, kind: ScopeKind | null, value: AccessScope | null): string | null => {
  if (part === 'kind') return kind;
  if (part === 'instance') {
    if (hasUpstreamInstance(value)) return value.upstreamId;
    if (value?.kind === 'user') return String(value.userId);
    if (value?.kind === 'group') return String(value.groupId);
  }
  if (part === 'model' && value?.kind === 'upstreamModel') return `${value.model.kind}:${value.model.value}`;
  return null;
};

const optionsFor = (
  active: Part | null,
  kind: ScopeKind | null,
  query: string,
  value: AccessScope | null,
  data: ScopeExpressionData,
  t: TFunction,
): ScopeOption[] => {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  const matching: ScopeOption[] = [];
  const unmatched: ScopeOption[] = [];
  const custom: ScopeOption[] = [];
  const preferred: ScopeOption[] = [];
  const add = (option: Omit<ScopeOption, 'matched'>, matches: boolean) =>
    (matches ? matching : unmatched).push({ ...option, matched: matches });
  if (active === 'kind') {
    for (const candidate of ['self', 'user', 'upstream', 'group'] as const) {
      const label = kindLabel(candidate, t);
      add({ key: candidate, value: candidate, text: label, content: label }, candidate.startsWith(needle) || label.toLowerCase().startsWith(needle));
    }
  } else if (active === 'instance' && kind === 'upstream') {
    for (const upstream of data.upstreams) {
      add({ key: upstream.id, value: upstream.id, text: upstream.name, content: <UpstreamBadge label={upstream.name} upstream={upstream} /> }, upstream.name.toLowerCase().includes(needle) || upstream.id.toLowerCase().includes(needle));
    }
  } else if (active === 'instance' && kind === 'user') {
    for (const user of data.users) {
      add({ key: String(user.id), value: String(user.id), text: user.username, content: <UserIdentity isAdmin={user.isAdmin} username={user.username} /> }, user.username.toLowerCase().includes(needle));
    }
  } else if (active === 'instance' && kind === 'group') {
    for (const group of data.groups) {
      add({ key: String(group.id), value: String(group.id), text: group.name, content: <GroupIdentity group={group} /> }, group.name.toLowerCase().includes(needle));
    }
  } else if (active === 'model' && hasUpstreamInstance(value)) {
    const ids = [...new Set(data.models.filter(model => model.upstreams.some(upstream => upstream.id === value.upstreamId)).map(model => model.id))]
      .sort((a, b) => a.localeCompare(b));
    const editingRegex = value.kind === 'upstreamModel' && value.model.kind === 'regex';
    const pattern = trimmed ? draftPattern(trimmed) : null;
    for (const id of ids) {
      add({ key: id, value: `exact:${id}`, text: id, content: <><CubeRegular className="floway-scope-expression-model-icon" /><span className="floway-control-label font-mono" translate="no">{id}</span></> }, id.toLowerCase().includes(needle) || pattern?.test(id) === true);
    }
    if (trimmed && !ids.includes(trimmed)) {
      custom.push({ key: `literal:${trimmed}`, value: `exact:${trimmed}`, text: trimmed, content: <><CubeRegular className="floway-scope-expression-model-icon" /><span className="floway-control-label font-mono" translate="no">{trimmed}</span></>, dimmed: true, matched: true });
    }
    if (pattern !== null) {
      const regexOption: ScopeOption = { key: `regex:${trimmed}`, value: `regex:${trimmed}`, text: `/${trimmed}/`, content: <><TextAsteriskRegular className="floway-scope-expression-model-icon" /><RegexPattern pattern={trimmed} /></>, matched: true };
      if (editingRegex) preferred.push(regexOption);
      else custom.push(regexOption);
    }
  }

  const ordered = [...preferred, ...matching, ...custom, ...unmatched];
  // Exact text matches (preferring the current selection when names collide)
  // sit at the top so Enter, clicking the first candidate, and blur resolve
  // identically.
  if (trimmed !== '' && preferred.length === 0) {
    const current = currentOptionValue(active, kind, value);
    const exactCurrent = current === null
      ? -1
      : ordered.findIndex(option => option.matched && option.value === current && option.text.toLowerCase() === needle);
    const promotedIndex = exactCurrent >= 0
      ? exactCurrent
      : ordered.findIndex(option => option.matched && !option.dimmed && option.text.toLowerCase() === needle);
    if (promotedIndex > 0) {
      const [promoted] = ordered.splice(promotedIndex, 1);
      ordered.unshift(promoted!);
    }
  }
  return ordered;
};

const draftPattern = (query: string): RegExp | null => {
  try { return new RegExp(query); } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

function InstancePart({ data, kind, t, value }: {
  data: ScopeExpressionData;
  kind: ScopeKind;
  t: TFunction;
  value: AccessScope | null;
}) {
  if (kind === 'upstream' && hasUpstreamInstance(value)) {
    const upstream = data.upstreams.find(candidate => candidate.id === value.upstreamId);
    return upstream
      ? <PartToken><UpstreamBadge label={upstream.name} upstream={upstream} /></PartToken>
      : <UnknownPart description={t('permissions.scope.unknownUpstreamId', { id: value.upstreamId })} />;
  }
  if (kind === 'user' && value?.kind === 'user') {
    const user = data.users.find(candidate => candidate.id === value.userId);
    return user
      ? <PartToken><UserIdentity isAdmin={user.isAdmin} username={user.username} /></PartToken>
      : <UnknownPart description={t('permissions.scope.unknownUserId', { id: String(value.userId) })} icon={<PersonRegular />} />;
  }
  if (kind === 'group' && value?.kind === 'group') {
    const group = data.groups.find(candidate => candidate.id === value.groupId);
    return group
      ? <PartToken><GroupIdentity group={group} /></PartToken>
      : <UnknownPart description={t('permissions.scope.unknownGroupId', { id: String(value.groupId) })} icon={<PeopleRegular />} />;
  }
  return null;
}

function ModelPart({ scope }: {
  scope: Extract<AccessScope, { kind: 'upstreamModel' }>;
}) {
  return <PartToken>
    {scope.model.kind === 'regex' ? <><TextAsteriskRegular className="floway-scope-expression-model-icon" /><RegexPattern pattern={scope.model.value} /></> : <><CubeRegular className="floway-scope-expression-model-icon" /><span className="floway-control-label font-mono" translate="no">{scope.model.value}</span></>}
  </PartToken>;
}

function RegexPattern({ pattern }: { pattern: string }) {
  const styles = useStyles();
  return <span className={mergeClasses('floway-control-label font-mono floway-scope-expression-regex', styles.regex)} translate="no">
    <span className="token regex">/<span dangerouslySetInnerHTML={{ __html: highlight(pattern, 'regex') }} />/</span>
  </span>;
}

function UnknownPart({ description, icon }: {
  description: string;
  icon?: ReactNode | undefined;
}) {
  const { t } = useTranslation();
  const { readOnly } = useContext(SegmentContext)!;
  return <Tooltip content={description} relationship="description">
    <span className="winui-focus-rect inline-flex max-w-full" tabIndex={readOnly ? 0 : undefined}>
      <PartToken className="floway-scope-expression-dimmed">{icon}
        <span className="floway-control-label">{t('permissions.scope.unknownLabel')}</span>
      </PartToken>
    </span>
  </Tooltip>;
}

const collectionScope = (kind: ScopeKind | null): AccessScope | null => {
  switch (kind) {
  case 'upstream': return { kind: 'upstreams' };
  case 'user': return { kind: 'users' };
  case 'group': return { kind: 'groups' };
  case 'self': return { kind: 'self' };
  case null: return null;
  }
};
const kindLabel = (kind: ScopeKind, t: TFunction) => t(`permissions.scope.kinds.${kind}`);
const hasUpstreamInstance = (scope: AccessScope | null): scope is Extract<AccessScope, { kind: 'upstream' | 'upstreamModel' }> => scope?.kind === 'upstream' || scope?.kind === 'upstreamModel';
const instanceMatchesKind = (kind: ScopeKind | null, scope: AccessScope | null) => kind === 'upstream'
  ? hasUpstreamInstance(scope)
  : kind === 'user' ? scope?.kind === 'user' : kind === 'group' && scope?.kind === 'group';
const partValue = (part: Part, kind: ScopeKind | null, value: AccessScope | null, data: ScopeExpressionData, t: TFunction): string => {
  if (part === 'kind' && kind !== null) return kindLabel(kind, t);
  if (part === 'model' && value?.kind === 'upstreamModel') return value.model.value;
  if (part === 'instance' && value !== null) return scopeResourceName(value, data) ?? scopeResourceId(value);
  return '';
};
