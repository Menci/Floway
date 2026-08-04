import {
  ChevronDownRegular,
  ChevronUpRegular,
  DeleteRegular,
  DismissRegular,
  EditRegular,
  SettingsRegular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-playground';
import { useDashboardOutletContext } from './dashboard';
import { requireDashboardSession } from './guards';
import { api, callApi } from '../api/client';
import type { ApiKey, ControlPlaneModel } from '../api/types';
import { indexCatalog } from '../components/models/catalog-index';
import { ModelInfoBadges } from '../components/models/info-badges';
import { effectiveUpstreamCap, reachableModels } from '../components/models/reachability';
import { bingAccentForeground, bingAccentForegroundHover } from '../components/playground/bing-chat-tokens';
import { PlaygroundComposer } from '../components/playground/composer';
import { PlaygroundEditDialog, type PlaygroundMessageDraft } from '../components/playground/edit-dialog';
import { PlaygroundMarkdown } from '../components/playground/markdown';
import { PlaygroundMessageBubble } from '../components/playground/message-bubble';
import {
  createWireFetch,
  defaultMaxOutputTokens,
  generationOptions,
  parseCustomJson,
  playgroundApis,
  supportsImageInput,
  type PlaygroundApi,
  type PlaygroundMessage,
} from '../components/playground/request';
import { streamPlaygroundText } from '../components/playground/stream';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyState, EmptyStateLine } from '../components/ui/empty-state';
import { Combobox, Dropdown, Textarea } from '../components/ui/fluent-form-controls';
import { PANE_GAP_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ScrollArea } from '../components/ui/scroll-area';
import { SectionHeader } from '../components/ui/section-header';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { fluentComponents } from '../fluent';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { errorMessage, isAbortError } from '../lib/error-message';
import { prefersReducedMotion } from '../lib/reduced-motion';
import { useMediaQuery } from '../lib/use-media-query';

export const handle = dashboardWorkspaceHandle;

const {
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Option,
  OverlayDrawer,
  buttonClassNames,
  makeStyles,
  tokens,
} = fluentComponents;

// Fluent paints a Button's icon slot from a descendant rule of its own once the
// pointer is on it, so a colour stated on the root reaches the label and leaves
// the glyph.
const ICON = `& .${buttonClassNames.icon}`;

// Fluent states a disabled button's foreground on a single class, which a colour
// stated here outranks; a disabled button that stays focusable carries
// `aria-disabled` rather than `:disabled`.
const ENABLED = '&:not(:disabled):not([aria-disabled="true"])';
const HOVER = `${ENABLED}:hover`;
// Fluent's own pair: a press that began under the pointer, and a keyboard press.
const PRESSED = `${ENABLED}:hover:active, ${ENABLED}:active:focus-visible`;

// Important because ../winui/controls/button.css.ts states a subtle button's
// rest foreground as TextFillColorPrimary and its pressed one as
// TextFillColorSecondary, both on a doubled class name that a single Griffel
// class does not outrank. The transcript's actions belong to Bing's palette, so
// they take those two rules back.
const takenBack = (color: string) => `${color} !important`;

const reachedPaint = (color: string) => ({ color: takenBack(color), [ICON]: { color: takenBack(color) } });

// `null` is a fetch that failed, distinct from an empty list -- which would tell
// the operator to create a key.
interface LoaderData { keys: ApiKey[] | null; models: ControlPlaneModel[] | null; error: string | null }

export async function clientLoader(): Promise<LoaderData> {
  requireDashboardSession();
  const [keys, models] = await Promise.all([
    callApi(() => api.api.keys.$get()),
    callApi(() => api.api.models.$get({ query: {} })),
  ]);
  return {
    keys: keys.data ?? null,
    models: models.data?.data ?? null,
    error: keys.error?.message ?? models.error?.message ?? null,
  };
}

