import claudeIconUrl from "../../assets/claude-color.svg";
import codexIconUrl from "../../assets/codex.svg";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiKey, ControlPlaneModel } from "../../api/types";
import { CodeBlock } from "../ui/code-block";
import { Dropdown } from "../ui/fluent-form-controls";
import { fluentComponents } from "../../fluent";
const { Checkbox, Option, Tab, TabList, Text } = fluentComponents;
const apiKeyPlaceholder = "<your-api-key>";
const claudeModelPattern = /(^|\/)claude-/;
const codexModelPattern = /(^|\/)gpt-5/;
const claudeTier: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };
export function CliConfiguration({
  apiKey,
  copiedTag,
  selectedKey,
  models,
  onCopy,
}: {
  apiKey: string;
  copiedTag: string | null;
  selectedKey: ApiKey | null;
  models: ControlPlaneModel[];
  onCopy: (text: string, tag: string) => void;
}) {
  const { t } = useTranslation();
  const [activeSnippet, setActiveSnippet] = useState<"claude" | "codex">("claude");
  const [onlyClaudeModels, setOnlyClaudeModels] = useState(true);
  const [onlyGpt5Models, setOnlyGpt5Models] = useState(true);
  const baseUrl =
    typeof window === "undefined" ? "http://localhost:5173" : window.location.origin;
  const keyScopedModels = useMemo(
    () => modelsForApiKey(models, selectedKey),
    [models, selectedKey],
  );
  const chatIds = useMemo(
    () =>
      dedupe(
        keyScopedModels
          .filter((model) => model.kind === "chat")
          .map((model) => model.id),
      ),
    [keyScopedModels],
  );
  const claudeIds = useMemo(
    () =>
      dedupe(
        chatIds.filter((id) => !onlyClaudeModels || claudeModelPattern.test(id)),
      ),
    [chatIds, onlyClaudeModels],
  );
  const codexIds = useMemo(
    () =>
      dedupe(
        chatIds.filter((id) => !onlyGpt5Models || codexModelPattern.test(id)),
      ),
    [chatIds, onlyGpt5Models],
  );
  const claudeFable = useMemo(() => [...claudeIds].sort(sortClaudeFor("fable")), [claudeIds]);
  const claudeOpus = useMemo(() => [...claudeIds].sort(sortClaudeFor("opus")), [claudeIds]);
  const claudeSonnet = useMemo(() => [...claudeIds].sort(sortClaudeFor("sonnet")), [claudeIds]);
  const claudeHaiku = useMemo(() => [...claudeIds].sort(sortClaudeFor("haiku")), [claudeIds]);
  const codexModels = useMemo(() => [...codexIds].sort(sortCodex), [codexIds]);
  const [fableModel, setFableModel] = useState("");
  const [opusModel, setOpusModel] = useState("");
  const [sonnetModel, setSonnetModel] = useState("");
  const [haikuModel, setHaikuModel] = useState("");
  const [codexModel, setCodexModel] = useState("");

  useEffect(() => {
    setFableModel((current) => (claudeFable.includes(current) ? current : claudeFable[0] ?? ""));
    setOpusModel((current) => (claudeOpus.includes(current) ? current : claudeOpus[0] ?? ""));
    setSonnetModel((current) =>
      claudeSonnet.includes(current) ? current : claudeSonnet[0] ?? "",
    );
    setHaikuModel((current) =>
      claudeHaiku.includes(current) ? current : claudeHaiku[0] ?? "",
    );
    setCodexModel((current) =>
      codexModels.includes(current) ? current : codexModels[0] ?? "",
    );
  }, [claudeFable, claudeHaiku, claudeOpus, claudeSonnet, codexModels]);

  const contextById = useMemo(() => {
    const map = new Map<string, number>();
    for (const model of keyScopedModels) {
      if (model.kind !== "chat") continue;
      const limits = model.limits;
      const context =
        limits?.max_context_window_tokens ??
        ((limits?.max_prompt_tokens ?? 0) + (limits?.max_output_tokens ?? 0));
      map.set(model.id, context);
    }
    return map;
  }, [keyScopedModels]);
  const addContext = (id: string) => ((contextById.get(id) ?? 0) >= 1_000_000 ? `${id}[1m]` : id);

  const claudeSnippet = buildClaudeSettingsSnippet(baseUrl, apiKey, {
    fable: addContext(fableModel),
    opus: addContext(opusModel),
    sonnet: addContext(sonnetModel),
    haiku: haikuModel,
  });

  const codexBaseUrl = `${baseUrl}/azure-api.codex`;
  const codexSnippet = [
    codexModel ? `model = "${codexModel}"` : null,
    codexModel ? 'model_provider = "floway"' : null,
    "[model_providers.floway]",
    'name = "Floway"',
    `base_url = "${codexBaseUrl}"`,
    'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] } # Linux & macOS',
    '# auth = { command = "powershell", args = ["-NoProfile", "-Command", "$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME \'.codex\' }; [IO.File]::ReadAllText((Join-Path $h \'floway-token\'))"] } # Windows',
    'wire_api = "responses"',
    "supports_websockets = true",
    'http_headers = { "x-openai-actor-authorization" = "1" }',
    "",
    "[features]",
    "apps = false",
    "standalone_web_search = true",
  ].filter((line): line is string => line !== null).join("\n");
  const codexUnixCredential = codexUnixCredentialSnippet(apiKey);
  const codexWindowsCredential = codexWindowsCredentialSnippet(apiKey);

  return (
    <div className="grid gap-[14px] min-w-0">
      <TabList
        className="ml-[-8px]"
        selectedValue={activeSnippet}
        onTabSelect={(_, data) => setActiveSnippet(data.value === "codex" ? "codex" : "claude")}
      >
        <ProviderTab value="claude" icon={<img alt="" src={claudeIconUrl} />} label={t("dashboard.apiKeys.configuration.claudeCode")} />
        <ProviderTab value="codex" icon={<img alt="" src={codexIconUrl} />} label={t("dashboard.apiKeys.configuration.codex")} />
      </TabList>

      {activeSnippet === "claude" ? (
        <div className="grid gap-[10px] min-w-0">
          <Checkbox
            checked={onlyClaudeModels}
            className="justify-self-start ml-[-8px]"
            label={t("dashboard.apiKeys.configuration.onlyClaudeModels")}
            onChange={(_, data) => setOnlyClaudeModels(!!data.checked)}
          />
          <div className="flex items-end flex-wrap gap-[10px] min-w-0">
            <SnippetSelect
              label={t("dashboard.apiKeys.configuration.fable")}
              onChange={setFableModel}
              options={claudeFable}
              value={fableModel}
            />
            <SnippetSelect
              label={t("dashboard.apiKeys.configuration.opus")}
              onChange={setOpusModel}
              options={claudeOpus}
              value={opusModel}
            />
            <SnippetSelect
              label={t("dashboard.apiKeys.configuration.sonnet")}
              onChange={setSonnetModel}
              options={claudeSonnet}
              value={sonnetModel}
            />
            <SnippetSelect
              label={t("dashboard.apiKeys.configuration.haiku")}
              onChange={setHaikuModel}
              options={claudeHaiku}
              value={haikuModel}
            />
          </div>
          <HintText>{t("dashboard.apiKeys.configuration.claudeHint")}</HintText>
          <CodeBlock
            code={claudeSnippet}
            copied={copiedTag === "snippet-claude"}
            language="json"
            onCopy={() => onCopy(claudeSnippet, "snippet-claude")}
          />
        </div>
      ) : (
        <div className="grid gap-[10px] min-w-0">
          <Checkbox
            checked={onlyGpt5Models}
            className="justify-self-start ml-[-8px]"
            label={t("dashboard.apiKeys.configuration.onlyGpt5Models")}
            onChange={(_, data) => setOnlyGpt5Models(!!data.checked)}
          />
          <div className="flex items-end flex-wrap gap-[10px] min-w-0">
            <SnippetSelect
              label={t("dashboard.apiKeys.configuration.model")}
              onChange={setCodexModel}
              options={codexModels}
              value={codexModel}
            />
          </div>
          <HintText>{t("dashboard.apiKeys.configuration.codexConfigHint")}</HintText>
          <CodeBlock
            code={codexSnippet}
            copied={copiedTag === "snippet-codex-config"}
            language="toml"
            onCopy={() => onCopy(codexSnippet, "snippet-codex-config")}
          />
          <HintText>{t("dashboard.apiKeys.configuration.codexAuthHint")}</HintText>
          <CodeBlock
            code={codexUnixCredential}
            copied={copiedTag === "snippet-codex-auth"}
            language="bash"
            onCopy={() => onCopy(codexUnixCredential, "snippet-codex-auth")}
          />
          <HintText>{t("dashboard.apiKeys.configuration.codexWindowsAuthHint")}</HintText>
          <CodeBlock
            code={codexWindowsCredential}
            copied={copiedTag === "snippet-codex-auth-windows"}
            language="powershell"
            onCopy={() => onCopy(codexWindowsCredential, "snippet-codex-auth-windows")}
          />
        </div>
      )}
    </div>
  );
}

function SnippetSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="grid gap-1 min-w-[min(220px,100%)] [&_span]:text-fui-fg2 [&_span]:text-xs [&_span]:font-fui-semibold">
      <span>{label}</span>
      <Dropdown
        disabled={options.length === 0}
        onOptionSelect={(_, data) => onChange(data.optionValue ?? "")}
        selectedOptions={value ? [value] : []}
        value={value}
      >
        {options.length === 0 ? (
          <Option value="">{apiKeyPlaceholder}</Option>
        ) : (
          options.map((option) => (
            <Option key={option} value={option}>
              {option}
            </Option>
          ))
        )}
      </Dropdown>
    </label>
  );
}

function HintText({ children }: { children: string }) {
  return <Text size={200} className="text-fui-fg2 leading-[1.35] !m-0">{children}</Text>;
}

function ProviderTab({ value, icon, label }: { value: string; icon: React.ReactElement; label: string }) {
  return (
    <Tab value={value}>
      <span className="inline-flex items-center gap-[7px] min-w-0 [&_img]:block [&_img]:flex-none [&_img]:h-4 [&_img]:w-4">
        {icon}{label}
      </span>
    </Tab>
  );
}
const modelsForApiKey = (models: ControlPlaneModel[], key: ApiKey | null) => {
  if (!key?.upstream_ids) return models;
  if (key.upstream_ids.length === 0) return [];
  const allowed = new Set(key.upstream_ids);
  return models.filter((model) =>
    model.upstreams.some((upstream) => allowed.has(upstream.id)),
  );
};

