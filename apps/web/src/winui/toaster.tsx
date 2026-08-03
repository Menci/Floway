// Toast presentation, on Fluent's toast controller. `@fluentui/react-toast`
// splits into a state layer, a hook layer and a render layer and exports all
// three; only the container's own render function is closed, and all it does is
// name the presence component. Everything below re-states that render function
// and the shell around it, so the toast keeps Fluent's dispatch, queue, timeout,
// focus restoration and update semantics while the surface, the motion and the
// countdown are ours. The card and the title are wrapped here too, because the
// context carrying a toast's intent is exported by this package alone.
//
// This is the app's only value import of `@fluentui/react-toast`. The runtime
// bindings still arrive as an argument, so ../fluent.ts stays the one place a
// Fluent component surface is resolved and wrapped.
import {
  ToastContainerContextProvider,
  toastContainerClassNames,
  toasterClassNames,
  useToastAnnounce,
  useToastContainerContext,
  useToastContainerContextValues_unstable,
  useToastContainer_unstable,
  useToaster,
} from '@fluentui/react-toast';
import type {
  ToastAnnounce,
  ToastAnnounceOptions,
  ToastContainerProps,
  ToastData,
  ToastOffset,
  ToastPosition,
  ToasterProps,
} from '@fluentui/react-toast';
import * as React from 'react';

import { severityMark, winuiIntentAttribute } from './appearance';
import { createToastPresence } from './presence';
import { createReposition } from './reposition';
import { wrapFluent } from './wrap';
import type { FluentComponents, PropCarrier } from './wrap';

type Politeness = ToastAnnounceOptions['politeness'];

// The stack slot, which is what a reposition moves: the card travels inside it,
// so a card that is entering and a stack that is closing a gap never write the
// same element's transform.
const STACK_ITEM_CLASS = 'winui-toast-slot';

// Long enough for a screen reader to register that the region changed. Fluent's
// own live region holds each message for the same span.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-toast/library/src/components/AriaLive/useAriaLive.ts#L7-L8
const MESSAGE_HOLD_MS = 500;

interface LiveMessage {
  message: string;
  order: number;
  politeness: Politeness;
}

// Assertive ahead of polite, and within a politeness the oldest first. Dispatch
// order is counted rather than timed, because several toasts can be dispatched
// in one synchronous block and share a clock reading.
const byUrgency = (a: LiveMessage, b: LiveMessage) => {
  if (a.politeness === b.politeness) return a.order - b.order;
  return a.politeness === 'assertive' ? -1 : 1;
};

/**
 * The toaster's live regions.
 *
 * Both regions are mounted for the lifetime of the toaster and start empty: a
 * live region that is inserted already carrying text announces nothing, because
 * assistive technology reports changes to a region it was already observing.
 * Writing is therefore always a text change inside a region that has been there
 * all along, and it is deferred by a frame so the change lands in a paint of its
 * own rather than in the same one that mounted the toast.
 */
