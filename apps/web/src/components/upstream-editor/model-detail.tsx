import { ArrowLeftRegular, DeleteRegular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Flag } from "@floway-dev/provider/flags";
import type {
  UpstreamChatConfig,
  UpstreamModelConfig,
  UpstreamRecord,
} from "../../api/types";
import { fluentComponents } from "../../fluent";
import { Input, Select } from "../ui/fluent-form-controls";
import { SegmentedControl } from "../ui/segmented-control";
import { publicModelId } from "./editor-data";
import { FeatureFlagsEditor } from "./feature-flags";
import { PricingEditor } from "./pricing-editor";
import { pricingEntryDraftsFor, pricingIsValid } from "./pricing-model";

const {
  Button,
  Checkbox,
  Field,
  MessageBar,
  MessageBarBody,
  Switch,
  Text,
  makeStyles,
} = fluentComponents;

const useStyles = makeStyles({
  endpointLabel: {
    fontFamily: "monospace !important",
  },
});

export interface ModelDetailRow {
  key: string;
  source: "auto" | "manual";
  config: UpstreamModelConfig;
  manualIndex: number | null;
  hasAuto: boolean;
}

const reasoningPresets = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function ModelDetail({
  flags,
  onBack,
  onDelete,
  onSourceChange,
  onUpdate,
  readOnly,
  record,
  row,
  upstreamFlags,
}: {
  flags: Flag[];
  onBack: () => void;
  onDelete: () => void;
  onSourceChange: (source: "auto" | "manual") => void;
  onUpdate: (value: UpstreamModelConfig) => void;
  readOnly: boolean;
  record: UpstreamRecord;
  row: ModelDetailRow;
  upstreamFlags: UpstreamRecord["flag_overrides"];
}) {
  const { t } = useTranslation();
  const styles = useStyles();
  const editable = row.source === "manual" && !readOnly;
  const patch = (next: Partial<UpstreamModelConfig>) => {
    if (!editable) return;
    const updated = { ...row.config, ...next };
    for (const key of Object.keys(next) as (keyof UpstreamModelConfig)[]) {
      if (next[key] === undefined) delete (updated as unknown as Record<string, unknown>)[key];
    }
    onUpdate(updated);
  };
  const [savedFlagOverrides, setSavedFlagOverrides] = useState(row.config.flagOverrides ?? {});
  useEffect(() => setSavedFlagOverrides(row.config.flagOverrides ?? {}), [row.key]);

  const setKind = (kind: UpstreamModelConfig["kind"]) => patch({
    kind,
    endpoints: defaultEndpointsForKind(kind, row.config.endpoints),
    ...(kind === "image" ? { limits: undefined, chat: undefined } : {}),
  });

  const updateLimit = (key: keyof NonNullable<UpstreamModelConfig["limits"]>, raw: string) => {
    const limits = { ...(row.config.limits ?? {}) };
    const value = optionalNumber(raw);
    if (value === undefined) delete limits[key]; else limits[key] = value;
    patch({ limits: Object.keys(limits).length ? limits : undefined });
  };

  const updateReasoning = (update: Partial<NonNullable<UpstreamChatConfig["reasoning"]>>) => {
    const reasoning = cleanObject({ ...(row.config.chat?.reasoning ?? {}), ...update });
    const chat = cleanChat({ ...(row.config.chat ?? {}), reasoning: Object.keys(reasoning).length ? reasoning : undefined });
    patch({ chat });
  };

  const validationError = modelValidationError(row.config, t);
  const effort = row.config.chat?.reasoning?.effort;
  const budget = row.config.chat?.reasoning?.budget_tokens;
  const mandatory = row.config.chat?.reasoning?.mandatory === true;
  const controlledReasoning = effort !== undefined || budget !== undefined || row.config.chat?.reasoning?.adaptive === true;

  return (
    <div className="grid gap-5 min-w-0">
      <div className="flex items-center gap-3 min-w-0">
        <Button appearance="subtle" icon={<ArrowLeftRegular />} onClick={onBack}>
          {t("dashboard.upstreamEditor.models.back")}
        </Button>
        <Text size={600} weight="semibold" truncate className="min-w-0">
          {row.config.display_name ?? publicModelId(row.config)}
        </Text>
        <div className="ml-auto flex-none">
          <SegmentedControl
            ariaLabel={t("dashboard.upstreamEditor.models.source")}
            items={[
              { value: "auto", label: t("dashboard.upstreamEditor.models.auto"), disabled: readOnly || !row.hasAuto },
              { value: "manual", label: t("dashboard.upstreamEditor.models.manual"), disabled: readOnly },
            ]}
            value={row.source}
            onChange={(source) => onSourceChange(source as "auto" | "manual")}
          />
        </div>
      </div>

      {validationError && <MessageBar intent="error"><MessageBarBody>{validationError}</MessageBarBody></MessageBar>}

      <EditorBlock title={t("dashboard.upstreamEditor.models.identity")}>
        <div className="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
          <Field className="min-w-0" label={t("dashboard.upstreamEditor.models.displayName")}>
            <Input className="!w-full" placeholder={t("dashboard.upstreamEditor.models.displayNamePlaceholder")} readOnly={!editable} value={row.config.display_name ?? ""} onChange={(_, data) => patch({ display_name: data.value || undefined })} />
          </Field>
          <Field className="min-w-0" label={t("dashboard.upstreamEditor.models.kind")}>
            <Select key={row.config.kind} disabled={!editable} defaultValue={row.config.kind} onChange={(_, data) => setKind(data.value as UpstreamModelConfig["kind"])}>
              <option value="chat">Chat</option><option value="embedding">Embedding</option><option value="image">Image</option>
            </Select>
          </Field>
          <Field className="min-w-0" label={record.kind === "azure" ? t("dashboard.upstreamEditor.models.deployment") : t("dashboard.upstreamEditor.models.upstreamId")}>
            <Input className="!w-full" placeholder={record.kind === "azure" ? t("dashboard.upstreamEditor.models.deploymentPlaceholder") : t("dashboard.upstreamEditor.models.upstreamIdPlaceholder")} readOnly={!editable || row.hasAuto} value={row.config.upstreamModelId} onChange={(_, data) => patch({ upstreamModelId: data.value })} />
          </Field>
          <Field className="min-w-0" label={t("dashboard.upstreamEditor.models.publicId")}>
            <Input className="!w-full" placeholder={row.config.upstreamModelId || t("dashboard.upstreamEditor.models.publicIdPlaceholder")} readOnly={!editable} value={row.config.publicModelId ?? ""} onChange={(_, data) => patch({ publicModelId: data.value || undefined })} />
          </Field>
        </div>
      </EditorBlock>

      {row.config.kind !== "embedding" && <EditorBlock title={t("dashboard.upstreamEditor.models.endpoints")}>
        <div className="grid gap-1">
          {modelEndpointOptions(row.config.kind).map(([key, label]) => <Checkbox
            checked={key in row.config.endpoints}
            disabled={!editable}
            key={key}
            label={{ children: label, className: styles.endpointLabel }}
            onChange={(_, data) => {
              const endpoints = { ...row.config.endpoints };
              if (data.checked) endpoints[key] = {}; else delete endpoints[key];
              patch({ endpoints });
            }}
          />)}
        </div>
      </EditorBlock>}

      {row.config.kind !== "image" && <EditorBlock title={t("dashboard.upstreamEditor.models.capabilities")}>
        <div className="grid grid-cols-3 gap-4 max-[760px]:grid-cols-1">
          <NumberField label={t("dashboard.upstreamEditor.models.contextWindow")} placeholder="e.g. 1050000" readOnly={!editable} value={row.config.limits?.max_context_window_tokens} onChange={(raw) => updateLimit("max_context_window_tokens", raw)} />
          <NumberField label={t("dashboard.upstreamEditor.models.promptTokens")} placeholder="e.g. 922000" readOnly={!editable} value={row.config.limits?.max_prompt_tokens} onChange={(raw) => updateLimit("max_prompt_tokens", raw)} />
          <NumberField label={t("dashboard.upstreamEditor.models.outputTokens")} placeholder="e.g. 128000" readOnly={!editable} value={row.config.limits?.max_output_tokens} onChange={(raw) => updateLimit("max_output_tokens", raw)} />
        </div>
        {row.config.kind === "chat" && <>
          <Switch
            checked={row.config.chat?.modalities?.input.includes("image") === true}
            disabled={!editable}
            label={t("dashboard.upstreamEditor.models.imageInput")}
            onChange={(_, data) => patch({ chat: cleanChat({ ...(row.config.chat ?? {}), modalities: data.checked ? { input: ["text", "image"], output: ["text"] } : undefined }) })}
          />
          <div className="grid gap-3">
            <Text weight="semibold">{t("dashboard.upstreamEditor.models.reasoning")}</Text>
            <div className="flex flex-wrap gap-4">
              <Switch checked={effort !== undefined} disabled={!editable || mandatory} label={t("dashboard.upstreamEditor.models.effortLevels")} onChange={(_, data) => updateReasoning({ effort: data.checked ? { supported: ["low", "medium", "high"], default: "medium" } : undefined })} />
              <Switch checked={budget !== undefined} disabled={!editable || mandatory} label={t("dashboard.upstreamEditor.models.budgetTokens")} onChange={(_, data) => updateReasoning({ budget_tokens: data.checked ? {} : undefined })} />
              <Switch checked={row.config.chat?.reasoning?.adaptive === true} disabled={!editable || mandatory} label={t("dashboard.upstreamEditor.models.adaptive")} onChange={(_, data) => updateReasoning({ adaptive: data.checked ? true : undefined })} />
              <Switch checked={mandatory} disabled={!editable || controlledReasoning} label={t("dashboard.upstreamEditor.models.mandatory")} onChange={(_, data) => updateReasoning(data.checked ? { mandatory: true } : { mandatory: undefined })} />
            </div>
            {effort && <EffortEditor editable={editable} effort={effort} onChange={(next) => updateReasoning({ effort: next })} t={t} />}
            {budget && <div className="grid grid-cols-2 gap-4 max-w-[420px]">
              <NumberField label={t("dashboard.upstreamEditor.models.minimum")} placeholder="e.g. 1024" readOnly={!editable} value={budget.min} onChange={(raw) => updateReasoning({ budget_tokens: numberRange(budget, "min", raw) })} />
              <NumberField label={t("dashboard.upstreamEditor.models.maximum")} placeholder="e.g. 32000" readOnly={!editable} value={budget.max} onChange={(raw) => updateReasoning({ budget_tokens: numberRange(budget, "max", raw) })} />
            </div>}
          </div>
        </>}
      </EditorBlock>}

      <EditorBlock title={t("dashboard.upstreamEditor.models.pricing")} description={t("dashboard.upstreamEditor.models.pricingHint")}>
        <PricingEditor
          editable={editable}
          kind={row.config.kind}
          onChange={(pricing) => patch({ pricing })}
          value={row.config.pricing}
        />
      </EditorBlock>

      <EditorBlock title={t("dashboard.upstreamEditor.models.flags")} description={t("dashboard.upstreamEditor.models.flagsHint")}>
        {editable && <Switch
          checked={row.config.flagOverrides !== undefined}
          label={t("dashboard.upstreamEditor.models.enableFlagOverrides")}
          onChange={(_, data) => {
            if (data.checked) patch({ flagOverrides: savedFlagOverrides });
            else { setSavedFlagOverrides(row.config.flagOverrides ?? {}); patch({ flagOverrides: undefined }); }
          }}
        />}
        {(!editable || row.config.flagOverrides !== undefined) && <FeatureFlagsEditor
          defaults={record.flag_defaults}
          inherited={upstreamFlags}
          flags={flags}
          readOnly={!editable}
          value={row.config.flagOverrides ?? {}}
          onChange={(flagOverrides) => { setSavedFlagOverrides(flagOverrides); patch({ flagOverrides }); }}
        />}
      </EditorBlock>

      {editable && <Button appearance="secondary" icon={<DeleteRegular />} onClick={onDelete}>
        {t("dashboard.upstreamEditor.models.delete")}
      </Button>}
    </div>
  );
}

