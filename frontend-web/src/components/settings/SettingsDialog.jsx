import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, KeyRound, LogOut, Plus, SlidersHorizontal } from "lucide-react";
import { Dialog } from "../overlays/Dialog.jsx";
import { methods } from "../../methods.js";

export const BUILTIN_PROVIDER_CATALOG = [
  { id: "openai", name: "OpenAI", methods: ["api_key", "oauth"], envKey: "OPENAI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", methods: ["api_key"], envKey: "DEEPSEEK_API_KEY" },
  { id: "anthropic", name: "Anthropic", methods: ["api_key"], envKey: "ANTHROPIC_API_KEY" },
  { id: "google", name: "Google Gemini", methods: ["api_key"], envKey: "GEMINI_API_KEY" },
  { id: "openrouter", name: "OpenRouter", methods: ["api_key"], envKey: "OPENROUTER_API_KEY" },
  { id: "xai", name: "xAI (Grok)", methods: ["api_key"], envKey: "XAI_API_KEY" },
  { id: "qwen", name: "Qwen (DashScope)", methods: ["api_key"], envKey: "DASHSCOPE_API_KEY" },
  { id: "kimi-coding", name: "Kimi for Coding", methods: ["api_key"], envKey: "KIMI_API_KEY" },
  { id: "moonshot", name: "Moonshot AI", methods: ["api_key"], envKey: "MOONSHOT_API_KEY" },
  { id: "zai", name: "Z.AI", methods: ["api_key"], envKey: "ZAI_API_KEY" },
  { id: "zhipu", name: "Zhipu AI (GLM)", methods: ["api_key"], envKey: "ZHIPU_API_KEY" },
  { id: "minimax", name: "MiniMax", methods: ["api_key"], envKey: "MINIMAX_API_KEY" },
  { id: "volcengine", name: "Volcengine (Ark)", methods: ["api_key"], envKey: "ARK_API_KEY" },
  { id: "xiaomi", name: "Xiaomi MiMo", methods: ["api_key"], envKey: "MIMO_API_KEY" },
  { id: "hunyuan", name: "Tencent Hunyuan", methods: ["api_key"], envKey: "HUNYUAN_API_KEY" },
  { id: "groq", name: "Groq", methods: ["api_key"], envKey: "GROQ_API_KEY" },
  { id: "mistral", name: "Mistral", methods: ["api_key"], envKey: "MISTRAL_API_KEY" },
  { id: "siliconflow", name: "SiliconFlow", methods: ["api_key"], envKey: "SILICONFLOW_API_KEY" },
  { id: "together", name: "Together AI", methods: ["api_key"], envKey: "TOGETHER_API_KEY" },
  { id: "fireworks", name: "Fireworks AI", methods: ["api_key"], envKey: "FIREWORKS_API_KEY" },
  { id: "cerebras", name: "Cerebras", methods: ["api_key"], envKey: "CEREBRAS_API_KEY" },
  { id: "perplexity", name: "Perplexity", methods: ["api_key"], envKey: "PERPLEXITY_API_KEY" },
  { id: "cohere", name: "Cohere", methods: ["api_key"], envKey: "COHERE_API_KEY" },
  { id: "nvidia", name: "NVIDIA NIM", methods: ["api_key"], envKey: "NVIDIA_API_KEY" },
  { id: "longcat", name: "LongCat", methods: ["api_key"], envKey: "LONGCAT_API_KEY" },
];

const TABS = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontal,
    title: "General",
    desc: "Global runtime defaults (~/.rind/settings.json) and active workspace overrides.",
  },
  {
    id: "providers",
    label: "Providers",
    icon: KeyRound,
    title: "Providers & Subscriptions",
    desc: "Manage OAuth subscriptions, API keys (~/.rind/auth.json), and custom endpoints (~/.rind/providers.json).",
  },
  {
    id: "preferences",
    label: "Preferences",
    icon: Bell,
    title: "Preferences",
    desc: "Appearance, notifications, and keyboard shortcuts.",
  },
  {
    id: "account",
    label: "Account",
    icon: LogOut,
    title: "Account & Device",
    desc: "Device session and runtime connection status.",
  },
];

const THEMES = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const SHORTCUTS = [
  { keys: ["Ctrl", "K"], label: "Open command palette" },
  { keys: ["Ctrl", "B"], label: "Toggle sidebar" },
  { keys: ["Ctrl", "I"], label: "Toggle inspector" },
  { keys: ["Enter"], label: "Send message" },
  { keys: ["Shift", "Enter"], label: "Insert newline" },
  { keys: ["Alt", "Enter"], label: "Steer active turn" },
  { keys: ["Escape"], label: "Close dialog or menu" },
];

