import type { FieldErrors } from 'react-hook-form';

import { DEFAULT_DIAL_TIMEOUT_SECONDS, FORM_KINDS, PROXY_CONFIG_ISSUE_FIELDS, SS2022_METHOD_OPTIONS, SS_METHOD_OPTIONS, formKindFromConfig, formKindLabelKey, orUndef, proxyUrlPlaceholder, type ProxyConfigIssueField, type ProxyFormValues } from './config';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { issuesFromErrors, useIssueText } from '../../lib/form-issues';
import { Dropdown, Input, Switch } from '../ui/fluent-form-controls';
import { SecretInput } from '../ui/secret-input';
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
} from '@floway-dev/proxy/browser';

const { Field, Option } = fluentComponents;

export type ProxyTestResult =
  | { ok: true; egress_ip: string }
  | { ok: false; error: string };

export interface ProxyFormProps {
  config: ProxyConfig;
  dialTimeoutInput: string;
  errors: FieldErrors<ProxyFormValues>;
  formName: string;
  onConfigChange: (update: (previous: ProxyConfig) => ProxyConfig) => void;
  onDialTimeoutChange: (value: string) => void;
  onKindChange: (_: unknown, data: { optionValue?: string }) => void;
  onNameChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  urlInput: string;
}

export function ProxyForm({
  config,
  dialTimeoutInput,
  errors,
  formName,
  onConfigChange: setConfig,
  onDialTimeoutChange,
  onKindChange,
  onNameChange,
  onPortChange,
  onUrlChange,
  urlInput,
}: ProxyFormProps) {
  const { t } = useTranslation();
  const issueText = useIssueText();
  const formKind = formKindFromConfig(config);
  const configIssues = issuesFromErrors(errors.config, PROXY_CONFIG_ISSUE_FIELDS);
  const message = (field: ProxyConfigIssueField) => issueText(configIssues[field]);
  const state = (field: ProxyConfigIssueField) => configIssues[field] === undefined ? undefined : 'error' as const;
  const nameMessage = issueText(errors.name?.message);
  const urlMessage = issueText(errors.url?.message);
  const dialTimeoutMessage = issueText(errors.dialTimeout?.message);
  return (
    <div className="grid gap-4 min-w-0">
      <Field label={t('proxies.form.name')} validationMessage={nameMessage} validationState={nameMessage ? 'error' : undefined}>
        <Input
          onChange={(_, d) => onNameChange(d.value)}
          placeholder={t('proxies.form.namePlaceholder')}
          value={formName}
        />
      </Field>

      <Field
        label={t('proxies.form.url')}
        validationMessage={urlMessage}
        validationState={urlMessage ? 'error' : undefined}
      >
        <Input
          className="font-mono"
          onChange={(_, data) => onUrlChange(data.value)}
          placeholder={proxyUrlPlaceholder(config)}
          value={urlInput}
        />
      </Field>

      <Field label={t('proxies.form.protocol')}>
        <Dropdown
          onOptionSelect={onKindChange}
          selectedOptions={[formKind]}
          value={t(formKindLabelKey(formKind))}
        >
          {FORM_KINDS.map(kind => (
            <Option key={kind} value={kind}>
              {t(formKindLabelKey(kind))}
            </Option>
          ))}
        </Dropdown>
      </Field>

      <div className="grid grid-cols-1 items-start gap-[12px] sm:grid-cols-[1fr_8rem]">
        <Field
          label={t('proxies.form.host')}
          validationMessage={message('host')}
          validationState={state('host')}
        >
          <Input
            onChange={(_, d) => setConfig(prev => ({ ...prev, host: d.value } as ProxyConfig))}
            placeholder={t('proxies.form.hostPlaceholder')}
            value={config.host}
          />
        </Field>
        <Field
          label={t('proxies.form.port')}
          validationMessage={message('port')}
          validationState={state('port')}
        >
          <Input
            inputMode="numeric"
            min={1}
            onChange={(_, d) => onPortChange(d.value)}
            type="number"
            value={String(config.port)}
          />
        </Field>
      </div>

      {config.kind === 'http' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field label={t('proxies.form.username')}>
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
          <Field label={t('proxies.form.password')}>
            <SecretInput
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  password: orUndef(d.value),
                } as HttpProxyConfig))
              }
              value={(config as HttpProxyConfig).password ?? ''}
            />
          </Field>
        </div>
      )}

      {config.kind === 'socks5' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field label={t('proxies.form.username')}>
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
          <Field label={t('proxies.form.password')}>
            <SecretInput
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  password: orUndef(d.value),
                } as Socks5ProxyConfig))
              }
              value={(config as Socks5ProxyConfig).password ?? ''}
            />
          </Field>
        </div>
      )}

      {config.kind === 'ss' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field label={t('proxies.form.method')}>
            <Dropdown
              onOptionSelect={(_, d) =>
                d.optionValue !== undefined && setConfig(prev => ({
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
            label={t('proxies.form.passwordLabel')}
            validationMessage={message('password')}
            validationState={state('password')}
          >
            <SecretInput
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  password: d.value,
                } as ShadowsocksProxyConfig))
              }
              value={(config as ShadowsocksProxyConfig).password}
            />
          </Field>
        </div>
      )}

      {config.kind === 'ss2022' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field label={t('proxies.form.method')}>
            <Dropdown
              onOptionSelect={(_, d) =>
                d.optionValue !== undefined && setConfig(prev => ({
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
            label={t('proxies.form.psk')}
            validationMessage={message('passwordBase64')}
            validationState={state('passwordBase64')}
          >
            <SecretInput
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  passwordBase64: d.value,
                } as Shadowsocks2022ProxyConfig))
              }
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
            label={t('proxies.form.passwordLabel')}
            validationMessage={message('password')}
            validationState={state('password')}
          >
            <SecretInput
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  password: d.value,
                } as TrojanProxyConfig))
              }
              value={(config as TrojanProxyConfig).password}
            />
          </Field>
          <Field label={t('proxies.form.sni')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  sni: orUndef(d.value),
                } as TrojanProxyConfig))
              }
              placeholder={t('proxies.form.sniPlaceholder')}
              value={(config as TrojanProxyConfig).sni ?? ''}
            />
          </Field>
          <Switch
            checked={
              (config as TrojanProxyConfig).allowInsecure ?? false
            }
            label={t('proxies.form.allowInsecure')}
            onChange={(_, d) =>
              setConfig(prev => ({
                ...prev,
                allowInsecure: d.checked ? true : undefined,
              } as TrojanProxyConfig))
            }
          />
        </div>
      )}

      {config.kind === 'vless-tcp' && (
        <Field
          label={t('proxies.form.uuid')}
          validationMessage={message('uuid')}
          validationState={state('uuid')}
        >
          <Input
            onChange={(_, d) =>
              setConfig(prev => ({
                ...prev,
                uuid: d.value,
              } as VlessTcpTlsProxyConfig))
            }
            placeholder={t('proxies.form.uuidPlaceholder')}
            value={(config as VlessTcpTlsProxyConfig).uuid}
          />
        </Field>
      )}

      {config.kind === 'vless-ws' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field
            label={t('proxies.form.uuid')}
            validationMessage={message('uuid')}
            validationState={state('uuid')}
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  uuid: d.value,
                } as VlessWsTlsProxyConfig))
              }
              placeholder={t('proxies.form.uuidPlaceholder')}
              value={(config as VlessWsTlsProxyConfig).uuid}
            />
          </Field>
          <Field
            label={t('proxies.form.wsPath')}
            validationMessage={message('path')}
            validationState={state('path')}
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  path: d.value,
                } as VlessWsTlsProxyConfig))
              }
              placeholder={t('proxies.form.wsPathPlaceholder')}
              value={(config as VlessWsTlsProxyConfig).path}
            />
          </Field>
          <Field label={t('proxies.form.wsHost')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  wsHost: orUndef(d.value),
                } as VlessWsTlsProxyConfig))
              }
              placeholder={t('proxies.form.wsHostPlaceholder')}
              value={(config as VlessWsTlsProxyConfig).wsHost ?? ''}
            />
          </Field>
        </div>
      )}

      {config.kind === 'reality' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field
            label={t('proxies.form.uuid')}
            validationMessage={message('uuid')}
            validationState={state('uuid')}
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  uuid: d.value,
                } as RealityProxyConfig))
              }
              placeholder={t('proxies.form.uuidPlaceholder')}
              value={(config as RealityProxyConfig).uuid}
            />
          </Field>
          <Field
            label={t('proxies.form.serverName')}
            validationMessage={message('serverName')}
            validationState={state('serverName')}
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  serverName: d.value,
                } as RealityProxyConfig))
              }
              placeholder={t('proxies.form.serverNamePlaceholder')}
              value={(config as RealityProxyConfig).serverName}
            />
          </Field>
          <Field
            label={t('proxies.form.publicKey')}
            validationMessage={message('publicKey')}
            validationState={state('publicKey')}
          >
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  publicKey: d.value,
                } as RealityProxyConfig))
              }
              placeholder={t('proxies.form.publicKeyPlaceholder')}
              value={(config as RealityProxyConfig).publicKey}
            />
          </Field>
          <Field label={t('proxies.form.shortId')}>
            <Input
              onChange={(_, d) =>
                setConfig(prev => ({
                  ...prev,
                  shortId: orUndef(d.value),
                } as RealityProxyConfig))
              }
              placeholder={t('proxies.form.shortIdPlaceholder')}
              value={(config as RealityProxyConfig).shortId ?? ''}
            />
          </Field>
        </div>
      )}

      <Field
        hint={t('proxies.form.timeoutHint')}
        label={t('proxies.form.timeout')}
        validationMessage={dialTimeoutMessage}
        validationState={dialTimeoutMessage ? 'error' : undefined}
      >
        <Input
          inputMode="numeric"
          min={1}
          onChange={(_, d) => onDialTimeoutChange(d.value)}
          placeholder={t('proxies.form.timeoutPlaceholder', { seconds: DEFAULT_DIAL_TIMEOUT_SECONDS })}
          type="number"
          value={dialTimeoutInput}
        />
      </Field>

    </div>
  );
}
