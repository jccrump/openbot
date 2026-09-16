import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  CodexInfo,
  HarnessId,
  HarnessSettings,
  ModelRef,
  ProviderInfo,
  ProviderPreset,
} from "@openbot/protocol";
import { HarnessLogo, ProviderLogo } from "./components/ProviderLogo";
import type { DaemonStatus } from "./lib/daemon";
import type { ThemePreference } from "./lib/useTheme";
import type {
  FetchModelsResult,
  ModelOption,
  ProviderInput,
} from "./lib/useDaemon";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  daemonStatus: DaemonStatus;
  providers: ProviderInfo[];
  presets: ProviderPreset[];
  modelOptions: ModelOption[];
  defaultModel: ModelRef | null;
  requireApproval: boolean;
  harness: HarnessSettings;
  codex: CodexInfo | null;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSaveProvider: (provider: ProviderInput) => void;
  onRemoveProvider: (id: string) => void;
  onUpdateSettings: (settings: {
    defaultModel?: ModelRef;
    requireApproval?: boolean;
    harness?: { default: HarnessId };
  }) => void;
  onFetchModels: (input: {
    providerId?: string;
    baseUrl: string;
    apiKey?: string;
  }) => Promise<FetchModelsResult>;
}

interface FormState {
  id?: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  modelsText: string;
}

type SectionId = "general" | "appearance" | "providers" | "harness";

const EMPTY_FORM: FormState = {
  label: "",
  baseUrl: "",
  apiKey: "",
  apiKeyEnv: "",
  modelsText: "",
};

const SECTION_LABEL: Record<SectionId, string> = {
  general: "General",
  appearance: "Appearance",
  providers: "Providers",
  harness: "Harness",
};

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const STATUS_TEXT: Record<DaemonStatus, string> = {
  connected: "Daemon connected",
  connecting: "Connecting to daemon…",
  disconnected: "Daemon offline",
};

const HARNESSES: Array<{ id: HarnessId; name: string }> = [
  { id: "openbot", name: "OpenBot" },
  { id: "codex", name: "Codex" },
];

function authDescription(provider: ProviderInfo): string {
  if (!provider.enabled) {
    return "Disabled";
  }
  if (provider.hasApiKey) {
    return "Authenticated · API key saved";
  }
  if (provider.apiKeyEnv) {
    return `Waiting on ${provider.apiKeyEnv}`;
  }
  return "No API key needed";
}

function SlidersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 5.2h7M13.4 5.2H14M2 10.8h1M6 10.8h8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="11.2" cy="5.2" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.6" cy="10.8" r="1.7" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function AppearanceIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2z" fill="currentColor" />
    </svg>
  );
}

function ProvidersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.2" y="2.6" width="11.6" height="4.6" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.2" y="8.8" width="11.6" height="4.6" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5" cy="4.9" r="0.8" fill="currentColor" />
      <circle cx="5" cy="11.1" r="0.8" fill="currentColor" />
    </svg>
  );
}

function HarnessIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.6 6.2 6.6 8l-2 1.8M8.6 10h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 3.5 5 8l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.4 10.4 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m3.5 8.4 3 3 6-6.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const NAV_ITEMS: Array<{
  id: SectionId;
  label: string;
  icon: () => ReactElement;
}> = [
  { id: "general", label: "General", icon: SlidersIcon },
  { id: "appearance", label: "Appearance", icon: AppearanceIcon },
  { id: "providers", label: "Providers", icon: ProvidersIcon },
  { id: "harness", label: "Harness", icon: HarnessIcon },
];