function EditorBlock({ children, description, title }: { children: React.ReactNode; description?: string; title: string }) {
  return <section className="grid gap-4 border border-solid border-fui-stroke1 rounded-lg bg-fui-bg1 p-5">
    <div className="grid gap-1"><Text as="h2" size={400} weight="semibold" className="!m-0">{title}</Text>{description && <Text size={200} className="text-fui-fg2">{description}</Text>}</div>
    {children}
  </section>;
}

function NumberField({ label, onChange, placeholder, readOnly, value }: { label: string; onChange: (raw: string) => void; placeholder: string; readOnly: boolean; value?: number }) {
  return <Field className="min-w-0" label={label}><Input className="!w-full" min={0} placeholder={placeholder} readOnly={readOnly} type="number" value={value === undefined ? "" : String(value)} onChange={(_, data) => onChange(data.value)} /></Field>;
}

function EffortEditor({ editable, effort, onChange, t }: { editable: boolean; effort: NonNullable<UpstreamChatConfig["reasoning"]>["effort"] & {}; onChange: (effort: NonNullable<UpstreamChatConfig["reasoning"]>["effort"]) => void; t: ReturnType<typeof useTranslation>["t"] }) {
  const [custom, setCustom] = useState("");
  const supported = effort.supported;
  const add = (level: string) => { const value = level.trim(); if (value && !supported.includes(value)) onChange({ supported: [...supported, value], default: effort.default || value }); };
  return <div className="grid gap-3 border-l-2 border-l-solid border-fui-stroke1 pl-4">
    <div className="flex flex-wrap gap-2">{supported.map((level) => <Button key={level} disabled={!editable} appearance={effort.default === level ? "primary" : "secondary"} size="small" onClick={() => onChange({ ...effort, default: level })}>{level}<span onClick={(event) => { event.stopPropagation(); const next = supported.filter((item) => item !== level); onChange({ supported: next, default: effort.default === level ? next[0] ?? "" : effort.default }); }}> ×</span></Button>)}</div>
    {editable && <div className="flex flex-wrap gap-2">{reasoningPresets.filter((level) => !supported.includes(level)).map((level) => <Button key={level} size="small" onClick={() => add(level)}>+ {level}</Button>)}<Input className="!w-[130px]" placeholder={t("dashboard.upstreamEditor.models.customEffortPlaceholder")} size="small" value={custom} onChange={(_, data) => setCustom(data.value)} /><Button size="small" onClick={() => { add(custom); setCustom(""); }}>{t("dashboard.upstreamEditor.models.add")}</Button></div>}
  </div>;
}

