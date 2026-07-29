import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_DIAL_TIMEOUT_SECONDS, FORM_KIND_LABELS, KIND_OPTIONS, SS2022_METHOD_OPTIONS, SS_METHOD_OPTIONS, formKindFromConfig, isValidPort, isValidUuid, orUndef, proxyUrlPlaceholder } from './proxy-config';
import { fluentComponents } from '../../fluent';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import type {
  HttpProxyConfig,
  ProxyConfig,
  RealityProxyConfig,
  Shadowsocks2022ProxyConfig,
  ShadowsocksProxyConfig,
  Socks5ProxyConfig,
  TrojanProxyConfig,
  VlessTcpTlsProxyConfig,
  VlessWsTlsProxyConfig,
} from '@floway-dev/proxy/proxy-config';
const { Field, Option, Switch } = fluentComponents;
export type ProxyTestResult =
  | { ok: true; egress_ip: string }
  | { ok: false; error: string };

export interface ProxyFormProps {
  config: ProxyConfig;
  dialTimeoutInput: string;
  formName: string;
  onConfigChange: Dispatch<SetStateAction<ProxyConfig>>;
  onDialTimeoutChange: (value: string) => void;
  onKindChange: (_: unknown, data: { optionValue?: string }) => void;
  onNameChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  showValidation: boolean;
  urlError: string | null;
  urlInput: string;
}