const AriaLive = ({ announceRef }: { announceRef: React.RefObject<ToastAnnounce> }) => {
  const [current, setCurrent] = React.useState<LiveMessage>();
  const currentRef = React.useRef<LiveMessage>(undefined);
  const queue = React.useRef<LiveMessage[]>([]);
  const dispatched = React.useRef(0);
  const frame = React.useRef(0);

  const pump = React.useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const next = queue.current.shift();
      // Written here rather than from the effect below: `announce` reads this
      // to decide whether the pump is idle, and between this callback and the
      // commit it schedules there is a window in which an effect can announce.
      // A mirror written only on commit still holds the message just retired,
      // so the announcement would be queued behind a pump nothing restarts.
      currentRef.current = next;
      setCurrent(next);
    });
  }, []);

  React.useEffect(() => () => cancelAnimationFrame(frame.current), []);

  React.useEffect(() => {
    if (!current) return;
    const timer = setTimeout(pump, MESSAGE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [current, pump]);

  React.useImperativeHandle(announceRef, () => (message, { politeness }) => {
    if (message === currentRef.current?.message) return;
    queue.current.push({ message, order: dispatched.current++, politeness });
    queue.current.sort(byUrgency);
    if (!currentRef.current) pump();
  }, [pump]);

  return <>
    <div aria-live="assertive" className="sr-only">{current?.politeness === 'assertive' ? current.message : undefined}</div>
    <div aria-live="polite" className="sr-only">{current?.politeness === 'polite' ? current.message : undefined}</div>
  </>;
};

interface CountdownProps {
  onTimeout: () => void;
  running: boolean;
  timeout: number;
}

// The remaining time, as the bar WinUI would draw it. It is Fluent's timer slot
// rather than a second mechanism beside it: one CSS animation whose duration is
// the timeout and whose end event is what closes the toast, so pausing the
// animation pauses the toast, exactly, and resuming carries on from where it
// stopped instead of restarting. A negative timeout is Fluent's own sentinel for
// a toast that never expires, and it draws no bar for one.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-toast/library/src/components/Timer/Timer.tsx#L23-L25
const Countdown = ({ onTimeout, running, timeout }: CountdownProps) => (timeout < 0 ? null : <span
  className={toastContainerClassNames.timer}
  data-timer-status={running ? 'running' : 'paused'}
  onAnimationEnd={onTimeout}
  style={{ animationDuration: `${timeout}ms`, animationPlayState: running ? 'running' : 'paused' }}
/>);

const createToastContainer = (components: FluentComponents) => {
  const ToastPresence = createToastPresence(components);

  const WinuiToastContainer = (props: ToastContainerProps) => {
    const state = useToastContainer_unstable(props, null);
    const contextValues = useToastContainerContextValues_unstable(state);
    const { children, ...root } = state.root;
    const { onTimeout, running, timeout } = state.timer;

    // The slot is transparent to the accessibility tree so that the stack's list
    // role still sees its items as its own children.
    //
    // A toast held behind the toaster's limit is rendered here too, with
    // `visible` false, and `unmountOnExit` is what keeps it out of the document
    // until a slot frees: a presence component that stays mounted runs the exit
    // motion on it immediately, and the finish of that motion is Fluent's own
    // signal to drop the toast from the queue for good.
    // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-toast/library/src/state/vanilla/createToaster.ts#L161-L165
    // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-toast/library/src/state/vanilla/createToaster.ts#L123-L141
    // https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-toast/library/src/components/ToastContainer/useToastContainer.ts#L131-L134
    return <ToastContainerContextProvider value={contextValues.toast}>
      <div className={STACK_ITEM_CLASS} role="presentation">
        <ToastPresence appear onMotionFinish={state.onMotionFinish} unmountOnExit visible={state.visible}>
          <div {...root} className={[toastContainerClassNames.root, root.className].filter(Boolean).join(' ')}>
            {children}
            <Countdown key={state.updateId} onTimeout={onTimeout} running={running} timeout={timeout} />
          </div>
        </ToastPresence>
      </div>
    </ToastContainerContextProvider>;
  };

  return WinuiToastContainer;
};

// Every position a toast can be dispatched to, in one fixed order so that the
// stacks keep their document order as they come and go. Fluent publishes the
// same list, but only from a barrel its package exports does not reach; the
// element type is exported, so the set is checked rather than asserted.
const STACK_POSITIONS: readonly ToastPosition[] = [
  'bottom',
  'bottom-start',
  'bottom-end',
  'top-start',
  'top-end',
  'top',
];

interface StackInset {
  horizontal?: number;
  vertical?: number;
}

// A caller states its offset either once for every position or per position, and
// the two shapes are not discriminable: every property of the uniform one is
// optional, so the presence of a key cannot rule it out of the other branch.
const insetFor = (offset: ToastOffset | undefined, position: ToastPosition): StackInset => {
  if (!offset) return {};
  if ('horizontal' in offset || 'vertical' in offset) return offset;
  return (offset as Partial<Record<ToastPosition, StackInset>>)[position] ?? {};
};

// Where a stack sits in the viewport. This is Fluent's own computation, out of
// reach for the same reason, restated with its axes, its flip on reading
// direction and its default insets unchanged -- those insets are Fluent's
// numbers, kept for the reason the stack's width and gap are.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-toast/library/src/state/vanilla/getPositionStyles.ts#L19-L21
const stackPlacement = (
  position: ToastPosition,
  dir: 'ltr' | 'rtl',
  offset: ToastOffset | undefined,
): React.CSSProperties => {
  const centred = position === 'top' || position === 'bottom';
  const { horizontal = centred ? 0 : 20, vertical = 16 } = insetFor(offset, position);
  const block = position.startsWith('top') ? { top: vertical } : { bottom: vertical };

  if (centred) return { ...block, left: `calc(50% + ${horizontal}px)`, transform: 'translateX(-50%)' };

  return { ...block, ...(position.endsWith('start') === (dir === 'ltr') ? { left: horizontal } : { right: horizontal }) };
};

const isNode = (value: EventTarget | null): value is Node => value instanceof Node;

// What is left of the toaster's props once its options are taken out: the props
// of the div each position stack renders. Fluent maps its root slot onto every
// one of those stacks in the same way.
type StackRootProps = Omit<ToasterProps, keyof ToasterOptionProps>;

type ToasterOptionProps = Pick<
  ToasterProps,
  | 'announce'
  | 'inline'
  | 'limit'
  | 'mountNode'
  | 'offset'
  | 'pauseOnHover'
  | 'pauseOnWindowBlur'
  | 'position'
  | 'priority'
  | 'shortcuts'
  | 'timeout'
  | 'toasterId'
>;

// The card and the title read their intent from the container context this file
// already installs, which is the one place a toast's intent is in scope: the
// dispatched content is rendered inside it, and an update carries a new intent
// through it without the content being rewritten. `info` is what the container
// resolves an absent intent to, and an InfoBar without a severity is
// Informational too.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-toast/library/src/contexts/toastContainerContext.tsx#L13-L24
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-toast/library/src/components/ToastContainer/useToastContainer.ts#L44
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L15
const useToastIntent = () => useToastContainerContext().intent ?? 'info';

const useCardIntentProps = (props: PropCarrier) => ({ ...props, [winuiIntentAttribute]: useToastIntent() });

// WinUI paints the severity on the card and always shows its glyph, so an
// explicit media slot is the only thing that displaces the mark.
const useTitleSeverityProps = (props: { media?: unknown }) => {
  const intent = useToastIntent();
  return { ...props, media: props.media === undefined ? severityMark(intent) : props.media };
};

export const withWinuiToaster = (components: FluentComponents): FluentComponents => {
  const { Portal, useFluent, useFocusableGroup } = components;
  const ToastContainer = createToastContainer(components);

  interface StackProps {
    announce: ToastAnnounce;
    closeAllToasts: () => void;
    dir: 'ltr' | 'rtl';
    inline: boolean;
    isToastVisible: (toastId: string) => boolean;
    offset: ToasterProps['offset'];
    pauseAllToasts: () => void;
    playAllToasts: () => void;
    position: ToastPosition;
    rootProps: StackRootProps;
    toasts: ToastData[];
    tryRestoreFocus: () => void;
  }

  const ToastStack = ({
    announce,
    closeAllToasts,
    dir,
    inline,
    isToastVisible,
    offset,
    pauseAllToasts,
    playAllToasts,
    position,
    rootProps,
    toasts,
    tryRestoreFocus,
  }: StackProps) => {
    const { announceToast, toasterRef } = useToastAnnounce(announce);
    const focusableGroupAttribute = useFocusableGroup({
      tabBehavior: 'limited-trap-focus',
      ignoreDefaultKeydown: { Escape: true },
    });
    const element = React.useRef<HTMLDivElement>(null);
    const [reposition] = React.useState(createReposition);

    const ref = React.useCallback((node: HTMLDivElement | null) => {
      element.current = node;
      toasterRef(node);
    }, [toasterRef]);

    React.useLayoutEffect(() => {
      const node = element.current;
      if (!node) return;
      reposition([...node.querySelectorAll<HTMLElement>(`.${STACK_ITEM_CLASS}`)]);
    });

    // Fluent's own traversal between stacked toasts is internal and unexported,
    // so it is restated: the arrows step through the containers in document
    // order and wrap at both ends, and the whole stack holds while focus is
    // anywhere inside it, which is what stops a toast expiring under a reader.
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAllToasts();
      }

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const containers = [...event.currentTarget.querySelectorAll<HTMLElement>(`.${toastContainerClassNames.root}`)];
        const focused = containers.findIndex(container => isNode(event.target) && container.contains(event.target));
        if (focused >= 0) {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          containers[(focused + step + containers.length) % containers.length].focus();
        }
      }

      rootProps.onKeyDown?.(event);
    };

    const { className, style, ...rest } = rootProps;

    return <div
      {...rest}
      className={[toasterClassNames.root, className].filter(Boolean).join(' ')}
      data-toaster-position={position}
      onBlur={event => { if (!isNode(event.relatedTarget) || !event.currentTarget.contains(event.relatedTarget)) playAllToasts(); }}
      onFocus={event => { if (!isNode(event.relatedTarget) || !event.currentTarget.contains(event.relatedTarget)) pauseAllToasts(); }}
      onKeyDown={onKeyDown}
      ref={ref}
      role="list"
      style={{ position: inline ? 'absolute' : 'fixed', ...stackPlacement(position, dir, offset), ...style }}
      {...focusableGroupAttribute}
    >
      {toasts.map(toast => <ToastContainer
        {...toast}
        announce={announceToast}
        intent={toast.intent}
        key={toast.toastId}
        tryRestoreFocus={tryRestoreFocus}
        visible={isToastVisible(toast.toastId)}
      >{toast.content as React.ReactNode}</ToastContainer>)}
    </div>;
  };

  const WinuiToaster = (props: ToasterProps) => {
    const {
      announce: announceProp,
      inline = false,
      limit,
      mountNode,
      offset,
      pauseOnHover,
      pauseOnWindowBlur,
      position,
      priority,
      shortcuts,
      timeout,
      toasterId,
      ...rootProps
    } = props;
    const announceRef = React.useRef<ToastAnnounce>(() => undefined);
    const announce = React.useCallback<ToastAnnounce>(
      (message, announceOptions) => announceRef.current(message, announceOptions),
      [],
    );
    const { dir } = useFluent();
    const {
      closeAllToasts,
      isToastVisible,
      pauseAllToasts,
      playAllToasts,
      toastsToRender,
      tryRestoreFocus,
    } = useToaster({ limit, pauseOnHover, pauseOnWindowBlur, position, priority, shortcuts, timeout, toasterId });

    const stacks = STACK_POSITIONS.filter(stackPosition => toastsToRender.has(stackPosition)).map(stackPosition => <ToastStack
      announce={announceProp ?? announce}
      closeAllToasts={closeAllToasts}
      dir={dir}
      inline={inline}
      isToastVisible={isToastVisible}
      key={stackPosition}
      offset={offset}
      pauseAllToasts={pauseAllToasts}
      playAllToasts={playAllToasts}
      position={stackPosition}
      rootProps={rootProps}
      toasts={toastsToRender.get(stackPosition) ?? []}
      tryRestoreFocus={tryRestoreFocus}
    />);

    return <>
      {announceProp ? null : <AriaLive announceRef={announceRef} />}
      {inline ? stacks : <Portal mountNode={mountNode}>{stacks}</Portal>}
    </>;
  };

  WinuiToaster.displayName = 'Toaster';

  return {
    ...components,
    Toast: wrapFluent(components.Toast, useCardIntentProps),
    Toaster: WinuiToaster,
    ToastTitle: wrapFluent(components.ToastTitle, useTitleSeverityProps),
  };
};
