import { ChevronDownRegular, ChevronRightRegular, DismissRegular, MoreHorizontalRegular, SearchRegular } from '@fluentui/react-icons';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { List, useDynamicRowHeight, type ListImperativeAPI, type RowComponentProps } from 'react-window';

import { renderStreamEvents, streamEventsCopyText, type CollectKind, type RenderedStreamEvent } from './stream-render';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { CodeBlock } from '../ui/code-block';
import { EmptyStateLine } from '../ui/empty-state';
import { Input } from '../ui/fluent-form-controls';
import { PANEL_BAND_CLASS } from '../ui/panel';
import { useScrollAreaHost } from '../ui/scroll-area';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import type { DumpStreamEvent } from '@floway-dev/gateway/dump-types';

const { Button, Menu, MenuItem, MenuItemCheckbox, MenuList, MenuPopover, MenuTrigger, Text, mergeClasses } = fluentComponents;

type IndexedEvent = RenderedStreamEvent & { index: number };
interface EventRowProps {
  events: IndexedEvent[];
  collapsed: Set<number>;
  toggle: (index: number) => void;
  wrap: boolean;
}

function EventRow({ index, style, ariaAttributes, events, collapsed, toggle, wrap }: RowComponentProps<EventRowProps>) {
  const event = events[index]!;
  const { t } = useTranslation();
  const { copy, outcomeFor } = useCopyToClipboard();
  const closed = collapsed.has(event.index);
  const label = `#${event.index + 1} ${event.event ?? t('dashboard.requests.streamEvent')}`;
  return <div {...ariaAttributes} style={style} className="px-[var(--floway-panel-inset)] pb-[var(--spacingVerticalS)]">
    <CodeBlock
      code={event.text}
      collapsed={closed}
      wrap={wrap}
      copyOutcome={outcomeFor()}
      onCopy={() => copy(event.text)}
      language={event.parseError || event.text === '[DONE]' ? 'plain' : 'json'}
      header={<div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
        <Button appearance="subtle" size="small" icon={closed ? <ChevronRightRegular /> : <ChevronDownRegular />} aria-expanded={!closed} onClick={() => toggle(event.index)}>{label}</Button>
        <Text size={100} className="font-mono text-fui-fg3">+{event.timestamp.toFixed(event.timestamp < 1 ? 3 : 0)}ms</Text>
        {event.parseError && <Text size={100}>{t('dashboard.requests.eventParseError')}</Text>}
      </div>}
    />
  </div>;
}

export function EventList({ events, kind, toolbarStart }: { events: DumpStreamEvent[]; kind: CollectKind | null; toolbarStart: ReactNode }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [wrap, setWrap] = useState(true);
  const [list, setList] = useState<ListImperativeAPI | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { hostProps } = useScrollAreaHost({ axes: 'vertical', noTabIndex: true, viewport: list?.element ?? null });
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const rendered = useMemo(() => renderStreamEvents(kind, events).map((event, index) => ({ ...event, index })), [events, kind]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? rendered.filter(event => `${event.index + 1} ${event.event ?? ''} ${event.text}`.toLocaleLowerCase().includes(needle)) : rendered;
  }, [query, rendered]);
  const toggle = useCallback((index: number) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  }), []);
  const rowProps = useMemo(() => ({ events: filtered, collapsed, toggle, wrap }), [collapsed, filtered, toggle, wrap]);
  // An estimate only: react-window measures every mounted block and updates its height on collapse.
  const rowHeight = useDynamicRowHeight({ defaultRowHeight: 260, key: query });
  const changeQuery = (value: string) => {
    setQuery(value);
    list?.element?.scrollTo({ top: 0 });
  };
  return <div className="h-full min-h-0 flex flex-col">
    <div className={`${PANEL_BAND_CLASS} flex items-center gap-2 min-w-0 shrink-0`}>
      <div className="min-w-0">{toolbarStart}</div>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <TooltipIconButton icon={<SearchRegular />} label={t('dashboard.requests.findEvents')} onClick={() => { setSearchOpen(true); requestAnimationFrame(() => inputRef.current?.focus()); }} />
        <TooltipIconButton icon={copyOutcomeIcon(outcomeFor())} label={copyLabel(outcomeFor(), t('common.copy.action'))} onClick={() => copy(streamEventsCopyText(kind, events))} />
        <Menu checkedValues={{ wrap: wrap ? ['on'] : [] }} onCheckedValueChange={(_, data) => setWrap(data.checkedItems.includes('on'))}>
          <MenuTrigger disableButtonEnhancement><Button appearance="subtle" size="small" icon={<MoreHorizontalRegular />} aria-label={t('dashboard.requests.eventOptions')} /></MenuTrigger>
          <MenuPopover><MenuList>
            <MenuItem onClick={() => setCollapsed(new Set(rendered.map(event => event.index)))}>{t('dashboard.requests.collapseEvents')}</MenuItem>
            <MenuItem onClick={() => setCollapsed(new Set())}>{t('dashboard.requests.expandEvents')}</MenuItem>
            <MenuItemCheckbox name="wrap" value="on">{t('common.bodyViewer.wrap')}</MenuItemCheckbox>
          </MenuList></MenuPopover>
        </Menu>
      </div>
    </div>
    {searchOpen && <div className={`${PANEL_BAND_CLASS} flex items-center gap-2 shrink-0`}>
      <Input ref={inputRef} className="flex-1" aria-label={t('dashboard.requests.findEvents')} placeholder={t('dashboard.requests.findEvents')} value={query} onChange={(_, data) => changeQuery(data.value)} />
      <Text size={200} className="text-fui-fg3">{filtered.length} / {events.length}</Text>
      <TooltipIconButton icon={<DismissRegular />} label={t('common.dismiss')} onClick={() => { setSearchOpen(false); changeQuery(''); }} />
    </div>}
    {filtered.length === 0 ? <EmptyStateLine className="p-4">{t('dashboard.requests.noEventMatches')}</EmptyStateLine> : <div {...hostProps} className={mergeClasses(hostProps.className, 'flex-1 min-h-0')}>
      <List
        aria-label={t('dashboard.requests.events', { count: events.length })}
        listRef={setList}
        rowComponent={EventRow}
        rowCount={filtered.length}
        rowHeight={rowHeight}
        rowProps={rowProps}
        overscanCount={2}
        style={{ height: '100%', overflowX: 'hidden' }}
      />
    </div>}
  </div>;
}