export function ProxyForm({
  config,
  dialTimeoutInput,
  formName,
  onConfigChange: setConfig,
  onDialTimeoutChange,
  onKindChange,
  onNameChange,
  onPortChange,
  onUrlChange,
  showValidation,
  urlError,
  urlInput,
}: ProxyFormProps) {
  const { t } = useTranslation();
  const formKind = formKindFromConfig(config);
  const nameInvalid = showValidation && !formName.trim();
  const hostInvalid = showValidation && !config.host.trim();
  const portInvalid = showValidation && !isValidPort(config.port);
  const uuidNeeded = config.kind === 'vless-tcp' || config.kind === 'vless-ws' || config.kind === 'reality';
  const uuidInvalid = showValidation && uuidNeeded && !isValidUuid((config as { uuid: string }).uuid);
  return (
    <div className="grid gap-4 min-w-0">
      <Field label={t('dashboard.proxy.form.name')} validationMessage={nameInvalid ? t('dashboard.proxy.validation.nameRequired') : undefined} validationState={nameInvalid ? 'error' : undefined}>
        <Input
          onChange={(_, d) => onNameChange(d.value)}
          placeholder={t('dashboard.proxy.form.namePlaceholder')}
          value={formName}
        />
      </Field>

      <Field
        label={t('dashboard.proxy.form.url')}
        validationMessage={urlError ?? undefined}
        validationState={urlError ? 'error' : undefined}
      >
        <Input
          className="font-mono"
          onChange={(_, data) => onUrlChange(data.value)}
          placeholder={proxyUrlPlaceholder(config)}
          value={urlInput}
        />
      </Field>

      <Field label={t('dashboard.proxy.form.protocol')}>
        <Dropdown
          onOptionSelect={onKindChange}
          selectedOptions={[formKind]}
          value={FORM_KIND_LABELS[formKind]}
        >
          {KIND_OPTIONS.map(opt => (
            <Option key={opt.value} value={opt.value}>
              {opt.label}
            </Option>
          ))}
        </Dropdown>
      </Field>

      <div className="grid grid-cols-1 items-start gap-[12px] sm:grid-cols-[1fr_8rem]">
        <Field
          label={t('dashboard.proxy.form.host')}
          validationMessage={hostInvalid ? t('dashboard.proxy.validation.hostRequired') : undefined}
          validationState={hostInvalid ? 'error' : undefined}
        >
          <Input
            onChange={(_, d) => setConfig(prev => ({ ...prev, host: d.value } as ProxyConfig))}
            placeholder={t('dashboard.proxy.form.hostPlaceholder')}
            value={config.host}
          />
        </Field>
        <Field
          label={t('dashboard.proxy.form.port')}
          validationMessage={portInvalid ? t('dashboard.proxy.validation.portInvalid') : undefined}
          validationState={portInvalid ? 'error' : undefined}
        >
          <Input
            inputMode="numeric"
            onChange={(_, d) => onPortChange(d.value)}
            value={String(config.port)}
          />
        </Field>
      </div>

      {config.kind === 'http' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field label={t('dashboard.proxy.form.username')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  username: orUndef(d.value),
                } as HttpProxyConfig))
              }
              value={(config as HttpProxyConfig).username ?? ''}
            />
          </Field>
          <Field label={t('dashboard.proxy.form.password')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  password: orUndef(d.value),
                } as HttpProxyConfig))
              }
              type="password"
              value={(config as HttpProxyConfig).password ?? ''}
            />
          </Field>
        </div>
      )}

      {config.kind === 'socks5' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field label={t('dashboard.proxy.form.username')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  username: orUndef(d.value),
                } as Socks5ProxyConfig))
              }
              value={(config as Socks5ProxyConfig).username ?? ''}
            />
          </Field>
          <Field label={t('dashboard.proxy.form.password')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  password: orUndef(d.value),
                } as Socks5ProxyConfig))
              }
              type="password"
              value={(config as Socks5ProxyConfig).password ?? ''}
            />
          </Field>
        </div>
      )}

      {config.kind === 'ss' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field label={t('dashboard.proxy.form.method')}>
            <Dropdown
              onOptionSelect={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  method: d.optionValue,
                } as ShadowsocksProxyConfig))
              }
              selectedOptions={[(config as ShadowsocksProxyConfig).method]}
              value={(config as ShadowsocksProxyConfig).method}
            >
              {SS_METHOD_OPTIONS.map(opt => (
                <Option key={opt.value} value={opt.value}>
                  {opt.label}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field
            label={t('dashboard.proxy.form.passwordLabel')}
            validationMessage={showValidation && (config as ShadowsocksProxyConfig).password === '' ? t('dashboard.proxy.validation.required') : undefined}
            validationState={
              showValidation && (config as ShadowsocksProxyConfig).password === ''
                ? 'error'
                : undefined
            }
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  password: d.value,
                } as ShadowsocksProxyConfig))
              }
              type="password"
              value={(config as ShadowsocksProxyConfig).password}
            />
          </Field>
        </div>
      )}

      {config.kind === 'ss2022' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field label={t('dashboard.proxy.form.method')}>
            <Dropdown
              onOptionSelect={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  method: d.optionValue,
                } as Shadowsocks2022ProxyConfig))
              }
              selectedOptions={[
                (config as Shadowsocks2022ProxyConfig).method,
              ]}
              value={(config as Shadowsocks2022ProxyConfig).method}
            >
              {SS2022_METHOD_OPTIONS.map(opt => (
                <Option key={opt.value} value={opt.value}>
                  {opt.label}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field
            label={t('dashboard.proxy.form.psk')}
            validationMessage={showValidation && (config as Shadowsocks2022ProxyConfig).passwordBase64 === '' ? t('dashboard.proxy.validation.required') : undefined}
            validationState={
              showValidation && (config as Shadowsocks2022ProxyConfig).passwordBase64 === ''
                ? 'error'
                : undefined
            }
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  passwordBase64: d.value,
                } as Shadowsocks2022ProxyConfig))
              }
              type="password"
              value={
                (config as Shadowsocks2022ProxyConfig).passwordBase64
              }
            />
          </Field>
        </div>
      )}

      {config.kind === 'trojan' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field
            label={t('dashboard.proxy.form.passwordLabel')}
            validationMessage={showValidation && (config as TrojanProxyConfig).password === '' ? t('dashboard.proxy.validation.required') : undefined}
            validationState={
              showValidation && (config as TrojanProxyConfig).password === ''
                ? 'error'
                : undefined
            }
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  password: d.value,
                } as TrojanProxyConfig))
              }
              type="password"
              value={(config as TrojanProxyConfig).password}
            />
          </Field>
          <Field label={t('dashboard.proxy.form.sni')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  sni: orUndef(d.value),
                } as TrojanProxyConfig))
              }
              placeholder={t('dashboard.proxy.form.sniPlaceholder')}
              value={(config as TrojanProxyConfig).sni ?? ''}
            />
          </Field>
          <Field label={t('dashboard.proxy.form.allowInsecure')}>
            <Switch
              checked={
                (config as TrojanProxyConfig).allowInsecure ?? false
              }
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  allowInsecure: d.checked ? true : undefined,
                } as TrojanProxyConfig))
              }
            />
          </Field>
        </div>
      )}

      {config.kind === 'vless-tcp' && (
        <Field
          label={t('dashboard.proxy.form.uuid')}
          validationMessage={uuidInvalid ? t('dashboard.proxy.validation.uuidInvalid') : undefined}
          validationState={uuidInvalid ? 'error' : undefined}
        >
          <Input
            onChange={(_, d) =>
              setConfig(prev => ({
                ...prev,
                uuid: d.value,
              } as VlessTcpTlsProxyConfig))
            }
            placeholder={t('dashboard.proxy.form.uuidPlaceholder')}
            value={(config as VlessTcpTlsProxyConfig).uuid}
          />
        </Field>
      )}

      {config.kind === 'vless-ws' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field
            label={t('dashboard.proxy.form.uuid')}
            validationMessage={uuidInvalid ? t('dashboard.proxy.validation.uuidInvalid') : undefined}
            validationState={uuidInvalid ? 'error' : undefined}
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  uuid: d.value,
                } as VlessWsTlsProxyConfig))
              }
              placeholder={t('dashboard.proxy.form.uuidPlaceholder')}
              value={(config as VlessWsTlsProxyConfig).uuid}
            />
          </Field>
          <Field
            label={t('dashboard.proxy.form.wsPath')}
            validationMessage={showValidation && (config as VlessWsTlsProxyConfig).path === '' ? t('dashboard.proxy.validation.required') : undefined}
            validationState={
              showValidation && (config as VlessWsTlsProxyConfig).path === ''
                ? 'error'
                : undefined
            }
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  path: d.value,
                } as VlessWsTlsProxyConfig))
              }
              placeholder={t('dashboard.proxy.form.wsPathPlaceholder')}
              value={(config as VlessWsTlsProxyConfig).path}
            />
          </Field>
          <Field label={t('dashboard.proxy.form.wsHost')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  wsHost: orUndef(d.value),
                } as VlessWsTlsProxyConfig))
              }
              placeholder={t('dashboard.proxy.form.wsHostPlaceholder')}
              value={(config as VlessWsTlsProxyConfig).wsHost ?? ''}
            />
          </Field>
        </div>
      )}

      {config.kind === 'reality' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field
            label={t('dashboard.proxy.form.uuid')}
            validationMessage={uuidInvalid ? t('dashboard.proxy.validation.uuidInvalid') : undefined}
            validationState={uuidInvalid ? 'error' : undefined}
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  uuid: d.value,
                } as RealityProxyConfig))
              }
              placeholder={t('dashboard.proxy.form.uuidPlaceholder')}
              value={(config as RealityProxyConfig).uuid}
            />
          </Field>
          <Field
            label={t('dashboard.proxy.form.serverName')}
            validationMessage={showValidation && (config as RealityProxyConfig).serverName === '' ? t('dashboard.proxy.validation.required') : undefined}
            validationState={
              showValidation && (config as RealityProxyConfig).serverName === ''
                ? 'error'
                : undefined
            }
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  serverName: d.value,
                } as RealityProxyConfig))
              }
              placeholder={t('dashboard.proxy.form.serverNamePlaceholder')}
              value={(config as RealityProxyConfig).serverName}
            />
          </Field>
          <Field
            label={t('dashboard.proxy.form.publicKey')}
            validationMessage={showValidation && (config as RealityProxyConfig).publicKey === '' ? t('dashboard.proxy.validation.required') : undefined}
            validationState={
              showValidation && (config as RealityProxyConfig).publicKey === ''
                ? 'error'
                : undefined
            }
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  publicKey: d.value,
                } as RealityProxyConfig))
              }
              placeholder={t('dashboard.proxy.form.publicKeyPlaceholder')}
              value={(config as RealityProxyConfig).publicKey}
            />
          </Field>
          <Field label={t('dashboard.proxy.form.shortId')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  shortId: orUndef(d.value),
                } as RealityProxyConfig))
              }
              placeholder={t('dashboard.proxy.form.shortIdPlaceholder')}
              value={(config as RealityProxyConfig).shortId ?? ''}
            />
          </Field>
        </div>
      )}

      <Field
        hint={t('dashboard.proxy.form.timeoutHint')}
        label={t('dashboard.proxy.form.timeout')}
      >
        <Input
          inputMode="numeric"
          min={1}
          onChange={(_, d) => onDialTimeoutChange(d.value)}
          placeholder={`${DEFAULT_DIAL_TIMEOUT_SECONDS} (default)`}
          type="number"
          value={dialTimeoutInput}
        />
      </Field>

    </div>
  );
}
