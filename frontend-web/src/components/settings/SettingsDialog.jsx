import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, KeyRound, LogOut, SlidersHorizontal } from "lucide-react";
import { Dialog } from "../overlays/Dialog.jsx";
import { methods } from "../../methods.js";

export const BUILTIN_PROVIDER_CATALOG = [
  {
    id: "openai",
    name: "OpenAI",
    api: "openai-responses",
    methods: ["api_key", "oauth"],
    envKey: "OPENAI_API_KEY",
    models: [
      { id: "gpt-5.5", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.4-mini", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-4o-mini", efforts: [] },
      { id: "gpt-4.1", efforts: [] },
      { id: "gpt-4o", efforts: [] },
      { id: "o3", efforts: ["low", "medium", "high"] },
      { id: "o4-mini", efforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "DEEPSEEK_API_KEY",
    models: [
      { id: "deepseek-flash", efforts: ["low", "high", "max"] },
      { id: "deepseek-v4-pro", efforts: ["low", "high", "max"] },
      { id: "deepseek-v4-flash", efforts: ["low", "high", "max"] },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    api: "anthropic-messages",
    methods: ["api_key"],
    envKey: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-sonnet-5-5", efforts: [] },
      { id: "claude-opus-5-5", efforts: [] },
      { id: "claude-sonnet-4-6", efforts: [] },
      { id: "claude-opus-4-6", efforts: [] },
      { id: "claude-haiku-4-5", efforts: [] },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    api: "google-generative-ai",
    methods: ["api_key"],
    envKey: "GEMINI_API_KEY",
    models: [
      { id: "gemini-3.5-flash", efforts: [] },
      { id: "gemini-3.1-pro-preview", efforts: [] },
      { id: "gemini-2.5-pro", efforts: [] },
      { id: "gemini-2.5-flash", efforts: [] },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "OPENROUTER_API_KEY",
    models: [
      { id: "openai/gpt-5.5", efforts: [] },
      { id: "anthropic/claude-sonnet-4.6", efforts: [] },
      { id: "deepseek/deepseek-v4.1-flash", efforts: [] },
    ],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    api: "openai-responses",
    methods: ["api_key"],
    envKey: "XAI_API_KEY",
    models: [
      { id: "grok-4.7", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "grok-4.6", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "grok-4.5", efforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "qwen",
    name: "Qwen (DashScope)",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "DASHSCOPE_API_KEY",
    models: [
      { id: "qwen3-coder-plus", efforts: [] },
      { id: "qwen3.8-max", efforts: ["low", "medium", "xhigh"] },
      { id: "qwen3.8-flash", efforts: ["low", "medium", "xhigh"] },
      { id: "qwen-max", efforts: [] },
    ],
  },
  {
    id: "kimi-coding",
    name: "Kimi for Coding",
    api: "anthropic-messages",
    methods: ["api_key"],
    envKey: "KIMI_API_KEY",
    models: [
      { id: "kimi-for-coding", efforts: [] },
      { id: "k3", efforts: [] },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot AI",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "MOONSHOT_API_KEY",
    models: [
      { id: "kimi-k3", efforts: ["low", "high", "max"] },
      { id: "kimi-k2.7-code", efforts: [] },
      { id: "kimi-k2.6", efforts: [] },
    ],
  },
  {
    id: "zai",
    name: "Z.AI",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "ZAI_API_KEY",
    models: [
      { id: "glm-5.3", efforts: ["low", "high", "max"] },
      { id: "glm-5.3-flash", efforts: ["low", "high", "max"] },
      { id: "glm-4.7", efforts: [] },
    ],
  },
  {
    id: "zhipu",
    name: "Zhipu AI (GLM)",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "ZHIPU_API_KEY",
    models: [
      { id: "glm-5.3", efforts: ["low", "high", "max"] },
      { id: "glm-5.3-flash", efforts: ["low", "high", "max"] },
      { id: "glm-4.7", efforts: [] },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    api: "anthropic-messages",
    methods: ["api_key"],
    envKey: "MINIMAX_API_KEY",
    models: [{ id: "MiniMax-M3", efforts: [] }],
  },
  {
    id: "volcengine",
    name: "Volcengine (Ark)",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "ARK_API_KEY",
    models: [{ id: "doubao-seed-2-1-pro-260628", efforts: [] }],
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "MIMO_API_KEY",
    models: [
      { id: "mimo-v2.6-pro", efforts: [] },
      { id: "mimo-v2.6-flash", efforts: [] },
    ],
  },
  {
    id: "hunyuan",
    name: "Tencent Hunyuan",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "HUNYUAN_API_KEY",
    models: [{ id: "hunyuan-turbos-latest", efforts: [] }],
  },
  {
    id: "groq",
    name: "Groq",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "GROQ_API_KEY",
    models: [
      { id: "llama-3.3-70b-versatile", efforts: [] },
      { id: "openai/gpt-oss-120b", efforts: ["low", "medium", "high"] },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "MISTRAL_API_KEY",
    models: [
      { id: "mistral-large-latest", efforts: [] },
      { id: "codestral-latest", efforts: [] },
    ],
  },
  {
    id: "longcat",
    name: "LongCat",
    api: "openai-chat",
    methods: ["api_key"],
    envKey: "LONGCAT_API_KEY",
    models: [
      { id: "LongCat-2.5-Preview", efforts: [] },
      { id: "LongCat-2.0", efforts: [] },
    ],
  },
];

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

const TABS = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontal,
    title: "General",
    desc: "Default provider and model for new conversations (~/.rind/settings.json).",
  },
  {
    id: "providers",
    label: "Providers",
    icon: KeyRound,
    title: "Providers",
    desc: "Manage custom API endpoints (~/.rind/providers.json) and built-in provider credentials (~/.rind/auth.json).",
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
  if (!provider.configured) return "Not connected";
  if (provider.authType === "oauth") return "Subscription · OAuth";
  if (provider.authType === "api_key") {
    return provider.maskedKey ? `API key · ${provider.maskedKey}` : "API key connected";
  }
  if (provider.source === "env") {
    return provider.envKey ? `Environment (${provider.envKey})` : "Environment variable";
  }
  if (provider.custom) {
    return provider.maskedKey ? `API key · ${provider.maskedKey}` : "Custom endpoint";
  }
  return "Connected";
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
  const [savingGeneral, setSavingGeneral] = useState(false);
  const [generalStatus, setGeneralStatus] = useState({ tone: "", text: "" });

  const [providerSearch, setProviderSearch] = useState("");
  const [openMenuId, setOpenMenuId] = useState("");
  const [editingKeyId, setEditingKeyId] = useState("");
  const [inlineKeyValue, setInlineKeyValue] = useState("");
  const [providerBusyId, setProviderBusyId] = useState("");
  const [providerNotice, setProviderNotice] = useState({ tone: "", text: "" });
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState(EMPTY_CUSTOM_DRAFT);

  const loadAllSettings = useCallback(
    async (isCancelled = () => false) => {
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
          if (fd && typeof fd === "object" && fd.resolved) {
            globalResolved = fd.resolved;
          }
        } catch {
          // Ignore if runtime is not connected
        }
        try {
          const authRes = await request(methods.authList, {});
          if (!isCancelled() && Array.isArray(authRes?.providers)) {
            setRuntimeProviders(authRes.providers);
          }
        } catch {
          // Ignore
        }
      }

      if (isCancelled()) return;

      const nextProvider =
        fetchedLocal?.provider ||
        globalResolved?.provider_id ||
        globalResolved?.provider ||
        info?.provider ||
        "openai";
      const nextModel =
        fetchedLocal?.model ||
        globalResolved?.model_id ||
        globalResolved?.model ||
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
    },
    [request, workspace, info?.provider, info?.model, info?.reasoning_effort],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setGeneralStatus({ tone: "", text: "" });
    setProviderNotice({ tone: "", text: "" });
    setOpenMenuId("");
    void loadAllSettings(() => cancelled);
    return () => {
      cancelled = true;
    };
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
          configured: true,
          source: authDetails[custom.id] ? "auth.json" : "providers.json",
          envKey: custom.envKey || "",
        });
        seen.add(custom.id);
      }
    }

    return baseList.map((p) => {
      const detail = authDetails[p.id];
      const custom = customMap.get(p.id);
      const configured = Boolean(p.configured || detail || custom);
      const authType =
        detail?.type === "oauth"
          ? "oauth"
          : detail?.type === "api_key"
            ? "api_key"
            : p.source === "env"
              ? "env"
              : custom
                ? "custom"
                : configured
                  ? "api_key"
                  : "";
      return {
        ...p,
        name: custom?.name || p.name || p.id,
        configured,
        source: detail ? "auth.json" : p.source || (custom ? "providers.json" : ""),
        custom,
        authType,
        maskedKey: detail?.maskedKey || "",
      };
    });
  }, [localSettings.authDetails, localSettings.customProviders, runtimeProviders]);

  const configuredProviders = useMemo(() => {
    return mergedProviders
      .filter((p) => p.configured)
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }, [mergedProviders]);

  const getModelsForProvider = useCallback(
    (providerId, extraModel = "") => {
      const set = new Set();
      const runtimeModels = Array.isArray(info?.models) ? info.models : [];
      for (const m of runtimeModels) {
        if ((m.providerId || m.provider_id) === providerId && m.id) {
          set.add(m.id);
        }
      }
      const custom = (localSettings.customProviders || []).find((c) => c.id === providerId);
      if (custom && Array.isArray(custom.models)) {
        for (const m of custom.models) {
          if (m) set.add(m);
        }
      }
      const builtin = BUILTIN_PROVIDER_CATALOG.find((b) => b.id === providerId);
      if (builtin) {
        for (const m of builtin.models) {
          set.add(m.id);
        }
      }
      if (extraModel) set.add(extraModel);
      return [...set];
    },
    [info?.models, localSettings.customProviders],
  );

  const providerModels = useMemo(() => {
    return getModelsForProvider(generalProvider, generalModel);
  }, [getModelsForProvider, generalProvider, generalModel]);

  const supportedEfforts = useMemo(() => {
    const runtimeModels = Array.isArray(info?.models) ? info.models : [];
    const runtimeMatch = runtimeModels.find(
      (m) => (m.providerId || m.provider_id) === generalProvider && m.id === generalModel,
    );
    if (runtimeMatch && Array.isArray(runtimeMatch.reasoningEfforts || runtimeMatch.reasoning_efforts)) {
      return runtimeMatch.reasoningEfforts || runtimeMatch.reasoning_efforts;
    }
    const builtin = BUILTIN_PROVIDER_CATALOG.find((b) => b.id === generalProvider);
    const builtinModel = builtin?.models.find((m) => m.id === generalModel);
    if (builtinModel) {
      return builtinModel.efforts;
    }
    const custom = (localSettings.customProviders || []).find((c) => c.id === generalProvider);
    const api = custom?.api || builtin?.api || "openai-chat";
    if (api === "anthropic-messages" || api === "google-generative-ai") {
      return [];
    }
    return ALL_EFFORTS;
  }, [info?.models, generalProvider, generalModel, localSettings.customProviders]);

  const customProvidersList = useMemo(() => {
    return mergedProviders.filter((p) => Boolean(p.custom));
  }, [mergedProviders]);

  const builtinProvidersList = useMemo(() => {
    const q = providerSearch.trim().toLowerCase();
    return mergedProviders
      .filter((p) => !p.custom)
      .filter((p) => {
        if (!q) return true;
        return (
          p.id.toLowerCase().includes(q) ||
          (p.name || "").toLowerCase().includes(q) ||
          (p.envKey || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const aDef = (localSettings.provider || "openai") === a.id ? 1 : 0;
        const bDef = (localSettings.provider || "openai") === b.id ? 1 : 0;
        if (aDef !== bDef) return bDef - aDef;
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        return (a.name || a.id).localeCompare(b.name || b.id);
      });
  }, [mergedProviders, providerSearch, localSettings.provider]);

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
    const reasoningEffort = supportedEfforts.length > 0 ? generalEffort.trim() : "";

    setSavingGeneral(true);
    setGeneralStatus({ tone: "", text: "" });
    try {
      await postLocalSettings({
        provider,
        model,
        reasoningEffort,
      }).catch(() => null);

      if (typeof request === "function") {
        await request(methods.folderDefaultsSet, {
          scope: "global",
          provider_id: provider,
          model_id: model,
          reasoning_effort: reasoningEffort,
        }).catch(() => null);
      }

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
      setOpenMenuId("");
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
    setOpenMenuId("");
    setProviderNotice({ tone: "", text: "" });
    try {
      await postLocalSettings({ removeProviderCredentialId: providerId });
      await loadAllSettings();
      onSettingsChanged?.();
      setProviderNotice({ tone: "success", text: `Disconnected ${providerId}.` });
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
      setProviderNotice({ tone: "error", text: "Name and Base URL are required." });
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
      setOpenMenuId("");
      await loadAllSettings();
      onSettingsChanged?.();
      setProviderNotice({ tone: "success", text: `Saved custom API "${name}".` });
    } catch (error) {
      setProviderNotice({ tone: "error", text: error?.message || String(error) });
    } finally {
      setProviderBusyId("");
    }
  }

  async function handleDeleteCustomProvider(providerId) {
    setProviderBusyId(providerId);
    setOpenMenuId("");
    setProviderNotice({ tone: "", text: "" });
    try {
      await postLocalSettings({ deleteCustomProviderId: providerId });
      await loadAllSettings();
      onSettingsChanged?.();
      setProviderNotice({ tone: "success", text: `Removed custom API "${providerId}".` });
    } catch (error) {
      setProviderNotice({ tone: "error", text: error?.message || String(error) });
    } finally {
      setProviderBusyId("");
    }
  }

  function renderProviderRow(provider) {
    const isDefault = (localSettings.provider || "openai") === provider.id;
    const isEditing = editingKeyId === provider.id;
    const isMenuOpen = openMenuId === provider.id;
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
              {isDefault && (
                <span className="provider-badge provider-badge-default">Default</span>
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
                <span className="provider-endpoint-meta">{provider.custom.baseUrl}</span>
              )}
            </span>
          </div>

          <div className="settings-row-control provider-actions">
            {isEditing ? (
              <button
                type="button"
                className="ghost-button"
                disabled={busy}
                onClick={() => {
                  setEditingKeyId("");
                  setInlineKeyValue("");
                }}
              >
                Cancel
              </button>
            ) : !provider.custom && !provider.configured && !supportsOauth ? (
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setEditingKeyId(provider.id);
                  setInlineKeyValue("");
                  setOpenMenuId("");
                }}
              >
                Connect
              </button>
            ) : (
              <div className="provider-menu-wrap">
                <button
                  type="button"
                  className={`${provider.configured || provider.custom ? "ghost-button" : "secondary-button"} provider-menu-trigger`}
                  aria-expanded={isMenuOpen}
                  disabled={busy}
                  onClick={() => setOpenMenuId(isMenuOpen ? "" : provider.id)}
                >
                  {busy
                    ? "Working..."
                    : provider.configured || provider.custom
                      ? "Manage ▾"
                      : "Connect ▾"}
                </button>
                {isMenuOpen && (
                  <div className="provider-action-menu" role="menu">
                    {provider.custom ? (
                      <>
                        <button
                          type="button"
                          className="provider-menu-item"
                          onClick={() => {
                            setOpenMenuId("");
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
                          Edit endpoint
                        </button>
                        <button
                          type="button"
                          className="provider-menu-item"
                          onClick={() => {
                            setOpenMenuId("");
                            setEditingKeyId(provider.id);
                            setInlineKeyValue("");
                          }}
                        >
                          {provider.maskedKey ? "Update API key" : "Set API key"}
                        </button>
                        <button
                          type="button"
                          className="provider-menu-item is-danger"
                          onClick={() => void handleDeleteCustomProvider(provider.id)}
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="provider-menu-item"
                          onClick={() => {
                            setOpenMenuId("");
                            setEditingKeyId(provider.id);
                            setInlineKeyValue("");
                          }}
                        >
                          {provider.configured ? "Update API key" : "Enter API key"}
                        </button>
                        {provider.configured && provider.source !== "env" && (
                          <button
                            type="button"
                            className="provider-menu-item is-danger"
                            onClick={() => void handleLogoutProvider(provider.id)}
                          >
                            Disconnect
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
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
              Save
            </button>
          </div>
        )}
      </div>
    );
  }

  const activeTabMeta = TABS.find((t) => t.id === tab) || TABS[0];

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
              onClick={() => {
                setTab(id);
                setOpenMenuId("");
              }}
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

          <div
            className="settings-content"
            onClick={(e) => {
              if (openMenuId && !e.target.closest?.(".provider-menu-wrap")) {
                setOpenMenuId("");
              }
            }}
          >
            {tab === "general" && (
              <form
                id="web-settings-general-form"
                className="settings-stack"
                onSubmit={handleSaveGeneral}
              >
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

                {configuredProviders.length === 0 ? (
                  <div className="settings-group-card settings-empty-card">
                    <div className="settings-row-text">
                      <span className="settings-row-label">No providers connected</span>
                      <span className="settings-row-desc">
                        Connect a provider or add a custom API in Providers to configure your defaults.
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setTab("providers")}
                    >
                      Configure providers
                    </button>
                  </div>
                ) : (
                  <div className="settings-group-card">
                    <div className="settings-row">
                      <div className="settings-row-text">
                        <label htmlFor="web-settings-provider" className="settings-row-label">
                          Default provider
                        </label>
                        <span className="settings-row-desc">
                          Connected provider used for new conversations.
                        </span>
                      </div>
                      <div className="settings-row-control">
                        <select
                          id="web-settings-provider"
                          aria-label="Default provider"
                          value={generalProvider}
                          onChange={(e) => {
                            const nextProvider = e.target.value;
                            setGeneralProvider(nextProvider);
                            const nextModels = getModelsForProvider(nextProvider);
                            if (nextModels.length > 0 && !nextModels.includes(generalModel)) {
                              setGeneralModel(nextModels[0]);
                            }
                          }}
                        >
                          {configuredProviders.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
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
                          Default model for the selected provider.
                        </span>
                      </div>
                      <div className="settings-row-control">
                        <select
                          id="web-settings-model"
                          aria-label="Default model"
                          value={generalModel}
                          onChange={(e) => setGeneralModel(e.target.value)}
                        >
                          {providerModels.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {supportedEfforts.length > 0 && (
                      <div className="settings-row">
                        <div className="settings-row-text">
                          <label htmlFor="web-settings-effort" className="settings-row-label">
                            Reasoning effort
                          </label>
                          <span className="settings-row-desc">
                            Thinking budget for reasoning-capable models.
                          </span>
                        </div>
                        <div className="settings-row-control">
                          <select
                            id="web-settings-effort"
                            aria-label="Reasoning effort"
                            value={supportedEfforts.includes(generalEffort) ? generalEffort : ""}
                            onChange={(e) => setGeneralEffort(e.target.value)}
                          >
                            <option value="">Default</option>
                            {supportedEfforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {EFFORT_LABELS[effort] || effort}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </form>
            )}

            {tab === "providers" && (
              <div className="settings-stack">
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

                <div className="settings-group-card">
                  <div className="settings-group-head">
                    <span className="settings-group-title">Custom APIs</span>
                    <button
                      type="button"
                      className="secondary-button providers-add-btn"
                      onClick={() => {
                        setCustomFormOpen(true);
                        setCustomDraft(EMPTY_CUSTOM_DRAFT);
                        setOpenMenuId("");
                      }}
                    >
                      + Add API
                    </button>
                  </div>

                  {customFormOpen && (
                    <form className="provider-custom-card" onSubmit={handleSaveCustomProvider}>
                      <div className="provider-custom-head">
                        <div>
                          <h4>
                            {customDraft.id
                              ? `Edit "${customDraft.name || customDraft.id}"`
                              : "New custom API"}
                          </h4>
                          <p className="muted">Saved to ~/.rind/providers.json</p>
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
                          <span>Name</span>
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
                          <span>Protocol</span>
                          <select
                            value={customDraft.api}
                            onChange={(e) =>
                              setCustomDraft((d) => ({ ...d, api: e.target.value }))
                            }
                          >
                            <option value="openai-chat">OpenAI Chat Completions</option>
                            <option value="openai-responses">OpenAI Responses</option>
                            <option value="anthropic-messages">Anthropic Messages</option>
                            <option value="google-generative-ai">Google Generative AI</option>
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
                          <span>Default model</span>
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
                          <span>API key (optional)</span>
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
                          {customDraft.id ? "Update" : "Save"}
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="provider-section-rows">
                    {customProvidersList.map(renderProviderRow)}
                    {customProvidersList.length === 0 && !customFormOpen && (
                      <p className="muted provider-empty">
                        No custom API endpoints configured.
                      </p>
                    )}
                  </div>
                </div>

                <div className="settings-group-card">
                  <div className="settings-group-head">
                    <span className="settings-group-title">Built-in Providers</span>
                    <input
                      type="search"
                      className="providers-compact-search"
                      aria-label="Search providers"
                      value={providerSearch}
                      onChange={(e) => setProviderSearch(e.target.value)}
                      placeholder="Search..."
                    />
                  </div>
                  <div className="provider-section-rows">
                    {builtinProvidersList.map(renderProviderRow)}
                    {builtinProvidersList.length === 0 && (
                      <p className="muted provider-empty">
                        No matching built-in providers.
                      </p>
                    )}
                  </div>
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
                          <span className="provider-badge provider-badge-default">Enabled</span>
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
            {tab === "general" && configuredProviders.length > 0 && (
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
