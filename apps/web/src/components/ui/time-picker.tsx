import { Checkmark16Regular, Dismiss16Regular, CaretUp12Filled, CaretDown12Filled } from '@fluentui/react-icons';
import { useId, useLayoutEffect, useRef, useState, cloneElement, type ComponentProps, type ReactElement, type CSSProperties } from 'react';

import { RepeatButton } from './repeat-button';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { createPickerFlyoutPresence } from '../../winui/presence';

const { Popover, PopoverSurface, PopoverTrigger } = fluentComponents;
const PickerFlyoutMotion = createPickerFlyoutPresence(fluentComponents);
const ITEM_HEIGHT = 40;
const FOOTER_HEIGHT = 41;
// Native looping extent is viewport + 1001 item slots. Only the viewport and
// its neighboring slots need elements; rebasing keeps the wheel cyclic.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/phone/lib/LoopingSelector_Partial.cpp#L1811-L1856
const LOOP_SLOTS = 1001;

// The TimePicker's 24-hour faceplate has separate hour/minute columns. UTC
// source precision constrains the minute column to the local offset's phase.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TimePicker_themeresources.xaml#L113-L250
export function TimePicker({ active, children, label, onChange, surfaceRef, value, values }: {
  active: boolean;
  children: ReactElement<ComponentProps<'button'>>;
  label: string;
  onChange: (value: number) => void;
  surfaceRef: (element: HTMLDivElement | null) => void;
  value: number;
  values: number[];
}) {
  const { t } = useTranslation();
  const optionPrefix = useId();
  const [openState, setOpenState] = useState({ active, open: false });
  const open = openState.active === active && openState.open;
  if (openState.active !== active) setOpenState({ active, open: false });
  const setOpen = (next: boolean) => setOpenState({ active, open: next });
  const hourRef = useRef<HTMLDivElement>(null);
  const minuteRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // The native presenter commits only on confirmation; dismissal discards its selection.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/phone/lib/TimePickerFlyout_Partial.cpp#L102-L126
  const [pendingValue, setPendingValue] = useState(value);
  // A canceled scroll can finish after a newer command starts. Retain the
  // requested destination until that command reaches its own end position.
  const scrollTarget = useRef<number | null>(null);
  const initialPosition = useRef(0);
  const selected = values.indexOf(open ? pendingValue : value);
  if (selected === -1) throw new RangeError('The selected time must belong to the source grid');
  const center = Math.floor(LOOP_SLOTS / 2 / values.length) * values.length;
  const [position, setPosition] = useState(center + selected);
  const positionRef = useRef(position);
  const date = new Date(value);
  const minute = String(date.getMinutes()).padStart(2, '0');
  useLayoutEffect(() => {
    if (!open) return;
    const scroll = hourRef.current;
    if (!scroll) throw new Error('The time wheel must be mounted when open');
    scroll.scrollTop = initialPosition.current * ITEM_HEIGHT;
    scroll.style.setProperty('--floway-picker-scroll-top', `${scroll.scrollTop}px`);
    scroll.focus({ preventScroll: true });
  }, [open]);
  const select = (index: number, scroll: boolean) => {
    const ordinal = (index % values.length + values.length) % values.length;
    const rebased = index < values.length || index > LOOP_SLOTS - values.length;
    const target = rebased ? center + ordinal : index;
    setPendingValue(values[ordinal]);
    positionRef.current = target;
    setPosition(target);
    if (hourRef.current) {
      scrollTarget.current = target;
      hourRef.current.scrollTo({ top: target * ITEM_HEIGHT, behavior: rebased || !scroll || window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  };
  const accept = () => { onChange(pendingValue); setOpen(false); };
  const cancel = () => setOpen(false);
  const first = Math.max(0, position - 6);
  const last = Math.min(LOOP_SLOTS, position + 7);
  return <Popover open={open && active} surfaceMotion={{ children: (_, props) => <PickerFlyoutMotion {...props} /> }} onOpenChange={(_, data) => {
    if (data.open) { scrollTarget.current = null; setPendingValue(value); initialPosition.current = center + selected; positionRef.current = initialPosition.current; setPosition(initialPosition.current); }
    setOpen(data.open);
  }} positioning={{
    position: 'below', align: 'start', matchTargetSize: 'width',
    offset: ({ targetRect, positionedRect }) => -(positionedRect.height - FOOTER_HEIGHT + targetRect.height) / 2,
    onPositioningEnd: () => {
      const surface = popupRef.current;
      const trigger = triggerRef.current;
      if (!surface || !trigger) throw new Error('The time picker must be mounted when positioned');
      const face = trigger.getBoundingClientRect();
      const popup = surface.getBoundingClientRect();
      const offset = face.y + face.height / 2 - popup.y - popup.height / 2;
      surface.style.setProperty('--floway-picker-center-offset', `${offset  }px`);
      surface.style.setProperty('--floway-picker-open-half', `${Math.max(popup.height / 4, Math.abs(offset))  }px`);
      surface.style.setProperty('--floway-picker-full-half', `${popup.height / 2 + Math.abs(offset)  }px`);
      surface.style.setProperty('--floway-picker-close-half', `${Math.max(popup.height * 0.075, Math.abs(offset) - popup.height * 0.35)  }px`);
    },
    fallbackPositions: [],
  }}>
    <PopoverTrigger disableButtonEnhancement>{cloneElement(children, { ref: triggerRef })}</PopoverTrigger>
    <PopoverSurface aria-label={label} className="floway-time-picker-surface" ref={element => { popupRef.current = element; surfaceRef(element); }} onKeyDown={event => {
      const column = event.target === hourRef.current || event.target === minuteRef.current;
      if (column && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        (event.key === 'ArrowLeft' ? hourRef : minuteRef).current?.focus({ preventScroll: true });
        return;
      }
      if (column && (event.key === 'Enter' || event.key === ' ' || (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')))) { event.preventDefault(); accept(); return; }
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); cancel();
    }}>
      <div className="floway-time-picker-selection" />
      <div className="floway-time-picker-columns">
        <div className="floway-time-picker-column">
          <RepeatButton active={open && active} aria-label={t('common.dateTime.previousHour')} className="floway-time-picker-repeat floway-time-picker-repeat-up" onPress={() => select(positionRef.current - 1, true)} tabIndex={-1} type="button"><CaretUp12Filled /></RepeatButton>
          <div aria-activedescendant={optionPrefix + position} aria-label={t('common.dateTime.hour')} className="floway-time-picker-wheel winui-focus-rect" onWheel={() => { scrollTarget.current = null; }} onPointerDown={event => {
            if (event.pointerType === 'mouse') { event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); }
            scrollTarget.current = null;
          }} onScrollEnd={event => {
            if (!open || !active) return;
            const scroll = event.currentTarget;
            if (scrollTarget.current !== null && Math.abs(scroll.scrollTop - scrollTarget.current * ITEM_HEIGHT) > 0.5) return;
            scrollTarget.current = null;
            const index = Math.round(scroll.scrollTop / ITEM_HEIGHT);
            if (Math.abs(scroll.scrollTop - index * ITEM_HEIGHT) > 0.5) select(index, true);
          }} ref={hourRef} role="listbox" tabIndex={0} onKeyDown={event => {
            if (event.altKey) return;
            let next: number;
            if (event.key === 'ArrowUp') next = position - 1;
            else if (event.key === 'ArrowDown') next = position + 1;
            else if (event.key === 'Home') next = center;
            else if (event.key === 'End') next = center + values.length - 1;
            else if (event.key === 'PageUp' || event.key === 'PageDown') next = position + (event.key === 'PageUp' ? -1 : 1) * Math.round(event.currentTarget.clientHeight / ITEM_HEIGHT / 2);
            else return;
            event.preventDefault(); select(next, event.key !== 'Home' && event.key !== 'End');
          }} onScroll={event => {
            const scroll = event.currentTarget;
            scroll.style.setProperty('--floway-picker-scroll-top', `${scroll.scrollTop}px`);
            if (!open || !active || scrollTarget.current !== null) return;
            const index = Math.round(scroll.scrollTop / ITEM_HEIGHT);
            const ordinal = (index % values.length + values.length) % values.length;
            positionRef.current = index;
            setPosition(index);
            if (ordinal !== selected) setPendingValue(values[ordinal]);
            if (index < values.length || index > LOOP_SLOTS - values.length) {
              const target = center + ordinal;
              scroll.scrollTop = target * ITEM_HEIGHT;
              positionRef.current = target;
              setPosition(target);
            }
          }}>
            <div className="floway-time-picker-plane">
              {Array.from({ length: last - first }, (_, offset) => {
                const index = first + offset;
                const ordinal = index % values.length;
                const caption = String(new Date(values[ordinal]).getHours());
                const top = `calc((var(--floway-picker-viewport-height) - 40px) / 2 + ${index * ITEM_HEIGHT}px)`;
                return <button aria-label={caption} aria-selected={index === position} className="floway-time-picker-item" id={optionPrefix + index} key={index} onClick={() => select(index, true)} role="option" style={{ top, '--floway-picker-item-top': top } as CSSProperties} tabIndex={-1} type="button"><span>{caption}</span></button>;
              })}
            </div>
          </div>
          <RepeatButton active={open && active} aria-label={t('common.dateTime.nextHour')} className="floway-time-picker-repeat floway-time-picker-repeat-down" onPress={() => select(positionRef.current + 1, true)} tabIndex={-1} type="button"><CaretDown12Filled /></RepeatButton>
        </div>
        <div aria-label={t('common.dateTime.minute')} className="floway-time-picker-minute winui-focus-rect" ref={minuteRef} role="listbox" tabIndex={0}><div aria-selected="true" className="floway-time-picker-item" role="option"><span>{minute}</span></div></div>
      </div>
      <div className="floway-time-picker-footer"><button aria-label={t('common.dateTime.accept')} onClick={accept} type="button"><Checkmark16Regular /></button><button aria-label={t('common.cancel')} onClick={cancel} type="button"><Dismiss16Regular /></button></div>
    </PopoverSurface>
  </Popover>;
}
