import {
  ChevronDownRegular,
  ChevronUpRegular,
  DeleteRegular,
  DismissRegular,
  EditRegular,
  SettingsRegular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-playground';
import { useDashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ApiKey, ControlPlaneModel } from '../api/types';
import { getSessionToken } from '../auth/session';
import { ModelInfoBadges } from '../components/models/model-info-badges';
import { effectiveUpstreamCap } from '../components/models/reachability';
import { PlaygroundComposer } from '../components/playground/playground-composer';
import {
  availableModels,
  createWireFetch,
  defaultMaxOutputTokens,
  generationOptions,
  parseCustomJson,
  playgroundApis,
  supportsImageInput,
  type PlaygroundApi,
  type PlaygroundMessage,
} from '../components/playground/playground-logic';
import { PlaygroundMarkdown } from '../components/playground/playground-markdown';
import { PlaygroundMessageCard } from '../components/playground/playground-message-card';
import { streamPlaygroundText } from '../components/playground/playground-stream';
import { Combobox, Dropdown, Input, Textarea } from '../components/ui/fluent-form-controls';
import { Panel } from '../components/ui/panel';
import { ScrollArea } from '../components/ui/scroll-area';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { fluentComponents } from '../fluent';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { useMediaQuery } from '../lib/use-media-query';

export const handle = dashboardWorkspaceHandle;

const {
  Button,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  MessageBar,
  MessageBarBody,
  Option,
  OverlayDrawer,
  Text,
  makeStyles,
  tokens,
} = fluentComponents;

interface LoaderData { keys: ApiKey[]; models: ControlPlaneModel[]; error: string | null }

export async function clientLoader(): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const [keys, models] = await Promise.all([
    callApi(() => api.api.keys.$get()),
    callApi(() => api.api.models.$get({ query: {} })),
  ]);
  return {
    keys: keys.data ?? [],
    models: models.data?.data ?? [],
    error: keys.error?.message ?? models.error?.message ?? null,
  };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Playground | Floway' }];
}