export function modelValidationError(model: UpstreamModelConfig, t: ReturnType<typeof useTranslation>["t"]): string | null {
  const effort = model.chat?.reasoning?.effort;
  if (effort && (effort.supported.length === 0 || !effort.default || !effort.supported.includes(effort.default))) return t("dashboard.upstreamEditor.models.invalidEffort");
  const budget = model.chat?.reasoning?.budget_tokens;
  if (budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min) return t("dashboard.upstreamEditor.models.invalidBudget");
  if (!pricingIsValid(pricingEntryDraftsFor(model.pricing), model.pricing)) return t("dashboard.upstreamEditor.models.invalidPricing");
  return null;
}

export const modelsAreValid = (models: readonly UpstreamModelConfig[]) => models.every((model) => {
  const effort = model.chat?.reasoning?.effort;
  if (effort && (effort.supported.length === 0 || !effort.default || !effort.supported.includes(effort.default))) return false;
  const budget = model.chat?.reasoning?.budget_tokens;
  return !(budget?.min !== undefined && budget.max !== undefined && budget.max < budget.min)
    && pricingIsValid(pricingEntryDraftsFor(model.pricing), model.pricing);
});

const optionalNumber = (raw: string): number | undefined => raw === "" ? undefined : Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : undefined;
const cleanObject = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
const cleanChat = (chat: UpstreamChatConfig): UpstreamChatConfig | undefined => chat.modalities || chat.reasoning ? chat : undefined;
const numberRange = (range: { min?: number; max?: number }, key: "min" | "max", raw: string) => { const next = { ...range }; const value = optionalNumber(raw); if (value === undefined) delete next[key]; else next[key] = value; return next; };

const defaultEndpointsForKind = (kind: UpstreamModelConfig["kind"], current: UpstreamModelConfig["endpoints"]) => {
  if (kind === "embedding") return { embeddings: {} };
  const keys = kind === "image" ? ["imagesGenerations", "imagesEdits"] as const : ["completions", "chatCompletions", "responses", "messages"] as const;
  const kept: UpstreamModelConfig["endpoints"] = {};
  for (const key of keys) if (current[key]) kept[key] = current[key];
  if (Object.keys(kept).length) return kept;
  return kind === "image" ? { imagesGenerations: {}, imagesEdits: {} } : { chatCompletions: {} };
};

const modelEndpointOptions = (kind: UpstreamModelConfig["kind"]): [keyof UpstreamModelConfig["endpoints"], string][] => {
  if (kind === "image") return [["imagesGenerations", "/images/generations"], ["imagesEdits", "/images/edits"]];
  return [["completions", "/completions"], ["chatCompletions", "/chat/completions"], ["responses", "/responses"], ["messages", "/messages"]];
};