const tierOfClaude = (id: string) => {
  for (const tier of Object.keys(claudeTier)) {
    if (id.includes(tier)) return claudeTier[tier]!;
  }
  return 99;
};

const sortClaudeFor = (tier: keyof typeof claudeTier) => (a: string, b: string) => {
  const diffA = Math.abs(tierOfClaude(a) - claudeTier[tier]);
  const diffB = Math.abs(tierOfClaude(b) - claudeTier[tier]);
  return diffA !== diffB ? diffA - diffB : b.localeCompare(a);
};

export const buildClaudeSettingsSnippet = (
  baseUrl: string,
  apiKey: string,
  models: { fable: string; opus: string; sonnet: string; haiku: string },
) => JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_DEFAULT_FABLE_MODEL: models.fable,
    ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
  },
}, null, 2);

const sortCodex = (a: string, b: string) => {
  const miniA = a.includes("mini") ? 1 : 0;
  const miniB = b.includes("mini") ? 1 : 0;
  return miniA !== miniB ? miniA - miniB : b.localeCompare(a);
};

const dedupe = (items: string[]) => [...new Set(items)];

export const codexUnixCredentialSnippet = (apiKey: string) => {
  const quoted = `'${apiKey.replaceAll("'", `'"'"'`)}'`;
  return [
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home" && \\',
    `  printf '%s' ${quoted} > "$codex_home/floway-token" && \\`,
    '  chmod 600 "$codex_home/floway-token"',
  ].join("\n");
};

export const codexWindowsCredentialSnippet = (apiKey: string) => {
  const quoted = `'${apiKey.replaceAll("'", "''")}'`;
  return [
    '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
    'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
    `[IO.File]::WriteAllText((Join-Path $codexHome "floway-token"), ${quoted}, (New-Object Text.UTF8Encoding($false)))`,
  ].join("\n");
};
