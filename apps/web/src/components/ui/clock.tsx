import { useEffect, useLayoutEffect, useRef } from 'react';

import { TimePicker } from './time-picker';
import { useTranslation } from '../../i18n/translation';
import { useLocale } from '../../lib/use-locale';

// Clock.xaml places a 178px face in a 10px-margin Grid inside a 250px Viewbox.
// CirclePanel arranges 30px hour buttons on a 130px diameter, starting at -60°.
// https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/Controls/Clock.xaml#L39-L78
// https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Panel/CirclePanel.cs
const FACE_SIZE = 178;
const FACE_MARGIN = 10;
const VIEWBOX_SIZE = 250;
const SCALE = VIEWBOX_SIZE / (FACE_SIZE + FACE_MARGIN * 2);
const HOUR_DIAMETER = 130;
const HOUR_OFFSET_DEGREES = -60;
// Native Line's negative geometry leaves a 1px centered layout box. Ellipse
// strokes fit inside its declared size; SVG strokes straddle the outline.
// https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Themes/Styles/Controls/Clock.xaml#L74-L75
// https://github.com/microsoft/microsoft-ui-xaml/blob/4f685bc779bfbbaf7c01d9ec7e114565c4e2c768/dxaml/xcp/core/core/elements/shape.cpp#L597-L629
// https://github.com/microsoft/microsoft-ui-xaml/blob/4f685bc779bfbbaf7c01d9ec7e114565c4e2c768/dxaml/xcp/core/core/elements/shape.cpp#L861-L870
const HAND_ORIGIN = (FACE_SIZE - 1) / 2;
const HAND_LENGTH = 55;
const HAND_STROKE = 2;
const CENTER_SIZE = 8;