const useStyles = makeStyles({
  toolbar: { borderBottom: `1px solid ${tokens.colorNeutralStroke1}` },
  brandIconAction: {
    color: 'light-dark(#2770ea, #244b8f)',
    '&:hover': { color: 'light-dark(#1b4aef, #203581)' },
  },
  messageActions: {
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: tokens.durationFaster,
    '@media (hover: none)': { opacity: 1 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0s' },
  },
  messageRow: { '&:hover .playground-message-actions, &:focus-within .playground-message-actions': { opacity: 1 } },
  code: { fontFamily: tokens.fontFamilyMonospace, fontSize: 'var(--floway-font-size-mono)' },
});

const randomId = () => crypto.randomUUID();

export default function DashboardPlayground({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const s = useStyles();
  const [api, setApi] = useState<PlaygroundApi>('responses');
  const [keyId, setKeyId] = useState(loaderData.keys[0]?.id ?? '');
  const [modelId, setModelId] = useState('');
  // `null` means the picker is showing its selection rather than a search
  // term. Opening the list clears the field so the first keystroke starts a
  // query instead of extending the selected model's display name.
  const [modelQuery, setModelQuery] = useState<string | null>(null);
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [system, setSystem] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [draft, setDraft] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [showImage, setShowImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [customDraft, setCustomDraft] = useState('{}');
  const [customError, setCustomError] = useState<string | null>(null);
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editImage, setEditImage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const narrow = useMediaQuery('(max-width: 1100px)');

  const selectedKey = loaderData.keys.find(key => key.id === keyId) ?? null;
  const cap = useMemo(
    () => effectiveUpstreamCap(selectedKey?.upstream_ids ?? null, user.upstreamIds),
    [selectedKey, user.upstreamIds],
  );
  const models = useMemo(
    () => availableModels(loaderData.models, cap),
    [cap, loaderData.models],
  );
  const selectedModel = models.find(model => model.id === modelId) ?? models[0] ?? null;
  const imageEnabled = supportsImageInput(selectedModel);
  const effortOptions = selectedModel?.chat?.reasoning?.effort?.supported ?? [];
  const matchingModels = models.filter(model => {
    const query = (modelQuery ?? '').trim().toLowerCase();
    return !query || model.id.toLowerCase().includes(query) || model.display_name.toLowerCase().includes(query);
  });

  const stop = useCallback(() => abortRef.current?.abort(), []);

  // The picker holds an id; the catalog decides whether it still resolves.
  // Reconciling during render keeps the two from disagreeing for a frame.
  const resolvedModelId = selectedModel?.id ?? '';
  if (resolvedModelId !== modelId) setModelId(resolvedModelId);

  // A model that cannot take images has no attachment to show; reconciling
  // during render avoids painting the composer with a stale one.
  if (!imageEnabled && (showImage || imageUrl !== '')) {
    setShowImage(false);
    setImageUrl('');
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
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
    if (sending || !selectedKey || !selectedModel || (!text && !image)) return;
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
    const customResult = parseCustomJson(api, customDraft);
    if (customResult.error) {
      const message = customResult.error === 'reserved'
        ? t('dashboard.playground.errors.customReserved', { fields: customResult.fields.join(', ') })
        : t(`dashboard.playground.errors.custom${customResult.error === 'invalid' ? 'Invalid' : 'Object'}`);
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
      const wireFetch = createWireFetch(customResult.value, api);

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
        api,
        apiKey: selectedKey.key,
        model: selectedModel.id,
        system: system.trim(),
        messages: context,
        options: generationOptions(api, reasoningEffort || undefined, defaultMaxOutputTokens(selectedModel)),
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
      if (!(error instanceof Error && error.name === 'AbortError') && !controller.signal.aborted) {
        setRequestError(error instanceof Error ? error.message : String(error));
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
    setEditingId(null);
    setRequestError(null);
  };

  const beginEdit = (message: PlaygroundMessage) => {
    stop();
    setEditingId(message.id);
    setEditText(message.text);
    setEditImage(message.imageUrl ?? '');
  };

  const saveEdit = (id: string) => {
    setMessages(current => {
      const index = current.findIndex(message => message.id === id);
      if (index < 0) return current;
      return current.slice(0, index + 1).map(message => message.id === id
        ? { ...message, text: editText.trim(), ...(message.role === 'user' && editImage.trim() ? { imageUrl: editImage.trim() } : { imageUrl: undefined }) }
        : message);
    });
    setEditingId(null);
  };

  const removeMessage = (id: string) => {
    stop();
    setMessages(current => current.slice(0, current.findIndex(message => message.id === id)));
    setEditingId(null);
  };

  const canSend = Boolean(selectedKey && selectedModel && (draft.trim() || imageUrl.trim()));
  const lastMessageId = messages.length === 0 ? null : messages[messages.length - 1]!.id;

  const settingsContent = <ScrollArea axes="vertical" className="h-full min-h-0" contentClassName="p-4 grid content-start gap-5" noTabIndex>
    <SettingsSection title={t('dashboard.playground.settings.connection')}>
      <Field label={t('dashboard.playground.key')}>
        <Dropdown
          disabled={!loaderData.keys.length}
          selectedOptions={[keyId]}
          value={selectedKey ? `${selectedKey.name} (${selectedKey.key.slice(-4)})` : t('dashboard.playground.noKeyOption')}
          onOptionSelect={(_, data) => data.optionValue !== undefined && changeContext(() => setKeyId(data.optionValue!))}
        >
          {!loaderData.keys.length && <Option value="">{t('dashboard.playground.noKeyOption')}</Option>}
          {loaderData.keys.map(key => <Option key={key.id} text={`${key.name} (${key.key.slice(-4)})`} value={key.id}>{key.name} ({key.key.slice(-4)})</Option>)}
        </Dropdown>
      </Field>
      <Field label={t('dashboard.playground.api')}>
        <Dropdown
          selectedOptions={[api]}
          value={t(`dashboard.playground.apis.${api}`)}
          onOptionSelect={(_, data) => data.optionValue !== undefined && changeContext(() => setApi(data.optionValue as PlaygroundApi))}
        >
          {playgroundApis.map(value => <Option key={value} value={value}>{t(`dashboard.playground.apis.${value}`)}</Option>)}
        </Dropdown>
      </Field>
      <Field label={t('dashboard.playground.model')}>
        <Combobox value={modelQuery ?? selectedModel?.display_name ?? ''} selectedOptions={selectedModel ? [selectedModel.id] : []} placeholder={t('dashboard.playground.modelPlaceholder')} onChange={event => setModelQuery(event.target.value)} onOptionSelect={(_, data) => {
          if (!data.optionValue) return;
          changeContext(() => {
            setModelId(data.optionValue!);
            setModelQuery(null);
            setMessages([]);
            setEditingId(null);
          });
        }} onOpenChange={(_, data) => setModelQuery(data.open ? '' : null)}>
          {matchingModels.map(model => <Option key={model.id} value={model.id} text={model.display_name}><div className="min-w-0 grid gap-1"><div className="truncate leading-[var(--lineHeightBase300)]">{model.display_name}</div><div className={`text-fui-fg2 truncate leading-[var(--lineHeightBase200)] ${s.code}`}>{model.id}</div></div></Option>)}
        </Combobox>
      </Field>
      {selectedModel && <ModelInfoBadges cap={cap} catalog={loaderData.models} model={selectedModel} />}
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
        <Textarea aria-label={t('dashboard.playground.settings.customJson')} className="font-mono" resize="vertical" rows={9} value={customDraft} onChange={(_, data) => {
          setCustomDraft(data.value);
          setCustomError(null);
        }} />
      </Field>
    </SettingsSection>
  </ScrollArea>;

  return (
    <>
      <section className="h-full min-h-[560px] min-w-0 grid grid-cols-[minmax(0,1fr)_320px] gap-[18px] max-[1100px]:grid-cols-1">
        <div className="min-h-0 min-w-0 grid grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3">
          <div className={`min-w-0 pb-3 flex items-center gap-3 ${s.toolbar}`}>
            <div className="grid gap-[6px] min-w-0">
              <Text block size={200} weight="semibold" className="text-fui-fg2 uppercase">Floway</Text>
              <Text as="h1" block size={700} weight="semibold" className="m-0">{t('dashboard.nav.playground')}</Text>
              <Text block size={200} className="text-fui-fg2 truncate font-mono mono-size-xs">{selectedModel?.id ?? t('dashboard.playground.noModel')}</Text>
            </div>
            {narrow && <Button appearance="subtle" aria-label={t('dashboard.playground.settings.title')} className="!ml-auto" icon={<SettingsRegular />} onClick={() => setSettingsOpen(true)} />}
          </div>
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
                resize="vertical"
                rows={2}
                value={system}
                placeholder={t('dashboard.playground.systemPlaceholder')}
                onChange={(_, data) => setSystem(data.value)}
              />
            )}
          </div>
          <ScrollArea ref={scrollRef} axes="vertical" className="min-h-0" contentClassName="flex min-h-full flex-col" noTabIndex>
            {loaderData.error && <MessageBar intent="error" className="!mb-3"><MessageBarBody>{loaderData.error}</MessageBarBody></MessageBar>}
            {requestError && <MessageBar intent="error" className="!mb-3"><MessageBarBody>{requestError}</MessageBarBody></MessageBar>}
            {!selectedKey ? <EmptyState text={t('dashboard.playground.noKey')} />
              : !selectedModel ? <EmptyState text={t('dashboard.playground.noModelForApi')} />
                  : messages.length === 0 && !sending ? <EmptyState text={t('dashboard.playground.empty')} /> : null}
            <div className="mt-auto grid gap-3" data-winui-card-restyle="off">
              {messages.map(message => (
                <div key={message.id} className={`flex min-w-0 ${message.role === 'user' ? 'justify-end' : 'justify-start'} ${s.messageRow}`}>
                  <div className="max-w-[78%] min-w-0">
                    <PlaygroundMessageCard role={message.role}>
                      {editingId === message.id ? (
                        <div className="grid gap-2">
                          <Textarea aria-label={t('dashboard.playground.actions.edit')} resize="vertical" rows={3} value={editText} onChange={(_, data) => setEditText(data.value)} />
                          {message.role === 'user' && imageEnabled && <Input aria-label={t('dashboard.playground.actions.image')} type="url" value={editImage} placeholder={t('dashboard.playground.imagePlaceholder')} onChange={(_, data) => setEditImage(data.value)} />}
                          <div className="flex justify-end gap-2">
                            <Button size="small" onClick={() => setEditingId(null)}>{t('common.cancel')}</Button>
                            <Button size="small" appearance="primary" disabled={!editText.trim() && !editImage.trim()} onClick={() => saveEdit(message.id)}>{t('dashboard.playground.actions.save')}</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {message.imageUrl && <a className={`block text-fui-base200 break-all mb-2 ${message.role === 'user' ? 'text-inherit' : 'text-fui-fg2'}`} href={message.imageUrl} target="_blank" rel="noreferrer">{message.imageUrl}</a>}
                          {message.role === 'assistant'
                            ? <PlaygroundMarkdown content={message.text} streaming={sending && message.id === lastMessageId} />
                            : <span className="whitespace-pre-wrap break-words">{message.text}</span>}
                        </>
                      )}
                    </PlaygroundMessageCard>
                    <div className={`playground-message-actions flex justify-end gap-0.5 mt-1 ${s.messageActions}`}>
                      <TooltipIconButton className={s.brandIconAction} label={t('dashboard.playground.actions.edit')} icon={<EditRegular />} onClick={() => beginEdit(message)} />
                      <TooltipIconButton className={s.brandIconAction} label={t('dashboard.playground.actions.delete')} icon={<DeleteRegular />} onClick={() => removeMessage(message.id)} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
          <div data-winui-card-restyle="off">
            <PlaygroundComposer
              canSend={canSend}
              cancelLabel={t('common.cancel')}
              draft={draft}
              imageEnabled={imageEnabled}
              imageLabel={t('dashboard.playground.actions.image')}
              imagePlaceholder={t('dashboard.playground.imagePlaceholder')}
              imageUnsupportedLabel={t('dashboard.playground.errors.imageUnsupported')}
              imageUrl={imageUrl}
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
        </div>

        {narrow ? <OverlayDrawer onOpenChange={(_, data) => setSettingsOpen(data.open)} open={settingsOpen} position="end" size="medium">
          <DrawerHeader><DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('dashboard.playground.settings.close')} icon={<DismissRegular />} onClick={() => setSettingsOpen(false)} />}>{t('dashboard.playground.settings.title')}</DrawerHeaderTitle></DrawerHeader>
          <DrawerBody className="!p-0 min-h-0">{settingsContent}</DrawerBody>
        </OverlayDrawer> : <Panel className="min-h-0 overflow-hidden !p-0">{settingsContent}</Panel>}
      </section>
    </>
  );
}

function SettingsSection({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="grid gap-3 min-w-0"><Text as="h2" size={500} weight="semibold" className="m-0">{title}</Text>{children}</section>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="flex-1 min-h-[180px] grid place-items-center text-center px-6"><Text className="text-fui-fg2">{text}</Text></div>;
}
