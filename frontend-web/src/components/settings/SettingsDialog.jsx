import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, ChevronDown, KeyRound, LogOut, SlidersHorizontal } from "lucide-react";
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
    desc: "Global default provider and model configuration (~/.rind/settings.json).",
  },
  {
    id: "providers",
    label: "Providers",
    icon: KeyRound,
    title: "Providers",
    desc: "Manage OAuth accounts, custom API endpoints (~/.rind/providers.json), and built-in provider keys (~/.rind/auth.json).",
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

function getProviderSourceLabel(provider) {
  if (provider?.custom || provider?.authType === "custom") return "Custom";
  if (provider?.authType === "oauth") return "OAuth";
  return "Built-in";
}

function formatProviderSectionStatus(provider, section) {
  if (section === "oauth") {
    return provider.authType === "oauth"
      ? "Subscription · OAuth"
      : "Account subscription (OAuth)";
  }
  if (section === "custom") {
    return provider.maskedKey ? `Custom · ${provider.maskedKey}` : "Custom endpoint";
  }
  if (provider.authType === "api_key") {
    return provider.maskedKey ? `API key · ${provider.maskedKey}` : "API key connected";
  }
  if (provider.source === "env") {
    return provider.envKey ? `Environment (${provider.envKey})` : "Environment variable";
  }
  if (provider.authType === "oauth") {
    return "API key not set (connected via OAuth)";
  }
  return "Not connected";
}

export function SettingsSelect({
  id,
  ariaLabel,
  value,
  disabled = false,
  mono = false,
  className = "",
  groups,
  options,
  isOpen,
  onToggle,
  onChange,
}) {
  const rootRef = useRef(null);
  const isControlled = typeof isOpen === "boolean" && typeof onToggle === "function";
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? isOpen : internalOpen;

  useEffect(() => {
    if (isControlled || !internalOpen) return undefined;
    const handlePointerDown = (e) => {
      if (!rootRef.current?.contains(e.target)) {
        setInternalOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setInternalOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isControlled, internalOpen]);

  const flatOptions = useMemo(() => {
    if (Array.isArray(groups)) {
      return groups.flatMap((g) => g.options || []);
    }
    return Array.isArray(options) ? options : [];
  }, [groups, options]);

  const selectedOption = flatOptions.find((o) => o.value === value) ||
    flatOptions[0] || {
      value,
      label: value || "Default",
    };

  const handleTriggerClick = (e) => {
    e.preventDefault();
    if (isControlled) onToggle();
    else setInternalOpen((prev) => !prev);
  };

  const handleOptionSelect = (e, nextVal) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isControlled) setInternalOpen(false);
    onChange(nextVal);
  };

  return (
    <div ref={rootRef} className={`settings-select${className ? ` ${className}` : ""}${open ? " is-open" : ""}`}>
      <button
        id={id}
        type="button"
        className="settings-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-value={value}
        disabled={disabled}
        onClick={handleTriggerClick}
      >
        <span className="settings-select-trigger-content">
          <span className={`settings-select-trigger-label${mono ? " is-mono" : ""}`}>
            {selectedOption.label}
          </span>
          {selectedOption.badge && (
            <span className="settings-select-badge">{selectedOption.badge}</span>
          )}
        </span>
        <ChevronDown size={14} className="settings-select-chevron" aria-hidden="true" />
      </button>

      {open && !disabled && (
        <div
          className="settings-select-menu panel-scroll"
          role="listbox"
          aria-label={ariaLabel ? `${ariaLabel} options` : "Options"}
        >
          {Array.isArray(groups)
            ? groups.map((group) => (
                <div
                  key={group.key}
                  className="settings-select-group"
                  role="group"
                  aria-label={group.label}
                >
                  <div className="settings-select-group-title">{group.label}</div>
                  {group.options.map((opt) => {
                    const selected = opt.value === value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-value={opt.value}
                        className={`settings-select-option${selected ? " is-selected" : ""}`}
                        onClick={(e) => handleOptionSelect(e, opt.value)}
                      >
                        <span className="settings-select-option-content">
                          <span
                            className={`settings-select-option-label${mono ? " is-mono" : ""}`}
                          >
                            {opt.label}
                          </span>
                          {opt.badge && (
                            <span className="settings-select-badge">{opt.badge}</span>
                          )}
                        </span>
                        <span className="settings-select-check" aria-hidden="true">
                          {selected ? <Check size={13} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            : flatOptions.map((opt) => {
                const selected = opt.value === value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-value={opt.value}
                    className={`settings-select-option${selected ? " is-selected" : ""}`}
                    onClick={(e) => handleOptionSelect(e, opt.value)}
                  >
                    <span className="settings-select-option-content">
                      <span
                        className={`settings-select-option-label${mono ? " is-mono" : ""}`}
                      >
                        {opt.label}
                      </span>
                      {opt.badge && (
                        <span className="settings-select-badge">{opt.badge}</span>
                      )}
                    </span>
                    <span className="settings-select-check" aria-hidden="true">
                      {selected ? <Check size={13} /> : null}
                    </span>
                  </button>
                );
              })}
        </div>
      )}
    </div>
  );
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
  const [generalEditing, setGeneralEditing] = useState(false);
  const [openGeneralSelectId, setOpenGeneralSelectId] = useState("");
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
    setGeneralEditing(false);
    setOpenGeneralSelectId("");
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

  const configuredProviderGroups = useMemo(() => {
    const configured = mergedProviders.filter((p) => p.configured);
    const groupDefs = [
      { key: "OAuth", label: "OAuth & Accounts" },
      { key: "Custom", label: "Custom APIs" },
      { key: "Built-in", label: "Built-in Providers" },
    ];
    return groupDefs
      .map((group) => ({
        key: group.key,
        label: group.label,
        providers: configured
          .filter((p) => getProviderSourceLabel(p) === group.key)
          .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
      }))
      .filter((group) => group.providers.length > 0);
  }, [mergedProviders]);

  const configuredProviders = useMemo(() => {
    return configuredProviderGroups.flatMap((g) => g.providers);
  }, [configuredProviderGroups]);

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

  const oauthProvidersList = useMemo(() => {
    return mergedProviders.filter(
      (p) => !p.custom && (p.methods.includes("oauth") || p.authType === "oauth"),
    );
  }, [mergedProviders]);

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
        const aConfigured = a.configured && a.authType !== "oauth";
        const bConfigured = b.configured && b.authType !== "oauth";
        const aDef = (localSettings.provider || "openai") === a.id && aConfigured ? 1 : 0;
        const bDef = (localSettings.provider || "openai") === b.id && bConfigured ? 1 : 0;
        if (aDef !== bDef) return bDef - aDef;
        if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
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
    if (!generalEditing) return;
    const provider = generalProvider.trim() || "openai";
    const model = generalModel.trim() || "gpt-4o-mini";
    const reasoningEffort = supportedEfforts.length > 0 ? generalEffort.trim() : "";

    setSavingGeneral(true);
    setOpenGeneralSelectId("");
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
      setGeneralEditing(false);
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

  async function handleOauthLogin(providerId) {
    setProviderBusyId(providerId);
    setOpenMenuId("");
    setProviderNotice({ tone: "", text: "" });
    try {
      if (typeof request === "function") {
        await request(methods.authLogin, { provider: providerId, method: "oauth" });
        await loadAllSettings();
        onSettingsChanged?.();
        setProviderNotice({ tone: "success", text: `Connected ${providerId} via OAuth.` });
      } else {
        setProviderNotice({
          tone: "error",
          text: "Runtime connection required to start OAuth sign-in.",
        });
      }
    } catch (error) {
      setProviderNotice({ tone: "error", text: error?.message || String(error) });
    } finally {
      setProviderBusyId("");
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
      if (typeof request === "function") {
        await request(methods.authLogout, { provider: providerId }).catch(() => null);
      }
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

  function renderProviderRow(provider, section) {
    const isConfiguredInSection =
      section === "oauth"
        ? provider.authType === "oauth"
        : section === "custom"
          ? true
          : provider.configured && provider.authType !== "oauth";
    const isDefault = (localSettings.provider || "openai") === provider.id && isConfiguredInSection;
    const isEditing = section !== "oauth" && editingKeyId === provider.id;
    const menuKey = `${section}:${provider.id}`;
    const isMenuOpen = openMenuId === menuKey;
    const busy = providerBusyId === provider.id;

    return (
      <div
        key={menuKey}
        className={`settings-row provider-row${isConfiguredInSection ? " is-configured" : ""}`}
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
                data-configured={isConfiguredInSection}
                aria-hidden="true"
              />
              <span>{formatProviderSectionStatus(provider, section)}</span>
              {section === "custom" && provider.custom?.baseUrl && (
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
            ) : section === "oauth" ? (
              !isConfiguredInSection ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void handleOauthLogin(provider.id)}
                >
                  {busy ? "Working..." : "Connect"}
                </button>
              ) : (
                <div className="provider-menu-wrap">
                  <button
                    type="button"
                    className="ghost-button provider-menu-trigger"
                    aria-expanded={isMenuOpen}
                    disabled={busy}
                    onClick={() => setOpenMenuId(isMenuOpen ? "" : menuKey)}
                  >
                    {busy ? "Working..." : "Manage"}
                  </button>
                  {isMenuOpen && (
                    <div className="provider-action-menu" role="menu">
                      <button
                        type="button"
                        className="provider-menu-item"
                        onClick={() => void handleOauthLogin(provider.id)}
                      >
                        Reconnect OAuth
                      </button>
                      <button
                        type="button"
                        className="provider-menu-item is-danger"
                        onClick={() => void handleLogoutProvider(provider.id)}
                      >
                        Disconnect
                      </button>
                    </div>
                  )}
                </div>
              )
            ) : section === "builtin" && !isConfiguredInSection ? (
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
                {busy ? "Saving..." : "Connect"}
              </button>
            ) : (
              <div className="provider-menu-wrap">
                <button
                  type="button"
                  className="ghost-button provider-menu-trigger"
                  aria-expanded={isMenuOpen}
                  disabled={busy}
                  onClick={() => setOpenMenuId(isMenuOpen ? "" : menuKey)}
                >
                  {busy ? "Working..." : "Manage"}
                </button>
                {isMenuOpen && (
                  <div className="provider-action-menu" role="menu">
                    {section === "custom" ? (
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
                          Update API key
                        </button>
                        {provider.source !== "env" && (
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
        <nav className="settings-nav panel-scroll" aria-label="Settings sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className="settings-nav-item"
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                if (id !== "general") {
                  setGeneralEditing(false);
                }
                setOpenGeneralSelectId("");
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
            className="settings-content panel-scroll"
            onClick={(e) => {
              if (openMenuId && !e.target.closest?.(".provider-menu-wrap")) {
                setOpenMenuId("");
              }
              if (openGeneralSelectId && !e.target.closest?.(".settings-select")) {
                setOpenGeneralSelectId("");
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
                    <div className="settings-group-head">
                      <div className="settings-group-head-text">
                        <span className="settings-group-title">Global Default Configuration</span>
                        <span className="settings-group-badge">~/.rind/settings.json</span>
                      </div>
                      <button
                        type="button"
                        className={`${generalEditing ? "ghost-button" : "secondary-button"} settings-edit-btn`}
                        disabled={savingGeneral}
                        onClick={() => {
                          if (generalEditing) {
                            setGeneralEditing(false);
                            setOpenGeneralSelectId("");
                            setGeneralProvider(localSettings.provider || "openai");
                            setGeneralModel(localSettings.model || "gpt-4o-mini");
                            setGeneralEffort(localSettings.reasoningEffort || "");
                          } else {
                            setGeneralEditing(true);
                          }
                        }}
                      >
                        {generalEditing ? "Cancel" : "Edit"}
                      </button>
                    </div>
                    <p className="settings-group-desc">
                      Global defaults applied to new conversations across all workspaces. Click Edit to unlock changes, then Save changes to apply.
                    </p>

                    <div className="settings-row">
                      <div className="settings-row-text">
                        <span className="settings-row-label">Default provider</span>
                        <span className="settings-row-desc">
                          Connected provider (grouped by OAuth, Custom, or Built-in) used for new conversations.
                        </span>
                      </div>
                      <div className="settings-row-control">
                        <SettingsSelect
                          id="web-settings-provider"
                          ariaLabel="Default provider"
                          value={generalProvider}
                          disabled={!generalEditing || savingGeneral}
                          isOpen={openGeneralSelectId === "provider"}
                          onToggle={() =>
                            setOpenGeneralSelectId((prev) =>
                              prev === "provider" ? "" : "provider",
                            )
                          }
                          groups={configuredProviderGroups.map((group) => ({
                            key: group.key,
                            label: group.label,
                            options: group.providers.map((p) => ({
                              value: p.id,
                              label: p.name,
                              badge: group.key,
                            })),
                          }))}
                          onChange={(nextProvider) => {
                            setGeneralProvider(nextProvider);
                            const nextModels = getModelsForProvider(nextProvider);
                            if (nextModels.length > 0 && !nextModels.includes(generalModel)) {
                              setGeneralModel(nextModels[0]);
                            }
                            setOpenGeneralSelectId("");
                          }}
                        />
                      </div>
                    </div>

                    <div className="settings-row">
                      <div className="settings-row-text">
                        <span className="settings-row-label">Default model</span>
                        <span className="settings-row-desc">
                          Default model for the selected provider.
                        </span>
                      </div>
                      <div className="settings-row-control">
                        <SettingsSelect
                          id="web-settings-model"
                          ariaLabel="Default model"
                          value={generalModel}
                          mono
                          disabled={!generalEditing || savingGeneral}
                          isOpen={openGeneralSelectId === "model"}
                          onToggle={() =>
                            setOpenGeneralSelectId((prev) =>
                              prev === "model" ? "" : "model",
                            )
                          }
                          options={providerModels.map((m) => ({
                            value: m,
                            label: m,
                          }))}
                          onChange={(nextModel) => {
                            setGeneralModel(nextModel);
                            setOpenGeneralSelectId("");
                          }}
                        />
                      </div>
                    </div>

                    {supportedEfforts.length > 0 && (
                      <div className="settings-row">
                        <div className="settings-row-text">
                          <span className="settings-row-label">Reasoning effort</span>
                          <span className="settings-row-desc">
                            Thinking budget for reasoning-capable models.
                          </span>
                        </div>
                        <div className="settings-row-control">
                          <SettingsSelect
                            id="web-settings-effort"
                            ariaLabel="Reasoning effort"
                            value={supportedEfforts.includes(generalEffort) ? generalEffort : ""}
                            disabled={!generalEditing || savingGeneral}
                            isOpen={openGeneralSelectId === "effort"}
                            onToggle={() =>
                              setOpenGeneralSelectId((prev) =>
                                prev === "effort" ? "" : "effort",
                              )
                            }
                            options={[
                              { value: "", label: "Default" },
                              ...supportedEfforts.map((effort) => ({
                                value: effort,
                                label: EFFORT_LABELS[effort] || effort,
                              })),
                            ]}
                            onChange={(nextEffort) => {
                              setGeneralEffort(nextEffort);
                              setOpenGeneralSelectId("");
                            }}
                          />
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
                    <span className="settings-group-title">OAuth &amp; Accounts</span>
                    <span className="settings-group-badge">Subscription</span>
                  </div>
                  <div className="provider-section-rows">
                    {oauthProvidersList.map((p) => renderProviderRow(p, "oauth"))}
                    {oauthProvidersList.length === 0 && (
                      <p className="muted provider-empty">No OAuth providers available.</p>
                    )}
                  </div>
                </div>

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
                          <SettingsSelect
                            ariaLabel="Protocol"
                            value={customDraft.api}
                            onChange={(val) =>
                              setCustomDraft((d) => ({ ...d, api: val }))
                            }
                            options={[
                              { value: "openai-chat", label: "OpenAI Chat Completions" },
                              { value: "openai-responses", label: "OpenAI Responses" },
                              { value: "anthropic-messages", label: "Anthropic Messages" },
                              { value: "google-generative-ai", label: "Google Generative AI" },
                            ]}
                          />
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
                    {customProvidersList.map((p) => renderProviderRow(p, "custom"))}
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
                    {builtinProvidersList.map((p) => renderProviderRow(p, "builtin"))}
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
                disabled={!generalEditing || savingGeneral}
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