const EMPTY_CUSTOM_DRAFT = {
  id: "",
  name: "",
  api: "openai-chat",
  baseUrl: "",
  defaultModel: "",
  apiKey: "",
  envKey: "",
};

function formatProviderStatus(provider) {
  if (!provider.configured) return "Not configured";
  if (provider.authType === "oauth") return "OAuth subscription (auth.json)";
  if (provider.authType === "api_key") {
    return provider.maskedKey ? `API key · ${provider.maskedKey}` : "API key (auth.json)";
  }
  if (provider.source === "env") {
    return provider.envKey ? `Environment (${provider.envKey})` : "Environment variable";
  }
  return provider.source ? `Signed in (${provider.source})` : "Signed in";
}

export function SettingsDialog({
  open,
  onClose,
  theme = "system",
  onTheme,
  onLogout,
  request,
  info,
  workspace = "",
  notificationPermission = "default",
  onEnableNotifications,
  onSettingsChanged,
  initialTab = "general",
}) {
  const [tab, setTab] = useState(initialTab);
  const [localSettings, setLocalSettings] = useState({
    provider: "openai",
    model: "gpt-4o-mini",
    reasoningEffort: "",
    hasApiKey: true,
    authDetails: {},
    customProviders: [],
  });
  const [runtimeProviders, setRuntimeProviders] = useState([]);
  const [generalProvider, setGeneralProvider] = useState("openai");
  const [generalModel, setGeneralModel] = useState("gpt-4o-mini");
  const [generalEffort, setGeneralEffort] = useState("");
  const [generalApiKey, setGeneralApiKey] = useState("");
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [generalStatus, setGeneralStatus] = useState({ tone: "", text: "" });

  const [folderDefaults, setFolderDefaults] = useState(null);
  const [folderBusy, setFolderBusy] = useState(false);

  const [providerSearch, setProviderSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [editingKeyId, setEditingKeyId] = useState("");
  const [inlineKeyValue, setInlineKeyValue] = useState("");
  const [providerBusyId, setProviderBusyId] = useState("");
  const [providerNotice, setProviderNotice] = useState({ tone: "", text: "" });
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState(EMPTY_CUSTOM_DRAFT);

  const loadAllSettings = useCallback(async () => {
    let fetchedLocal = null;
    if (typeof fetch === "function") {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const data = await res.json();
          if (data?.result) fetchedLocal = data.result;
        }
      } catch {
        // Fallback to runtime RPC when /api/settings is not present
      }
    }

    let globalResolved = null;
    if (typeof request === "function") {
      try {
        const fd = await request(methods.folderDefaultsGet, { workspace_root: workspace || "" });
        if (fd && typeof fd === "object") {
          setFolderDefaults(fd);
          if (fd.inherited && fd.resolved) globalResolved = fd.resolved;
        }
      } catch {
        // Ignore if runtime is not connected
      }
      try {
        const authRes = await request(methods.authList, {});
        if (Array.isArray(authRes?.providers)) {
          setRuntimeProviders(authRes.providers);
        }
      } catch {
        // Ignore
      }
    }

    const nextProvider =
      fetchedLocal?.provider ||
      globalResolved?.provider_id ||
      info?.provider ||
      "openai";
    const nextModel =
      fetchedLocal?.model ||
      globalResolved?.model_id ||
      info?.model ||
      "gpt-4o-mini";
    const nextEffort =
      fetchedLocal?.reasoningEffort ??
      globalResolved?.reasoning_effort ??
      info?.reasoning_effort ??
      "";

    if (fetchedLocal) {
      setLocalSettings(fetchedLocal);
    } else {
      setLocalSettings((prev) => ({
        ...prev,
        provider: nextProvider,
        model: nextModel,
        reasoningEffort: nextEffort,
      }));
    }
    setGeneralProvider(nextProvider);
    setGeneralModel(nextModel);
    setGeneralEffort(nextEffort);
  }, [request, workspace, info?.provider, info?.model, info?.reasoning_effort]);

  useEffect(() => {
    if (!open) return;
    setGeneralStatus({ tone: "", text: "" });
    setProviderNotice({ tone: "", text: "" });
    void loadAllSettings();
  }, [open, loadAllSettings]);

  const mergedProviders = useMemo(() => {
    const authDetails = localSettings.authDetails || {};
    const customMap = new Map();
    for (const c of localSettings.customProviders || []) {
      customMap.set(c.id, c);
    }

    const baseList =
      runtimeProviders.length > 0
        ? runtimeProviders.map((p) => {
            const builtin = BUILTIN_PROVIDER_CATALOG.find((b) => b.id === p.id);
            return {
              id: p.id,
              name: p.name || builtin?.name || p.id,
              methods: Array.isArray(p.methods) && p.methods.length ? p.methods : ["api_key"],
              configured: Boolean(p.configured),
              source: p.source || "",
              envKey: p.env_key || builtin?.envKey || "",
            };
          })
        : BUILTIN_PROVIDER_CATALOG.map((b) => ({
            id: b.id,
            name: b.name,
            methods: [...b.methods],
            configured: Boolean(authDetails[b.id]),
            source: authDetails[b.id] ? "auth.json" : "",
            envKey: b.envKey || "",
          }));

    const seen = new Set(baseList.map((p) => p.id));
    for (const custom of customMap.values()) {
      if (!seen.has(custom.id)) {
        baseList.push({
          id: custom.id,
          name: custom.name || custom.id,
          methods: ["api_key"],
          configured: Boolean(authDetails[custom.id]),
          source: authDetails[custom.id] ? "auth.json" : "",
          envKey: custom.envKey || "",
        });
        seen.add(custom.id);
      }
    }

    return baseList.map((p) => {
      const detail = authDetails[p.id];
      const custom = customMap.get(p.id);
      const configured = Boolean(p.configured || detail);
      const authType =
        detail?.type === "oauth"
          ? "oauth"
          : detail?.type === "api_key"
            ? "api_key"
            : p.source === "env"
              ? "env"
              : configured
                ? "api_key"
                : "";
      return {
        ...p,
        name: custom?.name || p.name || p.id,
        configured,
        source: detail ? "auth.json" : p.source,
        custom,
        authType,
        maskedKey: detail?.maskedKey || "",
      };
    });
  }, [localSettings.authDetails, localSettings.customProviders, runtimeProviders]);

  const sortedForSelect = useMemo(() => {
    return [...mergedProviders].sort((a, b) => {
      if (a.configured !== b.configured) return a.configured ? -1 : 1;
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
  }, [mergedProviders]);

  const modelSuggestions = useMemo(() => {
    const set = new Set();
    const runtimeModels = Array.isArray(info?.models) ? info.models : [];
    for (const m of runtimeModels) {
      if (!m.providerId || m.providerId === generalProvider) {
        if (m.id) set.add(m.id);
      }
    }
    const custom = (localSettings.customProviders || []).find((c) => c.id === generalProvider);
    if (custom && Array.isArray(custom.models)) {
      for (const m of custom.models) set.add(m);
    }
    for (const m of runtimeModels) {
      if (m.id) set.add(m.id);
    }
    if (generalModel) set.add(generalModel);
    return [...set].slice(0, 60);
  }, [info?.models, generalProvider, generalModel, localSettings.customProviders]);

  const filteredProviders = useMemo(() => {
    const q = providerSearch.trim().toLowerCase();
    return mergedProviders
      .filter((p) => {
        if (providerFilter === "configured" && !p.configured) return false;
        if (providerFilter === "oauth" && !p.methods.includes("oauth") && p.authType !== "oauth") return false;
        if (providerFilter === "custom" && !p.custom) return false;
        if (!q) return true;
        return (
          p.id.toLowerCase().includes(q) ||
          (p.name || "").toLowerCase().includes(q) ||
          (p.envKey || "").toLowerCase().includes(q) ||
          (p.custom?.baseUrl || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const aDef = (localSettings.provider || "openai") === a.id ? 1 : 0;
        const bDef = (localSettings.provider || "openai") === b.id ? 1 : 0;
        if (aDef !== bDef) return bDef - aDef;
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        return (a.name || a.id).localeCompare(b.name || b.id);
      });
  }, [mergedProviders, providerSearch, providerFilter, localSettings.provider]);

  const selectedProviderObj = useMemo(
    () => mergedProviders.find((p) => p.id === generalProvider),
    [mergedProviders, generalProvider],
  );

  async function postLocalSettings(patch) {
    if (typeof fetch !== "function") return null;
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || "Failed to save settings.");
    }
    if (data?.result) setLocalSettings(data.result);
    return data?.result;
  }

  async function handleSaveGeneral(event) {
    event?.preventDefault?.();
    const provider = generalProvider.trim() || "openai";
    const model = generalModel.trim() || "gpt-4o-mini";
    const reasoningEffort = generalEffort.trim();
    const apiKey = generalApiKey.trim();

    setSavingGeneral(true);
    setGeneralStatus({ tone: "", text: "" });
    try {
      await postLocalSettings({
        provider,
        model,
        reasoningEffort,
        ...(apiKey ? { providerCredential: { providerId: provider, apiKey } } : {}),
      }).catch(() => null);

      if (typeof request === "function") {
        await request(methods.folderDefaultsSet, {
          scope: "global",
          provider_id: provider,
          model_id: model,
          reasoning_effort: reasoningEffort,
        }).catch(() => null);
      }

      setGeneralApiKey("");
      await loadAllSettings();
      onSettingsChanged?.();
      setGeneralStatus({
        tone: "success",
        text: `Saved global defaults (${provider} / ${model}).`,
      });
    } catch (error) {
      setGeneralStatus({
        tone: "error",
        text: error?.message || String(error),
      });
    } finally {
      setSavingGeneral(false);
    }
  }

  async function handleWorkspaceDefaultAction(action) {
    if (!workspace || typeof request !== "function") return;
    setFolderBusy(true);
    try {
      if (action === "pin") {
        await request(methods.folderDefaultsSet, {
          scope: "folder",
          workspace_root: workspace,
          provider_id: generalProvider.trim() || "openai",
          model_id: generalModel.trim() || "gpt-4o-mini",
          reasoning_effort: generalEffort.trim(),
        });
        setGeneralStatus({ tone: "success", text: "Pinned defaults to current workspace." });
      } else if (action === "reset") {
        await request(methods.folderDefaultsUnset, { workspace_root: workspace });
        setGeneralStatus({ tone: "success", text: "Reset workspace to global defaults." });
      }
      await loadAllSettings();
      onSettingsChanged?.();
    } catch (error) {
      setGeneralStatus({ tone: "error", text: error?.message || String(error) });
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleSaveInlineKey(providerId) {
    const key = inlineKeyValue.trim();
    if (!key) {
      setProviderNotice({ tone: "error", text: "Enter a non-empty API key." });
      return;
    }
    setProviderBusyId(providerId);
    setProviderNotice({ tone: "", text: "" });
    try {
      await postLocalSettings({
        providerCredential: { providerId, apiKey: key },
      });
      setEditingKeyId("");
      setInlineKeyValue("");
      await loadAllSettings();
      onSettingsChanged?.();
      setProviderNotice({ tone: "success", text: `Saved API key for ${providerId}.` });
    } catch (error) {
      setProviderNotice({ tone: "error", text: error?.message || String(error) });
    } finally {
      setProviderBusyId("");
    }
  }

  async function handleLogoutProvider(providerId) {
    setProviderBusyId(providerId);
    setProviderNotice({ tone: "", text: "" });
    try {
      await postLocalSettings({ removeProviderCredentialId: providerId });
      await loadAllSettings();
      onSettingsChanged?.();
      setProviderNotice({ tone: "success", text: `Removed stored credentials for ${providerId}.` });
    } catch (error) {
      setProviderNotice({ tone: "error", text: error?.message || String(error) });
    } finally {
      setProviderBusyId("");
    }
  }

  async function handleSaveCustomProvider(event) {
    event?.preventDefault?.();
    const name = customDraft.name.trim();
    const baseUrl = customDraft.baseUrl.trim();
    if (!name || !baseUrl) {
      setProviderNotice({ tone: "error", text: "Connection name and Base URL are required." });
      return;
    }
    setProviderBusyId(customDraft.id || name);
    setProviderNotice({ tone: "", text: "" });
    try {
      await postLocalSettings({
        customProvider: {
          ...(customDraft.id ? { id: customDraft.id } : {}),
          name,
          api: customDraft.api,
          baseUrl,
          ...(customDraft.defaultModel.trim() ? { defaultModel: customDraft.defaultModel.trim() } : {}),
          ...(customDraft.apiKey.trim() ? { apiKey: customDraft.apiKey.trim() } : {}),
          ...(customDraft.envKey.trim() ? { envKey: customDraft.envKey.trim() } : {}),
        },
      });
      setCustomFormOpen(false);
      setCustomDraft(EMPTY_CUSTOM_DRAFT);
      await loadAllSettings();
      onSettingsChanged?.();
      setProviderNotice({ tone: "success", text: `Saved custom provider "${name}".` });
    } catch (error) {
      setProviderNotice({ tone: "error", text: error?.message || String(error) });
    } finally {
      setProviderBusyId("");
    }
  }

  async function handleDeleteCustomProvider(providerId) {
    setProviderBusyId(providerId);
    setProviderNotice({ tone: "", text: "" });
    try {
      await postLocalSettings({ deleteCustomProviderId: providerId });
      await loadAllSettings();
      onSettingsChanged?.();
      setProviderNotice({ tone: "success", text: `Removed custom provider "${providerId}".` });
    } catch (error) {
      setProviderNotice({ tone: "error", text: error?.message || String(error) });
    } finally {
      setProviderBusyId("");
    }
  }

  const activeTabMeta = TABS.find((t) => t.id === tab) || TABS[0];
  const configuredCount = mergedProviders.filter((p) => p.configured).length;
  const oauthCount = mergedProviders.filter((p) => p.methods.includes("oauth") || p.authType === "oauth").length;
  const customCount = mergedProviders.filter((p) => Boolean(p.custom)).length;

  const hasFolderOverride = Boolean(
    folderDefaults?.folder &&
      (folderDefaults.folder.provider_id ||
        folderDefaults.folder.model_id ||
        folderDefaults.folder.reasoning_effort),
  );
  const folderName = workspace
    ? String(workspace).replace(/\\/g, "/").split("/").filter(Boolean).pop() || workspace
    : "";

  return (
    <Dialog open={open} onClose={onClose} title="Settings" className="settings-dialog" size="lg">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="settings-nav-item"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={15} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-main">
          <header className="settings-content-head">
            <div>
              <h3 className="settings-section-title">{activeTabMeta.title}</h3>
              <p className="settings-section-desc">{activeTabMeta.desc}</p>
            </div>
          </header>

          <div className="settings-content">
            {tab === "general" && (
              <form id="web-settings-general-form" className="settings-stack" onSubmit={handleSaveGeneral}>
                {generalStatus.text && (
                  <p
                    className={
                      generalStatus.tone === "error"
                        ? "settings-inline-error"
                        : "settings-inline-note"
                    }
                    role={generalStatus.tone === "error" ? "alert" : "status"}
                  >
                    {generalStatus.text}
                  </p>
                )}

                <div className="settings-group-card">
                  <div className="settings-group-head">
                    <span className="settings-group-title">Global Runtime Defaults</span>
                    <span className="settings-group-badge">~/.rind/settings.json</span>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-text">
                      <label htmlFor="web-settings-provider" className="settings-row-label">
                        Default provider
                      </label>
                      <span className="settings-row-desc">
                        Primary model provider for new sessions across all workspaces.
                      </span>
                    </div>
                    <div className="settings-row-control">
                      <select
                        id="web-settings-provider"
                        aria-label="Default provider"
                        value={generalProvider}
                        onChange={(e) => setGeneralProvider(e.target.value)}
                      >
                        {sortedForSelect.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.id})
                            {p.configured
                              ? p.authType === "oauth"
                                ? " · OAuth Subscription"
                                : " · Connected"
                              : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-text">
                      <label htmlFor="web-settings-model" className="settings-row-label">
                        Default model
                      </label>
                      <span className="settings-row-desc">
                        Model identifier used by default for the selected provider.
                      </span>
                    </div>
                    <div className="settings-row-control">
                      <input
                        id="web-settings-model"
                        aria-label="Default model"
                        type="text"
                        list="web-settings-model-datalist"
                        value={generalModel}
                        onChange={(e) => setGeneralModel(e.target.value)}
                        placeholder="e.g. deepseek-flash, gpt-5"
                        autoComplete="off"
                      />
                      <datalist id="web-settings-model-datalist">
                        {modelSuggestions.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-text">
                      <label htmlFor="web-settings-effort" className="settings-row-label">
                        Reasoning effort
                      </label>
                      <span className="settings-row-desc">
                        Default thinking budget for reasoning-capable models.
                      </span>
                    </div>
                    <div className="settings-row-control">
                      <select
                        id="web-settings-effort"
                        aria-label="Reasoning effort"
                        value={generalEffort}
                        onChange={(e) => setGeneralEffort(e.target.value)}
                      >
                        <option value="">Provider default</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="xhigh">Extra high (xhigh)</option>
                        <option value="max">Maximum (max)</option>
                      </select>
                    </div>
                  </div>

                  <div className="settings-row">
                    <div className="settings-row-text">
                      <label htmlFor="web-settings-apikey" className="settings-row-label">
                        Provider credentials
                      </label>
                      <span className="settings-row-desc">
                        <span
                          className="status-dot"
                          data-configured={Boolean(selectedProviderObj?.configured)}
                          aria-hidden="true"
                        />
                        <span>
                          {selectedProviderObj
                            ? `${selectedProviderObj.name}: ${formatProviderStatus(selectedProviderObj)}`
                            : "Select a provider"}
                        </span>
                      </span>
                    </div>
                    <div className="settings-row-control settings-row-control-stack">
                      <input
                        id="web-settings-apikey"
                        type="password"
                        value={generalApiKey}
                        onChange={(e) => setGeneralApiKey(e.target.value)}
                        placeholder="Optional API key for selected provider"
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        className="ghost-button settings-link-btn"
                        onClick={() => setTab("providers")}
                      >
                        Manage subscriptions &amp; keys →
                      </button>
                    </div>
                  </div>
                </div>

                {workspace && (
                  <div className="settings-group-card">
                    <div className="settings-group-head">
                      <span className="settings-group-title">
                        Workspace Override · {folderName}
                      </span>
                      <span className="settings-group-badge">
                        {hasFolderOverride ? "Custom override" : "Inherited"}
                      </span>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <span className="settings-row-label">
                          {hasFolderOverride
                            ? [
                                folderDefaults.folder.provider_id,
                                folderDefaults.folder.model_id,
                                folderDefaults.folder.reasoning_effort
                                  ? `effort: ${folderDefaults.folder.reasoning_effort}`
                                  : "",
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : "Inheriting global defaults from ~/.rind/settings.json"}
                        </span>
                        <span className="settings-row-desc">{workspace}</span>
                      </div>
                      <div className="settings-row-control provider-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={folderBusy}
                          onClick={() => void handleWorkspaceDefaultAction("pin")}
                        >
                          Pin to workspace
                        </button>
                        {hasFolderOverride && (
                          <button
                            type="button"
                            className="ghost-button"
                            disabled={folderBusy}
                            onClick={() => void handleWorkspaceDefaultAction("reset")}
                          >
                            Reset to global
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </form>
            )}

            {tab === "providers" && (
              <div className="settings-stack">
                <div className="providers-toolbar">
                  <div className="providers-search-row">
                    <input
                      type="search"
                      aria-label="Search providers"
                      value={providerSearch}
                      onChange={(e) => setProviderSearch(e.target.value)}
                      placeholder="Search providers by name, ID, or env var..."
                    />
                    <button
                      type="button"
                      className="secondary-button providers-add-btn"
                      onClick={() => {
                        setCustomFormOpen(true);
                        setCustomDraft(EMPTY_CUSTOM_DRAFT);
                      }}
                    >
                      <Plus size={14} aria-hidden="true" />
                      <span>Custom provider</span>
                    </button>
                  </div>
                  <div className="providers-filter-pills" role="tablist" aria-label="Filter providers">
                    <button
                      type="button"
                      className={`provider-filter-pill${providerFilter === "all" ? " is-active" : ""}`}
                      onClick={() => setProviderFilter("all")}
                    >
                      All ({mergedProviders.length})
                    </button>
                    <button
                      type="button"
                      className={`provider-filter-pill${providerFilter === "configured" ? " is-active" : ""}`}
                      onClick={() => setProviderFilter("configured")}
                    >
                      Connected ({configuredCount})
                    </button>
                    <button
                      type="button"
                      className={`provider-filter-pill${providerFilter === "oauth" ? " is-active" : ""}`}
                      onClick={() => setProviderFilter("oauth")}
                    >
                      Subscription ({oauthCount})
                    </button>
                    <button
                      type="button"
                      className={`provider-filter-pill${providerFilter === "custom" ? " is-active" : ""}`}
                      onClick={() => setProviderFilter("custom")}
                    >
                      Custom ({customCount})
                    </button>
                  </div>
                </div>

                {customFormOpen && (
                  <form className="provider-custom-card" onSubmit={handleSaveCustomProvider}>
                    <div className="provider-custom-head">
                      <div>
                        <h4>
                          {customDraft.id
                            ? `Edit provider "${customDraft.name || customDraft.id}"`
                            : "Add custom provider"}
                        </h4>
                        <p className="muted">
                          Saved to ~/.rind/providers.json and ~/.rind/auth.json.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setCustomFormOpen(false);
                          setCustomDraft(EMPTY_CUSTOM_DRAFT);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    <div className="provider-custom-grid">
                      <label>
                        <span>Connection name</span>
                        <input
                          type="text"
                          value={customDraft.name}
                          onChange={(e) =>
                            setCustomDraft((d) => ({ ...d, name: e.target.value }))
                          }
                          placeholder="e.g. Xiaomi, Ollama, vLLM"
                          required
                        />
                      </label>
                      <label>
                        <span>API protocol</span>
                        <select
                          value={customDraft.api}
                          onChange={(e) =>
                            setCustomDraft((d) => ({ ...d, api: e.target.value }))
                          }
                        >
                          <option value="openai-chat">openai-chat · OpenAI Chat Completions</option>
                          <option value="openai-responses">openai-responses · OpenAI Responses</option>
                          <option value="anthropic-messages">anthropic-messages · Anthropic Messages</option>
                          <option value="google-generative-ai">google-generative-ai · Google Generative AI</option>
                        </select>
                      </label>
                      <label className="provider-custom-span-2">
                        <span>Base URL</span>
                        <input
                          type="url"
                          value={customDraft.baseUrl}
                          onChange={(e) =>
                            setCustomDraft((d) => ({ ...d, baseUrl: e.target.value }))
                          }
                          placeholder="https://api.example.com/v1"
                          required
                        />
                      </label>
                      <label>
                        <span>Default model ID (optional)</span>
                        <input
                          type="text"
                          value={customDraft.defaultModel}
                          onChange={(e) =>
                            setCustomDraft((d) => ({ ...d, defaultModel: e.target.value }))
                          }
                          placeholder="e.g. mimo-v2-flash"
                        />
                      </label>
                      <label>
                        <span>API key (optional for local endpoints)</span>
                        <input
                          type="password"
                          value={customDraft.apiKey}
                          onChange={(e) =>
                            setCustomDraft((d) => ({ ...d, apiKey: e.target.value }))
                          }
                          placeholder="sk-..."
                          autoComplete="new-password"
                        />
                      </label>
                    </div>
                    <div className="provider-custom-actions">
                      <button type="submit" className="primary-button">
                        {customDraft.id ? "Update provider" : "Save provider"}
                      </button>
                    </div>
                  </form>
                )}

                {providerNotice.text && (
                  <p
                    className={
                      providerNotice.tone === "error"
                        ? "settings-inline-error"
                        : "settings-inline-note"
                    }
                    role={providerNotice.tone === "error" ? "alert" : "status"}
                  >
                    {providerNotice.text}
                  </p>
                )}

                <div className="provider-rows-wrap">
                  {filteredProviders.map((provider) => {
                    const isDefault = (localSettings.provider || "openai") === provider.id;
                    const isEditing = editingKeyId === provider.id;
                    const busy = providerBusyId === provider.id;
                    const supportsOauth = provider.methods.includes("oauth");

                    return (
                      <div
                        key={provider.id}
                        className={`settings-row provider-row${provider.configured ? " is-configured" : ""}`}
                      >
                        <div className="provider-row-main">
                          <div className="settings-row-text">
                            <div className="provider-title-line">
                              <span className="settings-row-label">{provider.name}</span>
                              <span className="provider-id-chip">{provider.id}</span>
                              {isDefault && (
                                <span className="provider-badge provider-badge-default">
                                  Default
                                </span>
                              )}
                              {provider.authType === "oauth" && (
                                <span className="provider-badge provider-badge-oauth">
                                  Subscription · OAuth
                                </span>
                              )}
                              {provider.authType === "api_key" && (
                                <span className="provider-badge provider-badge-key">
                                  API Key
                                </span>
                              )}
                              {provider.authType === "env" && (
                                <span className="provider-badge provider-badge-env">
                                  Env
                                </span>
                              )}
                              {provider.custom && (
                                <span className="provider-badge provider-badge-custom">
                                  {provider.custom.api}
                                </span>
                              )}
                            </div>
                            <span className="settings-row-desc">
                              <span
                                className="status-dot"
                                data-configured={provider.configured}
                                aria-hidden="true"
                              />
                              <span>{formatProviderStatus(provider)}</span>
                              {provider.custom?.baseUrl && (
                                <span className="provider-endpoint-meta">
                                  {provider.custom.baseUrl}
                                </span>
                              )}
                              {supportsOauth && provider.authType !== "oauth" && (
                                <span className="provider-endpoint-meta">
                                  Supports OAuth Subscription &amp; API Key
                                </span>
                              )}
                            </span>
                          </div>

                          <div className="settings-row-control provider-actions">
                            <button
                              type="button"
                              className={
                                provider.configured && !isEditing
                                  ? "ghost-button"
                                  : "secondary-button"
                              }
                              disabled={busy}
                              onClick={() => {
                                if (isEditing) {
                                  setEditingKeyId("");
                                  setInlineKeyValue("");
                                } else {
                                  setEditingKeyId(provider.id);
                                  setInlineKeyValue("");
                                }
                              }}
                            >
                              {isEditing
                                ? "Cancel"
                                : provider.authType === "api_key"
                                  ? "Update key"
                                  : "API key"}
                            </button>

                            {provider.custom && (
                              <>
                                <button
                                  type="button"
                                  className="ghost-button"
                                  disabled={busy}
                                  onClick={() => {
                                    setCustomFormOpen(true);
                                    setCustomDraft({
                                      id: provider.custom.id,
                                      name: provider.custom.name,
                                      api: provider.custom.api,
                                      baseUrl: provider.custom.baseUrl,
                                      defaultModel: provider.custom.models?.[0] || "",
                                      apiKey: "",
                                      envKey: provider.custom.envKey || "",
                                    });
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button danger-text-btn"
                                  disabled={busy}
                                  onClick={() => void handleDeleteCustomProvider(provider.id)}
                                >
                                  Delete
                                </button>
                              </>
                            )}

                            {!provider.custom &&
                              provider.configured &&
                              provider.source !== "env" && (
                                <button
                                  type="button"
                                  className="ghost-button"
                                  disabled={busy}
                                  onClick={() => void handleLogoutProvider(provider.id)}
                                >
                                  {busy ? "Removing..." : "Sign out"}
                                </button>
                              )}
                          </div>
                        </div>

                        {isEditing && (
                          <div className="provider-key-editor">
                            <input
                              type="password"
                              aria-label={`${provider.name} API key`}
                              value={inlineKeyValue}
                              onChange={(e) => setInlineKeyValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  void handleSaveInlineKey(provider.id);
                                }
                              }}
                              placeholder={`Paste ${provider.name} API key...`}
                              autoComplete="new-password"
                              autoFocus
                            />
                            <button
                              type="button"
                              className="primary-button"
                              disabled={busy}
                              onClick={() => void handleSaveInlineKey(provider.id)}
                            >
                              Save key
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {filteredProviders.length === 0 && (
                    <p className="muted provider-empty">
                      No providers match the current filter.
                    </p>
                  )}
                </div>
              </div>
            )}

            {tab === "preferences" && (
              <div className="settings-stack">
                <div className="settings-group-card">
                  <div className="settings-group-head">
                    <span className="settings-group-title">Appearance &amp; Notifications</span>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-text">
                      <span className="settings-row-label">Color theme</span>
                      <span className="settings-row-desc">
                        Follow system appearance or lock to light/dark mode.
                      </span>
                    </div>
                    <div className="settings-row-control">
                      <div className="theme-segmented" role="radiogroup" aria-label="Color theme">
                        {THEMES.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            role="radio"
                            aria-checked={theme === option.id}
                            className="theme-segment"
                            onClick={() => onTheme?.(option.id)}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {onEnableNotifications && (
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <span className="settings-row-label">Browser notifications</span>
                        <span className="settings-row-desc">
                          Notify when a turn completes while the browser tab is in the background.
                        </span>
                      </div>
                      <div className="settings-row-control">
                        {notificationPermission === "granted" ? (
                          <span className="provider-badge provider-badge-oauth">Enabled</span>
                        ) : (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void onEnableNotifications()}
                          >
                            Enable notifications
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <div className="settings-group-card">
                  <div className="settings-group-head">
                    <span className="settings-group-title">Keyboard Shortcuts</span>
                  </div>
                  <ul className="shortcut-list">
                    {SHORTCUTS.map((row) => (
                      <li key={row.label} className="shortcut-row">
                        <span>{row.label}</span>
                        <span className="shortcut-keys">
                          {row.keys.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="settings-group-card">
                  <div className="settings-group-head">
                    <span className="settings-group-title">Device Session</span>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-text">
                      <span className="settings-row-label">Runtime connection</span>
                      <span className="settings-row-desc">
                        Connection is managed automatically. Sign out to clear the saved access code on this device.
                      </span>
                    </div>
                    <div className="settings-row-control">
                      <button type="button" className="danger-button" onClick={onLogout}>
                        <LogOut size={14} aria-hidden="true" />
                        <span>Sign out of this device</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab === "account" && (
              <div className="settings-stack">
                <div className="settings-group-card">
                  <div className="settings-group-head">
                    <span className="settings-group-title">Device Session</span>
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-text">
                      <span className="settings-row-label">Runtime connection</span>
                      <span className="settings-row-desc">
                        Connection is managed automatically. Sign out to clear the saved access code on this device.
                      </span>
                    </div>
                    <div className="settings-row-control">
                      <button type="button" className="danger-button" onClick={onLogout}>
                        <LogOut size={14} aria-hidden="true" />
                        <span>Sign out of this device</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="settings-footer-bar">
            <button type="button" className="ghost-button" onClick={onClose}>
              Close
            </button>
            {tab === "general" && (
              <button
                type="submit"
                form="web-settings-general-form"
                className="primary-button"
                disabled={savingGeneral}
              >
                {savingGeneral ? "Saving..." : "Save changes"}
              </button>
            )}
          </footer>
        </div>
      </div>
    </Dialog>
  );
}
