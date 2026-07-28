import {
  ChevronDownRegular,
  ChevronUpRegular,
  DeleteRegular,
  EditRegular,
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
import { PlaygroundComposer } from '../components/playground/playground-composer';
import {
  availableModels,
  createWireFetch,
  defaultMaxOutputTokens,
  generationOptions,
  maximumOutputTokens,
  parseCustomJson,
  playgroundApis,
  supportsImageInput,
  type PlaygroundApi,
  type PlaygroundMessage,
  type PlaygroundSettings,
} from '../components/playground/playground-logic';
import { PlaygroundMarkdown } from '../components/playground/playground-markdown';
import { PlaygroundMessageCard } from '../components/playground/playground-message-card';
import { streamPlaygroundText } from '../components/playground/playground-stream';
import { Combobox, Input, Select, SpinButton, Textarea } from '../components/ui/fluent-form-controls';
import { Panel } from '../components/ui/panel';
import { SegmentedControl } from '../components/ui/segmented-control';
import { ScrollArea } from '../components/ui/scroll-area';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { fluentComponents } from '../fluent';
import { australianDarkTheme, australianLightTheme } from '../theme';

const {
  Button,
  Field,
  FluentProvider,
  MessageBar,
  MessageBarBody,
  Option,
  Switch,
  Text,
  makeStyles,
  tokens,
} = fluentComponents;

function useAustralianTheme() {
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return dark ? australianDarkTheme : australianLightTheme;
}

interface ModelsResponse { data: ControlPlaneModel[] }
interface LoaderData { keys: ApiKey[]; models: ControlPlaneModel[]; error: string | null }

export async function clientLoader(): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const [keys, models] = await Promise.all([
    callApi<ApiKey[]>(() => api.api.keys.$get()),
    callApi<ModelsResponse>(() => api.api.models.$get({ query: {} })),
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
  systemToggle: {
    color: tokens.colorNeutralForeground2,
    backgroundColor: 'transparent',
    border: 0,
    '&:hover': {
      color: tokens.colorNeutralForeground1,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
  brandIconAction: {
    color: 'light-dark(#2770ea, #244b8f)',
    '&:hover': { color: 'light-dark(#1b4aef, #203581)' },
  },
  messageActions: { opacity: 0, transitionProperty: 'opacity', transitionDuration: tokens.durationFaster },
  messageRow: { '&:hover .playground-message-actions, &:focus-within .playground-message-actions': { opacity: 1 } },
  code: { fontFamily: tokens.fontFamilyMonospace },
});

const randomId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export default function DashboardPlayground({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const australianTheme = useAustralianTheme();
  const s = useStyles();
  const [api, setApi] = useState<PlaygroundApi>('responses');
  const [keyId, setKeyId] = useState(loaderData.keys[0]?.id ?? '');
  const [modelId, setModelId] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [messages, setMessages] = useState<PlaygroundMessage[]>([]);
  const [system, setSystem] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [draft, setDraft] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [showImage, setShowImage] = useState(false);
  const [sending, setSending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [customDrafts, setCustomDrafts] = useState<Record<PlaygroundApi, string>>({
    responses: '{}', chatCompletions: '{}', messages: '{}',
  });
  const [customError, setCustomError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PlaygroundSettings>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editImage, setEditImage] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectedKey = loaderData.keys.find(key => key.id === keyId) ?? null;
  const models = useMemo(
    () => availableModels(loaderData.models, selectedKey, user.upstreamIds, api),
    [api, loaderData.models, selectedKey, user.upstreamIds],
  );
  const selectedModel = models.find(model => model.id === modelId) ?? models[0] ?? null;
  const imageEnabled = supportsImageInput(selectedModel);
  const outputLimit = maximumOutputTokens(selectedModel);
  const effortOptions = selectedModel?.chat?.reasoning?.effort?.supported ?? [];
  const matchingModels = models.filter(model => {
    const query = modelQuery.trim().toLowerCase();
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
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
    const customResult = parseCustomJson(api, customDrafts[api]);
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
        options: generationOptions(api, settings, defaultMaxOutputTokens(selectedModel)),
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

  return (
    <FluentProvider theme={australianTheme} className="h-full min-h-0 !bg-transparent">
      <section className="h-full min-h-[560px] min-w-0 grid grid-cols-[minmax(0,1fr)_360px] gap-[18px] max-[1100px]:h-auto max-[1100px]:grid-cols-1">
        <div className="min-h-0 min-w-0 grid grid-rows-[auto_auto_minmax(0,1fr)_auto]">
          <div className={`min-w-0 px-4 py-3 flex items-center gap-3 ${s.toolbar}`}>
            <div className="min-w-0">
              <Text as="h1" size={500} weight="semibold" className="!m-0 block">{t('dashboard.nav.playground')}</Text>
              <Text size={200} className="text-fui-fg2 block truncate">{selectedModel?.id ?? t('dashboard.playground.noModel')}</Text>
            </div>
          </div>
          <div className="px-4 py-2 grid gap-2">
            <button
              type="button"
              aria-expanded={showSystem}
              className={`w-fit min-h-[32px] rounded-md px-2 flex items-center gap-2 text-fui-base300 font-fui-regular ${s.systemToggle}`}
              onClick={() => setShowSystem(value => !value)}
            >
              <span>{t('dashboard.playground.system')}</span>
              {showSystem ? <ChevronUpRegular /> : <ChevronDownRegular />}
            </button>
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
          <ScrollArea ref={scrollRef} axes="vertical" className="min-h-0" contentClassName="px-4 py-3 flex min-h-full flex-col" noTabIndex>
            {loaderData.error && <MessageBar intent="error" className="!mb-3"><MessageBarBody>{loaderData.error}</MessageBarBody></MessageBar>}
            {requestError && <MessageBar intent="error" className="!mb-3"><MessageBarBody>{requestError}</MessageBarBody></MessageBar>}
            {!selectedKey ? <EmptyState text={t('dashboard.playground.noKey')} />
              : !selectedModel ? <EmptyState text={t('dashboard.playground.noModelForApi')} />
                  : messages.length === 0 && !sending ? <EmptyState text={t('dashboard.playground.empty')} /> : null}
            <div className="mt-auto grid gap-3">
              {messages.map(message => (
                <div key={message.id} className={`flex min-w-0 ${message.role === 'user' ? 'justify-end' : 'justify-start'} ${s.messageRow}`}>
                  <div className="max-w-[78%] min-w-0">
                    <PlaygroundMessageCard role={message.role}>
                      {editingId === message.id ? (
                        <div className="grid gap-2">
                          <Textarea resize="vertical" rows={3} value={editText} onChange={(_, data) => setEditText(data.value)} />
                          {message.role === 'user' && imageEnabled && <Input type="url" value={editImage} placeholder={t('dashboard.playground.imagePlaceholder')} onChange={(_, data) => setEditImage(data.value)} />}
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
          <div className="p-3">
            <PlaygroundComposer
              canSend={canSend}
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
        </div>

        <Panel className="min-h-0 overflow-hidden !p-0">
          <ScrollArea axes="vertical" className="h-full min-h-0" contentClassName="!p-4 grid content-start gap-5" noTabIndex>
          <SettingsSection title={t('dashboard.playground.settings.connection')}>
            <Field label={t('dashboard.playground.key')}>
              <Select value={keyId} disabled={!loaderData.keys.length} onChange={(_, data) => changeContext(() => setKeyId(data.value))}>
                {!loaderData.keys.length && <option value="">{t('dashboard.playground.noKeyOption')}</option>}
                {loaderData.keys.map(key => <option key={key.id} value={key.id}>{key.name} ({key.key.slice(-4)})</option>)}
              </Select>
            </Field>
            <div className="grid gap-0.5">
              <Text weight="semibold">{t('dashboard.playground.api')}</Text>
              <SegmentedControl ariaLabel={t('dashboard.playground.api')} value={api} items={playgroundApis.map(value => ({ value, label: t(`dashboard.playground.apis.${value}`) }))} onChange={value => changeContext(() => setApi(value as PlaygroundApi))} />
            </div>
            <Field label={t('dashboard.playground.model')}>
              <Combobox value={modelQuery || selectedModel?.display_name || ''} selectedOptions={selectedModel ? [selectedModel.id] : []} placeholder={t('dashboard.playground.modelPlaceholder')} onChange={event => setModelQuery(event.target.value)} onOptionSelect={(_, data) => {
                if (!data.optionValue) return;
                changeContext(() => {
                  setModelId(data.optionValue!);
                  setModelQuery('');
                  setMessages([]);
                  setEditingId(null);
                });
              }} onOpenChange={(_, data) => { if (!data.open) setModelQuery(''); }}>
                {matchingModels.map(model => <Option key={model.id} value={model.id} text={model.display_name}><div className="min-w-0"><div className="truncate">{model.display_name}</div><div className={`text-fui-fg2 text-fui-base200 truncate ${s.code}`}>{model.id}</div></div></Option>)}
              </Combobox>
            </Field>
          </SettingsSection>

          <SettingsSection title={t('dashboard.playground.settings.generation')}>
            <OptionalNumber initialValue={1} label={t('dashboard.playground.parameters.temperature')} value={settings.temperature} min={0} max={2} step={0.1} onChange={value => setSettings(current => ({ ...current, temperature: value }))} />
            <OptionalNumber initialValue={defaultMaxOutputTokens(selectedModel)} label={t('dashboard.playground.parameters.maxOutputTokens')} value={settings.maxOutputTokens} min={1} max={outputLimit} step={1} onChange={value => setSettings(current => ({ ...current, maxOutputTokens: value }))} />
            <OptionalNumber initialValue={1} label={t('dashboard.playground.parameters.topP')} value={settings.topP} min={0} max={1} step={0.05} onChange={value => setSettings(current => ({ ...current, topP: value }))} />
            <OptionalNumber initialValue={0} label={t('dashboard.playground.parameters.frequencyPenalty')} value={settings.frequencyPenalty} disabled={api !== 'chatCompletions'} min={-2} max={2} step={0.1} onChange={value => setSettings(current => ({ ...current, frequencyPenalty: value }))} />
            <OptionalNumber initialValue={0} label={t('dashboard.playground.parameters.presencePenalty')} value={settings.presencePenalty} disabled={api !== 'chatCompletions'} min={-2} max={2} step={0.1} onChange={value => setSettings(current => ({ ...current, presencePenalty: value }))} />
            <Field label={t('dashboard.playground.parameters.stopSequences')}>
              <Input disabled={api === 'responses'} value={settings.stopSequences?.join(', ') ?? ''} placeholder={t('dashboard.playground.parameters.unset')} onChange={(_, data) => {
                const stopSequences = data.value.split(',').map(value => value.trim()).filter(Boolean);
                setSettings(current => ({ ...current, stopSequences: stopSequences.length ? stopSequences : undefined }));
              }} />
            </Field>
            <Field label={t('dashboard.playground.parameters.reasoningEffort')}>
              <Select value={settings.reasoningEffort ?? ''} disabled={!effortOptions.length} onChange={(_, data) => setSettings(current => ({ ...current, reasoningEffort: data.value || undefined }))}>
                <option value="">{t('dashboard.playground.parameters.providerDefault')}</option>
                {effortOptions.map(effort => <option key={effort} value={effort}>{effort}</option>)}
              </Select>
            </Field>
          </SettingsSection>

          <SettingsSection title={t('dashboard.playground.settings.customJson')}>
            <Field validationState={customError ? 'error' : 'none'} validationMessage={customError ?? undefined} hint={t('dashboard.playground.customJsonHint')}>
              <Textarea className={s.code} resize="vertical" rows={9} value={customDrafts[api]} onChange={(_, data) => {
                setCustomDrafts(current => ({ ...current, [api]: data.value }));
                setCustomError(null);
              }} />
            </Field>
          </SettingsSection>
          </ScrollArea>
        </Panel>
      </section>
    </FluentProvider>
  );
}

function SettingsSection({ children, title }: { children: React.ReactNode; title: string }) {
  return <section className="grid gap-3 min-w-0"><Text as="h2" size={300} weight="semibold" className="!m-0">{title}</Text>{children}</section>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="h-full min-h-[180px] grid place-items-center text-center px-6"><Text className="text-fui-fg2">{text}</Text></div>;
}

function OptionalNumber({ disabled, initialValue, label, max, min, onChange, step, value }: {
  disabled?: boolean; initialValue: number; label: string; max?: number; min: number; onChange: (value: number | undefined) => void; step: number; value?: number;
}) {
  const { t } = useTranslation();
  return <div className="grid grid-cols-[minmax(0,1fr)_116px] items-end gap-2 min-w-0">
    <Switch checked={value !== undefined} disabled={disabled} label={label} onChange={(_, data) => onChange(data.checked ? initialValue : undefined)} />
    <SpinButton aria-label={label} disabled={disabled === true || value === undefined} value={value ?? null} min={min} max={max} step={step} placeholder={t('dashboard.playground.parameters.unset')} onChange={(_, data) => {
      const next = data.value ?? (data.displayValue ? Number(data.displayValue) : undefined);
      if (next !== undefined && Number.isFinite(next)) onChange(next);
    }} />
  </div>;
}