export function Clock({ active, label, onChange, surfaceRef, value, values }: {
  active: boolean;
  label: string;
  onChange: (value: number) => void;
  surfaceRef: (element: HTMLDivElement | null) => void;
  value: number;
  values: number[];
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const date = new Date(value);
  const hour = date.getHours();
  const minute = date.getMinutes();
  const pm = hour >= 12;
  const faceRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const hourRefs = useRef(new Map<number, HTMLButtonElement>());
  const periodRefs = useRef(new Map<boolean, HTMLButtonElement>());
  useLayoutEffect(() => {
    if (!active) return;
    faceRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
  }, [active]);
  const nearest = (choices: number[]) => choices.reduce<number | undefined>((best, entry) => best === undefined || Math.abs(entry - value) < Math.abs(best - value) ? entry : best, undefined);
  const timeAtHour = (nextHour: number) => nearest(values.filter(entry => new Date(entry).getHours() === nextHour));
  const chooseHour = (nextHour: number) => {
    const next = timeAtHour(nextHour);
    if (next !== undefined) onChange(next);
  };
  // The source grid defines the available minute phases, including fractional
  // UTC offsets and DST. Hand interactions cannot introduce unsupported times.
  const chooseMinute = (requested: number) => {
    const choices = values.filter(entry => new Date(entry).getHours() === hour);
    const minuteDistance = (entry: number) => {
      const distance = Math.abs(new Date(entry).getMinutes() - requested);
      return Math.min(distance, 60 - distance);
    };
    const next = choices.reduce((best, entry) => minuteDistance(entry) < minuteDistance(best) ? entry : best, value);
    onChange(next);
  };
  useEffect(() => {
    const face = faceRef.current;
    if (!face) throw new Error('The clock face must be mounted');
    const wheel = (event: WheelEvent) => { event.preventDefault(); chooseMinute((minute + (event.deltaY > 0 ? 1 : -1) + 60) % 60); };
    face.addEventListener('wheel', wheel, { passive: false });
    return () => face.removeEventListener('wheel', wheel);
  });
  const timeText = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return <div className="floway-clock">
    <TimePicker active={active} label={label} onChange={onChange} surfaceRef={surfaceRef} value={value} values={values}>
      <button aria-label={label} className="floway-clock-title" type="button">{timeText}</button>
    </TimePicker>
    <div className="floway-clock-viewbox" ref={faceRef}>
      <div className="floway-clock-canvas" style={{ transform: `scale(${SCALE})` }}>
        <div className="floway-clock-face" onPointerDown={event => {
          if (event.button !== 0 || (event.target instanceof Element && event.target.closest('[role="radio"]'))) return;
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }} onPointerUp={() => { dragging.current = false; }} onLostPointerCapture={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }} onPointerMove={event => {
          if (!dragging.current) return;
          const rect = event.currentTarget.getBoundingClientRect();
          // The source's pointer reference is (85,85), distinct from face center.
          // https://github.com/ghost1372/DevWinUI/blob/42a6f0e8445e7911ba8e81a88f2215547b425be1/dev/DevWinUI/Controls/Native/Date/Clock/Clock.cs#L291-L311
          const angle = (Math.atan2((event.clientY - rect.y) / SCALE - 85, (event.clientX - rect.x) / SCALE - 85) * 180 / Math.PI + 450) % 360;
          chooseMinute(Math.floor(angle / 6));
        }}>
          <div aria-label={t('common.dateTime.hour')} className="floway-clock-hours" role="radiogroup">
            {Array.from({ length: 12 }, (_, index) => {
              const number = index + 1;
              const nextHour = number % 12 + (pm ? 12 : 0);
              const angle = (index * 30 + HOUR_OFFSET_DEGREES) * Math.PI / 180;
              const selected = hour % 12 === number % 12;
              return <button aria-checked={selected} aria-label={t('common.dateTime.clockHour').replace('{0}', String(number))} className="floway-clock-hour" disabled={timeAtHour(nextHour) === undefined} key={number} onClick={() => chooseHour(nextHour)} onKeyDown={event => {
                const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const next = (number - 1 + step + 12) % 12 + 1;
                chooseHour(next % 12 + (pm ? 12 : 0));
                hourRefs.current.get(next)?.focus({ preventScroll: true });
              }} ref={element => { if (element) hourRefs.current.set(number, element); else hourRefs.current.delete(number); }} role="radio" style={{ left: FACE_SIZE / 2 + Math.cos(angle) * HOUR_DIAMETER / 2, top: FACE_SIZE / 2 + Math.sin(angle) * HOUR_DIAMETER / 2 }} tabIndex={selected ? 0 : -1} type="button">{number}</button>;
            })}
          </div>
          <svg aria-hidden="true" className="floway-clock-hand" viewBox={`0 0 ${FACE_SIZE} ${FACE_SIZE}`}><line stroke="currentColor" strokeWidth={HAND_STROKE} x1={HAND_ORIGIN} x2={HAND_ORIGIN} y1={HAND_ORIGIN} y2={HAND_ORIGIN - HAND_LENGTH} style={{ transform: `rotate(${minute * 6}deg)`, transformOrigin: `${HAND_ORIGIN}px ${HAND_ORIGIN}px` }} /><circle cx={FACE_SIZE / 2} cy={FACE_SIZE / 2} fill="white" r={(CENTER_SIZE - HAND_STROKE) / 2} stroke="currentColor" strokeWidth={HAND_STROKE} /></svg>
          <div aria-label={t('common.dateTime.minute')} className="floway-clock-minute-focus winui-focus-rect" onKeyDown={event => {
            const step = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? -1 : 0;
            if (!step) return;
            event.preventDefault(); chooseMinute((minute + step + 60) % 60);
          }} role="spinbutton" aria-valuenow={minute} aria-valuemin={0} aria-valuemax={59} tabIndex={0} />
        </div>
      </div>
    </div>
    <div aria-label={t('common.dateTime.clockPeriod')} className="floway-clock-period" role="radiogroup">
      {[false, true].map(period => <button aria-checked={pm === period} aria-label={t(period ? 'common.dateTime.pm' : 'common.dateTime.am')} className={period ? 'floway-clock-pm' : 'floway-clock-am'} disabled={timeAtHour(hour % 12 + (period ? 12 : 0)) === undefined} key={String(period)} onClick={() => chooseHour(hour % 12 + (period ? 12 : 0))} onKeyDown={event => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); chooseHour(hour % 12 + (!period ? 12 : 0));
        periodRefs.current.get(!period)?.focus({ preventScroll: true });
      }} ref={element => { if (element) periodRefs.current.set(period, element); else periodRefs.current.delete(period); }} role="radio" tabIndex={pm === period ? 0 : -1} type="button">{t(period ? 'common.dateTime.pm' : 'common.dateTime.am')}</button>)}
    </div>
  </div>;
}
