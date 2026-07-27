import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_DIAL_TIMEOUT_SECONDS, FORM_KIND_LABELS, KIND_OPTIONS, SS2022_METHOD_OPTIONS, SS_METHOD_OPTIONS, formKindFromConfig, isValidPort, isValidUuid, orUndef } from './proxy-config';
import { fluentComponents } from '../../fluent';
import { Dropdown, Input } from '../ui/fluent-form-controls';
import { Panel } from '../ui/panel';
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
const { Button, Field, MessageBar, MessageBarBody, Option, Spinner, Switch, Text } = fluentComponents;
export interface ProxyFormProps { canSave: boolean; config: ProxyConfig; dialTimeoutInput: string; editing: boolean; formName: string; onCancel: () => void; onConfigChange: Dispatch<SetStateAction<ProxyConfig>>; onDialTimeoutChange: (value: string) => void; onKindChange: (_: unknown, data: { optionValue?: string }) => void; onNameChange: (value: string) => void; onPortChange: (value: string) => void; onSave: () => void; onTest: () => void; saveError: string | null; saveSuccess: boolean; saving: boolean; testResult: { ok: boolean; egress_ip?: string; error?: string } | null; testing: boolean }
export function ProxyForm({ canSave, config, dialTimeoutInput, editing, formName, onCancel, onConfigChange: setConfig, onDialTimeoutChange, onKindChange, onNameChange, onPortChange, onSave, onTest, saveError, saveSuccess, saving, testResult, testing }: ProxyFormProps) {
  const { t } = useTranslation(); const formKind = formKindFromConfig(config); const hostInvalid = !config.host.trim(); const portInvalid = !isValidPort(config.port); const uuidNeeded = config.kind === 'vless-tcp' || config.kind === 'vless-ws' || config.kind === 'reality'; const uuidInvalid = uuidNeeded && !isValidUuid((config as { uuid: string }).uuid);
  return (
    <Panel className="!p-[22px_24px] grid gap-[16px] w-full min-w-0">
      <Text size={400} weight="semibold">
        {editing
          ? t('dashboard.proxy.editTitle')
          : t('dashboard.proxy.addTitle')}
      </Text>

      {/* Name */}
      <Field label={t('dashboard.proxy.form.name')}>
        <Input
          onChange={(_, d) => onNameChange(d.value)}
          placeholder={t('dashboard.proxy.form.namePlaceholder')}
          value={formName}
        />
      </Field>

      {/* Protocol selector */}
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

      {/* Host + Port (common to all kinds) */}
      <div className="grid grid-cols-1 gap-[12px] sm:grid-cols-[1fr_8rem]">
        <Field
          label={t('dashboard.proxy.form.host')}
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
          validationState={portInvalid ? 'error' : undefined}
        >
          <Input
            inputMode="numeric"
            onChange={(_, d) => onPortChange(d.value)}
            value={String(config.port)}
          />
        </Field>
      </div>

      {/* ---- HTTP / HTTPS ---- */}
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

      {/* ---- SOCKS5 ---- */}
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

      {/* ---- Shadowsocks ---- */}
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
            validationState={
              (config as ShadowsocksProxyConfig).password === ''
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

      {/* ---- Shadowsocks 2022 ---- */}
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
            validationState={
              (config as Shadowsocks2022ProxyConfig).passwordBase64 === ''
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

      {/* ---- Trojan ---- */}
      {config.kind === 'trojan' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field
            label={t('dashboard.proxy.form.passwordLabel')}
            validationState={
              (config as TrojanProxyConfig).password === ''
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

      {/* ---- VLESS / TLS ---- */}
      {config.kind === 'vless-tcp' && (
        <Field
          label={t('dashboard.proxy.form.uuid')}
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

      {/* ---- VLESS / WebSocket ---- */}
      {config.kind === 'vless-ws' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field
            label={t('dashboard.proxy.form.uuid')}
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
            validationState={
              (config as VlessWsTlsProxyConfig).path === ''
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

      {/* ---- VLESS / REALITY ---- */}
      {config.kind === 'reality' && (
        <div className="grid grid-cols-1 gap-[12px]">
          <Field
            label={t('dashboard.proxy.form.uuid')}
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
            validationState={
              (config as RealityProxyConfig).serverName === ''
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
            validationState={
              (config as RealityProxyConfig).publicKey === ''
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

      {/* Dial timeout */}
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

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-[10px]">
        <Button
          appearance="primary"
          disabled={saving || !canSave}
          icon={saving ? <Spinner size="tiny" /> : undefined}
          onClick={onSave}
        >
          {saving
            ? t('dashboard.proxy.actions.saving')
            : t('dashboard.proxy.actions.save')}
        </Button>
        <Button
          disabled={!config.host.trim() || !isValidPort(config.port) || testing}
          icon={testing ? <Spinner size="tiny" /> : undefined}
          onClick={onTest}
        >
          {testing
            ? t('dashboard.proxy.actions.testing')
            : t('dashboard.proxy.actions.test')}
        </Button>
        {editing && (
          <Button
            appearance="outline"
            className="ml-auto"
            onClick={onCancel}
          >
            {t('dashboard.proxy.cancelEdit')}
          </Button>
        )}
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className="rounded-lg border border-solid p-[12px_14px] grid gap-[4px]"
          style={{
            borderColor: testResult.ok
              ? 'light-dark(#0b6a0b, #6fcf6f)'
              : 'light-dark(#c50f1f, #e37b84)',
            backgroundColor: testResult.ok
              ? 'light-dark(#ddf6dd, #1b3a1b)'
              : 'light-dark(#fde7e9, #3d1517)',
          }}
        >
          <Text
            size={200}
            weight="semibold"
            style={{
              color: testResult.ok
                ? 'light-dark(#0b6a0b, #6fcf6f)'
                : 'light-dark(#c50f1f, #e37b84)',
            }}
          >
            {testResult.ok
              ? t('dashboard.proxy.test.ok')
              : t('dashboard.proxy.test.failed', {
                  error: testResult.error ?? '',
                })}
          </Text>
          {testResult.ok && testResult.egress_ip && (
            <Text size={200} className="text-fui-fg3">
              {t('dashboard.proxy.test.egressIp', {
                ip: testResult.egress_ip,
              })}
            </Text>
          )}
        </div>
      )}

      {/* Save feedback */}
      {saveError && (
        <MessageBar intent="error">
          <MessageBarBody>{saveError}</MessageBarBody>
        </MessageBar>
      )}
      {saveSuccess && (
        <MessageBar intent="success">
          <MessageBarBody>
            {t('dashboard.proxy.actions.saveSuccess')}
          </MessageBarBody>
        </MessageBar>
      )}
    </Panel>
  );
}
