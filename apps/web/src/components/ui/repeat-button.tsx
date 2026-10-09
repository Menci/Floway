import { useCallback, useEffect, useLayoutEffect, useRef, type ComponentProps } from 'react';

// Native RepeatButton fires on press, then repeats after its delay while held.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L714-L719
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/RepeatButton_Partial.cpp#L493-L574
const DELAY_MS = 500;
const INTERVAL_MS = 33;

export function RepeatButton({ active, onPress, ...props }: Omit<ComponentProps<'button'>, 'onClick'> & { active: boolean; onPress: () => void }) {
  const pressRef = useRef(onPress);
  useLayoutEffect(() => { pressRef.current = onPress; }, [onPress]);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (delayRef.current !== null) clearTimeout(delayRef.current);
    if (intervalRef.current !== null) clearInterval(intervalRef.current);
    delayRef.current = null;
    intervalRef.current = null;
  }, []);
  useEffect(() => stop, [active, stop]);
  const start = () => {
    stop();
    delayRef.current = setTimeout(() => {
      pressRef.current();
      intervalRef.current = setInterval(() => pressRef.current(), INTERVAL_MS);
    }, DELAY_MS);
  };
  return <button {...props} type="button" onPointerDown={event => {
    if (event.button !== 0) return;
    event.preventDefault();
    pressRef.current();
    start();
  }} onPointerUp={stop} onPointerCancel={stop} onPointerLeave={stop} onPointerEnter={event => { if (event.buttons & 1) start(); }} onClick={event => { if (event.detail === 0) pressRef.current(); }} />;
}