export function Settings(props: SettingsProps) {
  const { open, onClose } = props;
  const [section, setSection] = useState<SectionId>("providers");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<FormState | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fetchState, setFetchState] = useState<{
    loading: boolean;
    error: string | null;
  }>({ loading: false, error: null });
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setForm(null);
      setSelectedId(null);
      setSearch("");
      setFetchState({ loading: false, error: null });
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (form) {
          setForm(null);
        } else {
          onClose();
        }
        return;
      }
      if (event.key === "/" && !form) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
          return;
        }
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, form, onClose]);

  if (!open) {
    return null;
  }

  const startAdd = (preset?: ProviderPreset) => {
    setFetchState({ loading: false, error: null });
    setSelectedId(null);
    if (preset) {
      setForm({
        label: preset.label,
        baseUrl: preset.baseUrl,
        apiKey: "",
        apiKeyEnv: preset.apiKeyEnv ?? "",
        modelsText: preset.models.join("\n"),
      });
      return;
    }
    setForm({ ...EMPTY_FORM });
  };

  const startEdit = (provider: ProviderInfo) => {
    setFetchState({ loading: false, error: null });
    setSelectedId(provider.id);
    setForm({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey: "",
      apiKeyEnv: provider.apiKeyEnv ?? "",
      modelsText: provider.models.join("\n"),
    });
  };

  const save = () => {
    if (!form || !form.label.trim() || !form.baseUrl.trim()) {
      return;
    }
    props.onSaveProvider({
      ...(form.id ? { id: form.id } : {}),
      label: form.label.trim(),
      baseUrl: form.baseUrl.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      apiKeyEnv: form.apiKeyEnv.trim(),
      models: form.modelsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    });
    setForm(null);
  };

  const fetchModels = async () => {
    if (!form || !form.baseUrl.trim()) {
      return;
    }
    setFetchState({ loading: true, error: null });
    const result = await props.onFetchModels({
      ...(form.id ? { providerId: form.id } : {}),
      baseUrl: form.baseUrl.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    });
    if (result.ok) {
      setForm((current) =>
        current
          ? { ...current, modelsText: result.models.join("\n") }
          : current,
      );
      setFetchState({
        loading: false,
        error: result.models.length > 0 ? null : "the provider returned no models",
      });
    } else {
      setFetchState({
        loading: false,
        error: result.error ?? "failed to fetch models",
      });
    }
  };

  const toggleProvider = (provider: ProviderInfo) => {
    props.onSaveProvider({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKeyEnv: provider.apiKeyEnv ?? "",
      models: provider.models,
      enabled: !provider.enabled,
    });
  };

  const removeSelected = () => {
    if (!form?.id) {
      return;
    }
    props.onRemoveProvider(form.id);
    setForm(null);
    setSelectedId(null);
  };

  const defaultValue = props.defaultModel
    ? `${props.defaultModel.provider}::${props.defaultModel.model}`
    : "";

  const query = search.trim().toLowerCase();
  const navItems = NAV_ITEMS.filter((item) =>
    item.label.toLowerCase().includes(query),
  );
  const visibleProviders = query
    ? props.providers.filter((provider) =>
        `${provider.label} ${provider.id}`.toLowerCase().includes(query),
      )
    : props.providers;
  const selectedProvider =
    props.providers.find((provider) => provider.id === selectedId) ?? null;

  return (
    <div className="settings-window" role="dialog" aria-label="Settings">
      <aside className="settings-nav">
        <div className="settings-brand">
          <span className="settings-brand-mark">
            <HarnessLogo id="openbot" size={16} />
          </span>
          OpenBot
        </div>

        <div className="settings-search">
          <SearchIcon />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            aria-label="Search settings"
            spellCheck={false}
          />
          <kbd>/</kbd>
        </div>

        <nav className="settings-nav-list">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item ${
                section === item.id ? "settings-nav-item-active" : ""
              }`}
              onClick={() => setSection(item.id)}
            >
              <item.icon />
              {item.label}
            </button>
          ))}
          {navItems.length === 0 && (
            <p className="settings-nav-empty">No matches</p>
          )}
        </nav>

        <div className="settings-nav-footer">
          <button className="settings-nav-item" onClick={onClose}>
            <BackIcon />
            Back
          </button>
        </div>
      </aside>

      <main className="settings-main">
        <header className="settings-main-header">
          <div className="settings-breadcrumb">
            <span className="settings-breadcrumb-muted">Settings</span>
            <span className="settings-breadcrumb-sep">/</span>
            <span>{SECTION_LABEL[section]}</span>
          </div>
          <div className="settings-main-actions">
            <span className="settings-status">{STATUS_TEXT[props.daemonStatus]}</span>
            {section === "providers" && (
              <button
                className="icon-button"
                title="Add provider"
                aria-label="Add provider"
                onClick={() => startAdd()}
              >
                <PlusIcon />
              </button>
            )}
          </div>
        </header>

        <div className="settings-content">
          <div className="settings-content-inner">
            {section === "general" && (
              <section className="settings-card">
                <div className="settings-row">
                  <span>Default model</span>
                  <select
                    value={defaultValue}
                    aria-label="Default model"
                    onChange={(event) => {
                      const [provider, model] = event.target.value.split("::");
                      if (provider && model) {
                        props.onUpdateSettings({
                          defaultModel: { provider, model },
                        });
                      }
                    }}
                  >
                    {props.modelOptions.length === 0 && (
                      <option value="">No models yet</option>
                    )}
                    {props.modelOptions.map((option) => (
                      <option
                        key={`${option.provider}::${option.model}`}
                        value={`${option.provider}::${option.model}`}
                      >
                        {option.providerLabel} · {option.model}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-row">
                  <span>Ask before running commands</span>
                  <button
                    role="switch"
                    aria-checked={props.requireApproval}
                    aria-label="Ask before running commands"
                    className={`switch ${props.requireApproval ? "switch-on" : ""}`}
                    onClick={() =>
                      props.onUpdateSettings({
                        requireApproval: !props.requireApproval,
                      })
                    }
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
              </section>
            )}

            {section === "appearance" && (
              <>
                <section className="settings-card">
                  <div className="settings-row">
                    <span>Theme</span>
                    <div className="segmented" role="radiogroup" aria-label="Theme">
                      {THEME_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          role="radio"
                          aria-checked={props.theme === option.value}
                          className={`segmented-option ${
                            props.theme === option.value
                              ? "segmented-option-active"
                              : ""
                          }`}
                          onClick={() => props.onThemeChange(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
                <p className="settings-empty">
                  System follows your Mac's appearance and updates automatically.
                </p>
              </>
            )}

            {section === "providers" && (
              <>
                <div className="settings-card">
                  {visibleProviders.length === 0 && (
                    <p className="settings-empty">
                      {props.providers.length === 0
                        ? "No providers yet. Add one to start chatting."
                        : "No providers match your search."}
                    </p>
                  )}
                  {visibleProviders.map((provider) => (
                    <div
                      key={provider.id}
                      role="button"
                      tabIndex={0}
                      className={`provider-item ${
                        provider.id === selectedId ? "provider-item-selected" : ""
                      } ${provider.enabled ? "" : "provider-item-disabled"}`}
                      onClick={() => startEdit(provider)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          startEdit(provider);
                        }
                      }}
                    >
                      <span className="provider-logo">
                        <ProviderLogo id={provider.id} label={provider.label} />
                      </span>
                      <span className="provider-item-body">
                        <span className="provider-item-title">
                          <span className="provider-item-name">
                            {provider.label}
                          </span>
                          <span className="badge">
                            {provider.models.length} model
                            {provider.models.length === 1 ? "" : "s"}
                          </span>
                          {props.defaultModel?.provider === provider.id && (
                            <span className="badge badge-ok">default</span>
                          )}
                        </span>
                        <span className="provider-item-sub">
                          {authDescription(provider)}
                        </span>
                      </span>
                      <span
                        className="provider-item-toggle"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <button
                          role="switch"
                          aria-checked={provider.enabled}
                          aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.label}`}
                          className={`switch ${provider.enabled ? "switch-on" : ""}`}
                          onClick={() => toggleProvider(provider)}
                        >
                          <span className="switch-knob" />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>

                {form ? (
                  <section className="settings-detail">
                    <div className="settings-detail-head">
                      <h3>{form.id ? "Provider" : "New provider"}</h3>
                      {form.id && selectedProvider && (
                        <span className="settings-detail-url">
                          {selectedProvider.baseUrl}
                        </span>
                      )}
                    </div>

                    {!form.id && props.presets.length > 0 && (
                      <div className="preset-chips">
                        {props.presets.map((preset) => (
                          <button
                            key={preset.id}
                            className="chip"
                            onClick={() => startAdd(preset)}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="settings-detail-card">
                      <label className="field">
                        <span>Display name</span>
                        <div className="field-inline">
                          <input
                            value={form.label}
                            onChange={(event) =>
                              setForm({ ...form, label: event.target.value })
                            }
                            placeholder="DeepSeek"
                          />
                          <button
                            className="confirm-button"
                            onClick={save}
                            disabled={!form.label.trim() || !form.baseUrl.trim()}
                            aria-label="Save provider"
                            title="Save provider"
                          >
                            <CheckIcon />
                          </button>
                        </div>
                      </label>
                      <p className="field-note">
                        {selectedProvider
                          ? authDescription(selectedProvider)
                          : "New provider · not saved yet"}
                      </p>

                      <label className="field">
                        <span>Base URL</span>
                        <input
                          value={form.baseUrl}
                          onChange={(event) =>
                            setForm({ ...form, baseUrl: event.target.value })
                          }
                          placeholder="https://api.deepseek.com"
                          spellCheck={false}
                        />
                      </label>

                      <label className="field">
                        <span>API key</span>
                        <input
                          type="password"
                          value={form.apiKey}
                          onChange={(event) =>
                            setForm({ ...form, apiKey: event.target.value })
                          }
                          placeholder={
                            form.id ? "leave blank to keep the saved key" : "sk-…"
                          }
                          spellCheck={false}
                        />
                      </label>

                      <label className="field">
                        <span>Or environment variable</span>
                        <input
                          value={form.apiKeyEnv}
                          onChange={(event) =>
                            setForm({ ...form, apiKeyEnv: event.target.value })
                          }
                          placeholder="DEEPSEEK_API_KEY"
                          spellCheck={false}
                        />
                      </label>

                      <label className="field">
                        <span>Models (one per line)</span>
                        <textarea
                          value={form.modelsText}
                          onChange={(event) =>
                            setForm({ ...form, modelsText: event.target.value })
                          }
                          placeholder={"deepseek-v4-flash"}
                          rows={3}
                          spellCheck={false}
                        />
                      </label>

                      <div className="form-actions">
                        <button
                          className="ghost-button"
                          onClick={fetchModels}
                          disabled={fetchState.loading || !form.baseUrl.trim()}
                        >
                          {fetchState.loading ? "Fetching…" : "Fetch models"}
                        </button>
                        <span className="spacer" />
                        {form.id && (
                          <button className="ghost-button" onClick={removeSelected}>
                            Remove
                          </button>
                        )}
                        <button className="ghost-button" onClick={() => setForm(null)}>
                          Cancel
                        </button>
                        <button
                          className="save-button"
                          onClick={save}
                          disabled={!form.label.trim() || !form.baseUrl.trim()}
                        >
                          Save
                        </button>
                      </div>
                      {fetchState.error && (
                        <div className="form-error">{fetchState.error}</div>
                      )}
                    </div>
                  </section>
                ) : (
                  <p className="settings-empty">
                    Select a provider to edit it, or add a new one.
                  </p>
                )}
              </>
            )}

            {section === "harness" && (
              <>
                <section className="settings-card">
                  <div className="settings-row">
                    <span>Default harness</span>
                    <div
                      className="segmented"
                      role="radiogroup"
                      aria-label="Default harness"
                    >
                      {HARNESSES.map((harness) => {
                        const available =
                          harness.id === "openbot" ||
                          Boolean(props.codex?.available);
                        const selected = props.harness.default === harness.id;
                        return (
                          <button
                            key={harness.id}
                            role="radio"
                            aria-checked={selected}
                            className={`segmented-option ${
                              selected ? "segmented-option-active" : ""
                            }`}
                            disabled={!available}
                            onClick={() =>
                              props.onUpdateSettings({
                                harness: { default: harness.id },
                              })
                            }
                          >
                            {harness.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>
                <div className="settings-card">
                  {HARNESSES.map((harness) => {
                    const isCodex = harness.id === "codex";
                    const available = !isCodex || Boolean(props.codex?.available);
                    const selected = props.harness.default === harness.id;
                    const subtitle = isCodex
                      ? props.codex?.available
                        ? `Detected · v${props.codex.version ?? "unknown"}`
                        : "Not installed"
                      : "Built-in agent loop the daemon runs today";
                    return (
                      <div
                        key={harness.id}
                        className={`provider-item ${
                          selected ? "provider-item-selected" : ""
                        } ${available ? "" : "provider-item-disabled"}`}
                      >
                        <span className="provider-logo">
                          <HarnessLogo id={harness.id} />
                        </span>
                        <span className="provider-item-body">
                          <span className="provider-item-title">
                            <span className="provider-item-name">
                              {harness.name}
                            </span>
                            {selected && (
                              <span className="badge badge-ok">default</span>
                            )}
                            {isCodex && !available && (
                              <span className="badge">not installed</span>
                            )}
                          </span>
                          <span className="provider-item-sub">{subtitle}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
                <p className="settings-empty">
                  Codex runs read-only and drives the same computer through
                  MCP. ChatGPT quota is only used with OpenAI/ChatGPT models;
                  other providers run through a local bridge with an isolated
                  Codex home.
                </p>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