const useStyles = makeStyles({
  toolbar: { borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  // No third foreground step exists upstream, so the hover accent is held
  // through the press. Fluent clears forced-color-adjust on a reached button,
  // so the forced-colours Highlight pairing has to be restated here.
  //
  // The scheme reaches the paint as a custom property rather than as a second
  // set of painting rules: Griffel groups every media query into one bucket and
  // orders that bucket's sheets by comparing the conditions as strings, so a
  // `prefers-color-scheme` rule sorts after `forced-colors` and, painting the
  // same property on the same selector with the same `!important`, would take
  // the Highlight pairing back on a high-contrast dark theme.
  // https://github.com/microsoft/griffel/blob/fd8b4efb6b788e7844012740df4fc1227f621305/packages/core/src/renderer/createDOMRenderer.ts#L60
  // https://github.com/microsoft/griffel/blob/fd8b4efb6b788e7844012740df4fc1227f621305/packages/core/src/types.ts#L75-L104
  brandIconAction: {
    '--floway-playground-accent': bingAccentForeground.light,
    '--floway-playground-accent-reached': bingAccentForegroundHover.light,
    '@media (prefers-color-scheme: dark)': {
      '--floway-playground-accent': bingAccentForeground.dark,
      '--floway-playground-accent-reached': bingAccentForegroundHover.dark,
    },
    [ENABLED]: { color: takenBack('var(--floway-playground-accent)') },
    [HOVER]: reachedPaint('var(--floway-playground-accent-reached)'),
    [PRESSED]: reachedPaint('var(--floway-playground-accent-reached)'),
    '@media (forced-colors: active)': {
      [HOVER]: reachedPaint('Highlight'),
      [PRESSED]: reachedPaint('Highlight'),
    },
  },
  messageActions: {
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
    '@media (hover: none)': { opacity: 1 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  messageRow: { '&:hover .playground-message-actions, &:focus-within .playground-message-actions': { opacity: 1 } },
});

const randomId = () => crypto.randomUUID();

export default function DashboardPlayground({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const s = useStyles();
  const [playgroundApi, setPlaygroundApi] = useState<PlaygroundApi>('responses');
  const [keyId, setKeyId] = useState(loaderData.keys?.[0]?.id ?? '');
  const [publicModelId, setPublicModelId] = useState('');
  // `null` shows the selection; a string is a live search term. Opening the list
  // clears the field so the first keystroke starts a query.
  const [modelQuery, setModelQuery] = useState<string | null>(null);
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [system, setSystem] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [draft, setDraft] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [showImage, setShowImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState(loaderData.error);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState('{}');
  const [customError, setCustomError] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const editDialog = useDialogInvocation<PlaygroundMessage>();
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery('(max-width: 1100px)');

  const selectedKey = loaderData.keys?.find(key => key.id === keyId) ?? null;
  const cap = useMemo(
    () => effectiveUpstreamCap(selectedKey?.upstream_ids ?? null, user.upstreamIds),
    [selectedKey, user.upstreamIds],
  );
  const catalog = useMemo(() => indexCatalog(loaderData.models), [loaderData.models]);
  const models = useMemo(
    () => reachableModels(loaderData.models ?? [], cap, model => model.kind === 'chat'),
    [cap, loaderData.models],
  );
  const selectedModel = models.find(model => model.id === publicModelId) ?? models[0] ?? null;
  const imageEnabled = supportsImageInput(selectedModel);
  const effortOptions = selectedModel?.chat?.reasoning?.effort?.supported ?? [];
  const matchingModels = models.filter(model => {
    const query = (modelQuery ?? '').trim().toLowerCase();
    return !query || model.id.toLowerCase().includes(query) || model.display_name.toLowerCase().includes(query);
  });
  const sendTarget = selectedKey && selectedModel && (draft.trim() || imageUrl.trim())
    ? { apiKey: selectedKey, model: selectedModel }
    : null;

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // Reconciled during render so the picker's id and the catalog cannot disagree
  // for a frame.
  const resolvedPublicModelId = selectedModel?.id ?? '';
  if (resolvedPublicModelId !== publicModelId) setPublicModelId(resolvedPublicModelId);

  // Reconciled during render so the composer never paints a stale attachment.
  if (!imageEnabled && (showImage || imageUrl !== '')) {
    setShowImage(false);
    setImageUrl('');
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [messages, sending]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const changeContext = (change: () => void) => {
    stop();
    setRequestError(null);
    setCustomError(null);
    change();
  };

  const send = async () => {
    const text = draft.trim();
    const image = imageUrl.trim();
    if (sending || !sendTarget) return;
    if (image && !imageEnabled) {
      setRequestError(t('dashboard.playground.errors.imageUnsupported'));
      return;
    }
    if (image) {
      try { new URL(image); } catch {
        setRequestError(t('dashboard.playground.errors.imageUrl'));
        return;
      }
    }
    const customResult = parseCustomJson(playgroundApi, customDraft);
    if (customResult.error) {
      const message = customResult.error === 'reserved'
        ? t('dashboard.playground.errors.customReserved', { fields: customResult.fields.join(', ') })
        : t(customResult.error === 'invalid'
            ? 'dashboard.playground.errors.customInvalid'
            : 'dashboard.playground.errors.customObject');
      setCustomError(message);
      return;
    }

    const userMessage: PlaygroundMessage = { id: randomId(), role: 'user', text, ...(image && { imageUrl: image }) };
    const context = [...messages, userMessage];
    setMessages(context);
    setDraft('');
    setImageUrl('');
    setShowImage(false);
    setSending(true);
    setRequestError(null);
    setCustomError(null);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const wireFetch = createWireFetch(customResult.value, playgroundApi);

      const assistantId = randomId();
      let assistantText = '';
      let renderFrame: number | null = null;
      const commitAssistantText = () => {
        renderFrame = null;
        const text = assistantText;
        setMessages(current => {
          const existing = current.findIndex(message => message.id === assistantId);
          if (existing < 0) return [...current, { id: assistantId, role: 'assistant', text }];
          return current.map(message => message.id === assistantId ? { ...message, text } : message);
        });
      };
      for await (const delta of streamPlaygroundText({
        api: playgroundApi,
        apiKey: sendTarget.apiKey.key,
        model: sendTarget.model.id,
        system: system.trim(),
        messages: context,
        options: generationOptions(playgroundApi, reasoningEffort || undefined, defaultMaxOutputTokens(sendTarget.model)),
        signal: controller.signal,
        fetchImpl: wireFetch,
      })) {
        assistantText += delta;
        renderFrame ??= requestAnimationFrame(commitAssistantText);
      }
      if (renderFrame !== null) cancelAnimationFrame(renderFrame);
      if (assistantText) commitAssistantText();
      else if (!controller.signal.aborted) {
        setMessages(current => [...current, { id: assistantId, role: 'assistant', text: t('dashboard.playground.emptyResponse') }]);
      }
    } catch (error) {
      if (!isAbortError(error) && !controller.signal.aborted) {
        setRequestError(errorMessage(error));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setSending(false);
      }
    }
  };

  const clearMessages = () => {
    stop();
    setMessages([]);
    editDialog.close();
    setRequestError(null);
  };

  const beginEdit = (message: PlaygroundMessage) => {
    stop();
    editDialog.open(message);
  };

  const saveEdit = (id: string, draft: PlaygroundMessageDraft) => {
    setMessages(current => {
      const index = current.findIndex(message => message.id === id);
      if (index < 0) return current;
      return current.slice(0, index + 1).map(message => message.id === id
        ? { ...message, text: draft.text.trim(), ...(message.role === 'user' && draft.imageUrl.trim() ? { imageUrl: draft.imageUrl.trim() } : { imageUrl: undefined }) }
        : message);
    });
    editDialog.close();
  };

  const removeMessage = (id: string) => {
    stop();
    setMessages(current => current.slice(0, current.findIndex(message => message.id === id)));
    editDialog.close();
  };

  const lastMessageId = messages.length === 0 ? null : messages[messages.length - 1]!.id;

  const settingsContent = <ScrollArea axes="vertical" className="h-full min-h-0" contentClassName="p-4 grid content-start gap-5" noTabIndex>
    <SettingsSection title={t('dashboard.playground.settings.connection')}>
      <Field
        hint={loaderData.keys?.length === 0 ? t('dashboard.playground.noKey') : undefined}
        label={t('dashboard.playground.key')}
      >
        <Dropdown
          disabled={!loaderData.keys?.length}
          selectedOptions={[keyId]}
          value={selectedKey ? `${selectedKey.name} (${selectedKey.key.slice(-4)})` : t('dashboard.playground.noKeyOption')}
          onOptionSelect={(_, data) => data.optionValue !== undefined && changeContext(() => setKeyId(data.optionValue!))}
        >
          {loaderData.keys?.map(key => <Option key={key.id} text={`${key.name} (${key.key.slice(-4)})`} value={key.id}>{key.name} ({key.key.slice(-4)})</Option>)}
        </Dropdown>
      </Field>
      <Field label={t('dashboard.playground.api')}>
        <Dropdown
          selectedOptions={[playgroundApi]}
          value={t(`dashboard.playground.apis.${playgroundApi}`)}
          onOptionSelect={(_, data) => data.optionValue !== undefined && changeContext(() => setPlaygroundApi(data.optionValue as PlaygroundApi))}
        >
          {playgroundApis.map(value => <Option key={value} value={value}>{t(`dashboard.playground.apis.${value}`)}</Option>)}
        </Dropdown>
      </Field>
      <Field label={t('dashboard.playground.model')}>
        <Combobox value={modelQuery ?? selectedModel?.display_name ?? ''} selectedOptions={selectedModel ? [selectedModel.id] : []} placeholder={t('dashboard.playground.modelPlaceholder')} onChange={event => setModelQuery(event.target.value)} onOptionSelect={(_, data) => {
          if (!data.optionValue) return;
          changeContext(() => {
            setPublicModelId(data.optionValue!);
            setModelQuery(null);
            setMessages([]);
            editDialog.close();
          });
        }} onOpenChange={(_, data) => setModelQuery(data.open ? '' : null)}>
          {matchingModels.map(model => <Option key={model.id} value={model.id} text={model.display_name}><div className="min-w-0 grid gap-1"><div className="truncate leading-[var(--lineHeightBase300)]">{model.display_name}</div><div className="text-fui-fg2 truncate font-mono">{model.id}</div></div></Option>)}
        </Combobox>
      </Field>
      {selectedModel && <ModelInfoBadges cap={cap} catalog={catalog} model={selectedModel} />}
    </SettingsSection>
    <SettingsSection title={t('dashboard.playground.settings.generation')}>
      <Field label={t('dashboard.playground.generation.reasoningEffort')}>
        <Combobox freeform placeholder={t('dashboard.playground.generation.providerDefault')} value={reasoningEffort} onChange={event => setReasoningEffort(event.target.value)} onOptionSelect={(_, data) => setReasoningEffort(data.optionText ?? '')}>
          {effortOptions.map(effort => <Option key={effort}>{effort}</Option>)}
        </Combobox>
      </Field>
    </SettingsSection>
    <SettingsSection title={t('dashboard.playground.settings.customJson')}>
      <Field validationState={customError ? 'error' : 'none'} validationMessage={customError ?? undefined} hint={t('dashboard.playground.customJsonHint')}>
        <Textarea aria-label={t('dashboard.playground.settings.customJson')} className="font-mono" rows={9} value={customDraft} onChange={(_, data) => {
          setCustomDraft(data.value);
          setCustomError(null);
        }} />
      </Field>
    </SettingsSection>
  </ScrollArea>;

  return (
    <>
      <section className={`h-full min-h-[560px] min-w-0 grid grid-cols-[minmax(0,1fr)_320px] ${PANE_GAP_CLASS} max-[1100px]:grid-cols-1`}>
        <div className="min-h-0 min-w-0 grid grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3">
          <DashboardPageHeader
            actions={narrow ? <Button appearance="subtle" aria-label={t('dashboard.playground.settings.title')} icon={<SettingsRegular />} onClick={() => setSettingsOpen(true)} /> : undefined}
            className={`pb-3 ${s.toolbar}`}
            description={t('dashboard.pages.playground')}
            title={t('dashboard.nav.playground')}
          />
          <div className="grid gap-2">
            <Button
              appearance="subtle"
              aria-expanded={showSystem}
              className="w-fit !min-w-0"
              icon={showSystem ? <ChevronUpRegular /> : <ChevronDownRegular />}
              iconPosition="after"
              onClick={() => setShowSystem(value => !value)}
            >
              {t('dashboard.playground.system')}
            </Button>
            {showSystem && (
              <Textarea
                aria-label={t('dashboard.playground.system')}
                rows={2}
                value={system}
                placeholder={t('dashboard.playground.systemPlaceholder')}
                onChange={(_, data) => setSystem(data.value)}
              />
            )}
          </div>
          <ScrollArea ref={scrollRef} axes="vertical" className="min-h-0 -m-1.5" contentClassName="flex min-h-full flex-col" noTabIndex viewportClassName="p-1.5">
            {loadError && <OutcomeMessageBar className="!mb-3" onDismiss={() => setLoadError(null)}>{loadError}</OutcomeMessageBar>}
            {requestError && <OutcomeMessageBar className="!mb-3" onDismiss={() => setRequestError(null)}>{requestError}</OutcomeMessageBar>}
            {loaderData.keys === null || loaderData.models === null
              ? <EmptyState className="flex-1 px-6" title={t('dashboard.pages.unavailable')} />
              : messages.length === 0 && !sending
                ? <div className="flex flex-1 items-center justify-center px-6"><EmptyStateLine>{t('dashboard.playground.empty')}</EmptyStateLine></div>
                : null}
            <div className="mt-auto grid gap-3">
              {messages.map(message => (
                <div key={message.id} className={`flex min-w-0 ${message.role === 'user' ? 'justify-end' : 'justify-start'} ${s.messageRow}`}>
                  <div className="max-w-[78%] min-w-0">
                    <PlaygroundMessageBubble role={message.role}>
                      {message.imageUrl && <a className={`block text-fui-base200 break-all mb-2 ${message.role === 'user' ? 'text-inherit' : 'text-fui-fg2'}`} href={message.imageUrl} target="_blank" rel="noopener noreferrer">{message.imageUrl}</a>}
                      {message.role === 'assistant'
                        ? <PlaygroundMarkdown content={message.text} streaming={sending && message.id === lastMessageId} />
                        : <span className="whitespace-pre-wrap break-words">{message.text}</span>}
                    </PlaygroundMessageBubble>
                    <div className={`playground-message-actions flex justify-end gap-1 mt-1 ${s.messageActions}`}>
                      <TooltipIconButton className={s.brandIconAction} label={t('dashboard.playground.actions.edit')} icon={<EditRegular />} onClick={() => beginEdit(message)} />
                      <TooltipIconButton className={s.brandIconAction} label={t('dashboard.playground.actions.delete')} icon={<DeleteRegular />} onClick={() => removeMessage(message.id)} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <PlaygroundComposer
            canSend={sendTarget !== null}
            cancelLabel={t('common.cancel')}
            draft={draft}
            imageEnabled={imageEnabled}
            imageLabel={t('dashboard.playground.actions.image')}
            imagePlaceholder={t('dashboard.playground.imagePlaceholder')}
            imageUnsupportedLabel={t('dashboard.playground.errors.imageUnsupported')}
            imageUrl={imageUrl}
            newTopicDisabled={!messages.length && !sending}
            newTopicLabel={t('dashboard.playground.actions.newTopic')}
            placeholder={t('dashboard.playground.messagePlaceholder')}
            sendLabel={t('dashboard.playground.actions.send')}
            sending={sending}
            showImage={showImage}
            stopLabel={t('dashboard.playground.actions.stop')}
            onDraftChange={setDraft}
            onImageUrlChange={setImageUrl}
            onNewTopic={clearMessages}
            onSend={() => void send()}
            onStop={stop}
            onToggleImage={() => {
              if (showImage) setImageUrl('');
              setShowImage(value => !value);
            }}
          />
        </div>

        {narrow ? <OverlayDrawer onOpenChange={(_, data) => setSettingsOpen(data.open)} open={settingsOpen} position="end" size="medium">
          <DrawerHeader><DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('dashboard.playground.settings.close')} icon={<DismissRegular />} onClick={() => setSettingsOpen(false)} />}>{t('dashboard.playground.settings.title')}</DrawerHeaderTitle></DrawerHeader>
          <DrawerBody className="!p-0 min-h-0">{settingsContent}</DrawerBody>
        </OverlayDrawer> : <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">{settingsContent}</Panel>}
      </section>

      {editDialog.invocation && <PlaygroundEditDialog
        key={editDialog.invocation.key}
        imageEnabled={imageEnabled}
        message={editDialog.invocation.value}
        open={editDialog.isOpen}
        onOpenChange={open => { if (!open) editDialog.close(); }}
        onSave={draft => saveEdit(editDialog.invocation!.value.id, draft)}
      />}
    </>
  );
}

function SettingsSection({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="grid gap-3 min-w-0"><SectionHeader level={2} title={title} />{children}</section>;
}
