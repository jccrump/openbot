import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  AccessPane,
  AccessReport,
  ChatBusyBehavior,
  CodexInfo,
  DecisionGuardrailMode,
  DecisionInfo,
  DecisionSettingsPatch,
  HarnessId,
  HarnessSettings,
  ModelRef,
  ProviderInfo,
  ProviderPreset,
  Workspace,
} from "@openbot/protocol";
import type { Bot } from "@openbot/protocol";
import { HarnessLogo, ProviderLogo } from "./components/ProviderLogo";
import { UpdateCard } from "./components/UpdateCard";
import {
  avatarColor,
  COMPUTER_LABEL,
  effortLabel,
  hasMac,
  hasVm,
} from "./lib/agentOptions";
import type { DaemonStatus } from "./lib/daemon";
import type { ThemePreference } from "./lib/useTheme";
import type {
  DecisionTestResult,
  FetchModelsResult,
  ModelOption,
  ProviderInput,
  SandboxState,
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
  decision: DecisionInfo | null;
  codex: CodexInfo | null;
  chatBusyBehavior: ChatBusyBehavior;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSaveProvider: (provider: ProviderInput) => void;
  onRemoveProvider: (id: string) => void;
  onUpdateSettings: (settings: {
    defaultModel?: ModelRef;
    requireApproval?: boolean;
    harness?: { default: HarnessId };
    decision?: DecisionSettingsPatch;
    chatBusyBehavior?: ChatBusyBehavior;
  }) => void;
  onFetchModels: (input: {
    providerId?: string;
    baseUrl: string;
    apiKey?: string;
  }) => Promise<FetchModelsResult>;
  onTestDecision: () => Promise<DecisionTestResult>;
  roles: Bot[];
  sandboxStates: Record<string, SandboxState>;
  onHireRole: () => void;
  onEditRole: (botId: string) => void;
  bots: Bot[];
  workspaces: Workspace[];
  workspaceRoots: string[];
  onScanWorkspaces: () => void;
  onAddWorkspace: (root: string) => void;
  onUpdateWorkspace: (
    workspaceId: string,
    patch: { name?: string; ignored?: boolean; autoApprove?: string[] },
  ) => void;
  onRemoveWorkspace: (workspaceId: string) => void;
  onSaveWorkspaceRoots: (roots: string[]) => void;
  accessReport: AccessReport | null;
  onCheckAccess: () => void;
  onOpenAccessPane: (pane: AccessPane) => void;
}

interface FormState {
  id?: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  modelsText: string;
}

interface DecisionFormState {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeyEnv: string;
  timeoutMs: string;
}

type SectionId =
  | "general"
  | "appearance"
  | "providers"
  | "team"
  | "workspaces"
  | "access"
  | "harness"
  | "decision";

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
  team: "Team",
  workspaces: "Workspaces",
  access: "Access",
  harness: "Harness",
  decision: "Decision model",
};

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const CHAT_BUSY_OPTIONS: Array<{ value: ChatBusyBehavior; label: string }> = [
  { value: "steer", label: "Steer" },
  { value: "queue", label: "Queue" },
];

const GUARDRAIL_OPTIONS: Array<{
  value: DecisionGuardrailMode;
  label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "annotate", label: "Annotate" },
  { value: "block", label: "Block" },
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

function TeamIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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

function DecisionIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8.6 1.8 3.4 8.6h3.4l-.8 5.6 5.2-6.8H7.8z"
        stroke="currentColor"
        strokeWidth="1.4"
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

function WorkspacesIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 11h18" />
    </svg>
  );
}

function AccessIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
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
  { id: "team", label: "Team", icon: TeamIcon },
  { id: "workspaces", label: "Workspaces", icon: WorkspacesIcon },
  { id: "access", label: "Access", icon: AccessIcon },
  { id: "harness", label: "Harness", icon: HarnessIcon },
  { id: "decision", label: "Decision model", icon: DecisionIcon },
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
  const [decisionForm, setDecisionForm] =
    useState<DecisionFormState | null>(null);
  const [decisionSaved, setDecisionSaved] = useState(false);
  const [decisionTest, setDecisionTest] = useState<{
    testing: boolean;
    result: DecisionTestResult | null;
  }>({ testing: false, result: null });
  const [rootInput, setRootInput] = useState("");
  const [folderInput, setFolderInput] = useState("");
  const [trustEditor, setTrustEditor] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setForm(null);
      setSelectedId(null);
      setSearch("");
      setFetchState({ loading: false, error: null });
      setDecisionForm(null);
      setRootInput("");
      setFolderInput("");
      setTrustEditor(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !props.decision) {
      return;
    }
    setDecisionForm({
      baseUrl: props.decision.baseUrl,
      model: props.decision.model,
      apiKey: "",
      apiKeyEnv: props.decision.apiKeyEnv ?? "",
      timeoutMs: String(props.decision.timeoutMs),
    });
  }, [open, props.decision]);

  useEffect(() => {
    if (!decisionSaved) {
      return;
    }
    const timer = setTimeout(() => setDecisionSaved(false), 2_000);
    return () => clearTimeout(timer);
  }, [decisionSaved]);

  useEffect(() => {
    if (open && section === "access") {
      props.onCheckAccess();
    }
  }, [open, section, props.onCheckAccess]);

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

  const saveDecision = () => {
    if (!decisionForm || !decisionForm.baseUrl.trim() || !decisionForm.model.trim()) {
      return;
    }
    const timeout = Number(decisionForm.timeoutMs);
    props.onUpdateSettings({
      decision: {
        baseUrl: decisionForm.baseUrl.trim(),
        model: decisionForm.model.trim(),
        ...(decisionForm.apiKey.trim()
          ? { apiKey: decisionForm.apiKey.trim() }
          : {}),
        apiKeyEnv: decisionForm.apiKeyEnv.trim(),
        ...(Number.isFinite(timeout)
          ? {
              timeoutMs: Math.round(
                Math.min(30_000, Math.max(500, timeout)),
              ),
            }
          : {}),
      },
    });
    setDecisionForm((current) =>
      current ? { ...current, apiKey: "" } : current,
    );
    setDecisionSaved(true);
    setDecisionTest({ testing: false, result: null });
  };

  const removeDecisionKey = () => {
    props.onUpdateSettings({ decision: { apiKey: "" } });
    setDecisionForm((current) =>
      current ? { ...current, apiKey: "" } : current,
    );
    setDecisionTest({ testing: false, result: null });
  };

  const testDecision = async () => {
    setDecisionTest({ testing: true, result: null });
    const result = await props.onTestDecision();
    setDecisionTest({ testing: false, result });
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
                <div className="settings-row">
                  <span>When I message while it is working</span>
                  <div
                    className="segmented"
                    role="radiogroup"
                    aria-label="When I message while it is working"
                  >
                    {CHAT_BUSY_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        role="radio"
                        aria-checked={props.chatBusyBehavior === option.value}
                        className={`segmented-option ${
                          props.chatBusyBehavior === option.value
                            ? "segmented-option-active"
                            : ""
                        }`}
                        onClick={() =>
                          props.onUpdateSettings({
                            chatBusyBehavior: option.value,
                          })
                        }
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {section === "general" && (
              <p className="settings-empty">
                Steer folds your message into the running turn at its next step
                so it can change course. Queue holds it and sends automatically
                when the agent stops.
              </p>
            )}

            {section === "general" && <UpdateCard />}

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

            {section === "team" && (
              <section className="settings-card">
                <div className="settings-row">
                  <span>Workers</span>
                  <button
                    className="ghost-button"
                    onClick={() => props.onHireRole()}
                  >
                    Hire a role
                  </button>
                </div>
                {props.roles.length === 0 ? (
                  <p className="settings-empty">
                    No workers yet. Hire a role once, and the lead and threads
                    can spawn it for tasks.
                  </p>
                ) : (
                  props.roles.map((role) => {
                    const state = props.sandboxStates[role.id] ?? "stopped";
                    return (
                      <button
                        key={role.id}
                        className="team-row"
                        onClick={() => props.onEditRole(role.id)}
                      >
                        <span
                          className="avatar"
                          style={{
                            background:
                              role.color ?? avatarColor(role.id),
                          }}
                        />
                        <span className="team-row-body">
                          <span className="team-row-name">{role.name}</span>
                          <span className="team-row-sub">
                            {role.role?.trim() || "Worker"} ·{" "}
                            {role.model.provider} · {role.model.model}
                            {role.model.effort
                              ? ` · ${effortLabel(role.model.effort)}`
                              : ""}
                          </span>
                        </span>
                        <span className="team-row-state">
                          {!hasVm(role)
                            ? "This Mac"
                            : hasMac(role)
                              ? "Both"
                              : COMPUTER_LABEL[state] ?? state}
                        </span>
                      </button>
                    );
                  })
                )}
              </section>
            )}

            {section === "workspaces" && (
              <>
                <section className="settings-card">
                  <div className="settings-row">
                    <span>Project folders</span>
                    <button
                      className="ghost-button"
                      onClick={() => props.onScanWorkspaces()}
                    >
                      Scan now
                    </button>
                  </div>
                  {props.workspaces.length === 0 ? (
                    <p className="settings-empty">
                      No project folders yet. Add a scan root below and press
                      Scan now, or add a folder by path.
                    </p>
                  ) : (
                    props.workspaces.map((workspace) => {
                      const agentCount = props.bots.filter(
                        (bot) => bot.workspaceId === workspace.id,
                      ).length;
                      const editingTrust = trustEditor?.id === workspace.id;
                      return (
                        <div key={workspace.id} className="workspace-entry">
                          <div
                            className={`workspace-row${
                              workspace.ignored ? " workspace-row-ignored" : ""
                            }`}
                          >
                            <div className="workspace-row-body">
                              <span className="workspace-row-name">
                                {workspace.name}
                                {workspace.missing && (
                                  <span className="workspace-badge">
                                    missing
                                  </span>
                                )}
                                {workspace.ignored && (
                                  <span className="workspace-badge">
                                    ignored
                                  </span>
                                )}
                              </span>
                              <span
                                className="workspace-row-root"
                                title={workspace.root}
                              >
                                {workspace.root}
                              </span>
                              <span className="workspace-row-meta">
                                {workspace.markers.join(" · ")}
                                {agentCount > 0
                                  ? `${
                                      workspace.markers.length > 0 ? " · " : ""
                                    }${agentCount} agent${
                                      agentCount === 1 ? "" : "s"
                                    }`
                                  : ""}
                                {workspace.autoApprove.length > 0
                                  ? `${
                                      workspace.markers.length > 0 ||
                                      agentCount > 0
                                        ? " · "
                                        : ""
                                    }${workspace.autoApprove.length} trusted`
                                  : ""}
                              </span>
                            </div>
                            <div className="workspace-row-actions">
                              <button
                                className="ghost-button"
                                onClick={() =>
                                  setTrustEditor(
                                    editingTrust
                                      ? null
                                      : {
                                          id: workspace.id,
                                          text: workspace.autoApprove.join("\n"),
                                        },
                                  )
                                }
                              >
                                Trust
                              </button>
                              <button
                                className="ghost-button"
                                onClick={() =>
                                  props.onUpdateWorkspace(workspace.id, {
                                    ignored: !workspace.ignored,
                                  })
                                }
                              >
                                {workspace.ignored ? "Unignore" : "Ignore"}
                              </button>
                              <button
                                className="danger-button"
                                onClick={() =>
                                  props.onRemoveWorkspace(workspace.id)
                                }
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          {editingTrust && (
                            <div className="workspace-trust">
                              <textarea
                                value={trustEditor.text}
                                onChange={(event) =>
                                  setTrustEditor({
                                    id: workspace.id,
                                    text: event.target.value,
                                  })
                                }
                                placeholder={
                                  "^pnpm (typecheck|smoke)$\n^git status$"
                                }
                                aria-label={`Trusted commands for ${workspace.name}`}
                                spellCheck={false}
                                rows={4}
                              />
                              <div className="workspace-trust-actions">
                                <button
                                  className="ghost-button"
                                  onClick={() => setTrustEditor(null)}
                                >
                                  Cancel
                                </button>
                                <button
                                  className="save-button"
                                  onClick={() => {
                                    props.onUpdateWorkspace(workspace.id, {
                                      autoApprove:
                                        trustEditor.text.split("\n"),
                                    });
                                    setTrustEditor(null);
                                  }}
                                >
                                  Save
                                </button>
                              </div>
                              <p className="settings-note">
                                One regex per line, matched against shell
                                commands for agents working in this project.
                                Deny and ask rules still win, and file writes
                                keep asking.
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </section>

                <section className="settings-card">
                  <div className="settings-row">
                    <span>Scan roots</span>
                  </div>
                  {props.workspaceRoots.map((root) => (
                    <div key={root} className="workspace-root-row">
                      <span className="workspace-row-root" title={root}>
                        {root}
                      </span>
                      <button
                        className="ghost-button"
                        onClick={() =>
                          props.onSaveWorkspaceRoots(
                            props.workspaceRoots.filter((item) => item !== root),
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <div className="workspace-add-row">
                    <input
                      value={rootInput}
                      onChange={(event) => setRootInput(event.target.value)}
                      placeholder="/Users/you/code"
                      aria-label="Add scan root"
                      spellCheck={false}
                    />
                    <button
                      className="ghost-button"
                      disabled={!rootInput.trim()}
                      onClick={() => {
                        props.onSaveWorkspaceRoots([
                          ...props.workspaceRoots,
                          rootInput.trim(),
                        ]);
                        setRootInput("");
                      }}
                    >
                      Add root
                    </button>
                  </div>
                  <p className="settings-note">
                    Folders are scanned a few levels deep for project markers
                    like .git and package.json. Scans only add folders to the
                    list — nothing is shared with an agent until you assign it.
                  </p>
                </section>

                <section className="settings-card">
                  <div className="settings-row">
                    <span>Add a folder directly</span>
                  </div>
                  <div className="workspace-add-row">
                    <input
                      value={folderInput}
                      onChange={(event) => setFolderInput(event.target.value)}
                      placeholder="/Users/you/Projects/My App"
                      aria-label="Add project folder"
                      spellCheck={false}
                    />
                    <button
                      className="ghost-button"
                      disabled={!folderInput.trim()}
                      onClick={() => {
                        props.onAddWorkspace(folderInput.trim());
                        setFolderInput("");
                      }}
                    >
                      Add folder
                    </button>
                  </div>
                </section>
              </>
            )}

            {section === "access" && (
              <section className="settings-card">
                <div className="settings-row">
                  <span>Permissions</span>
                  <button
                    className="ghost-button"
                    onClick={() => props.onCheckAccess()}
                  >
                    Check again
                  </button>
                </div>
                <p className="settings-note">
                  macOS attributes these grants to{" "}
                  {props.accessReport?.owner ?? "the daemon's parent app"}.
                  Documents, Desktop, and Downloads prompt the first time; Full
                  Disk Access is a manual toggle in System Settings.
                </p>
                {!props.accessReport ? (
                  <p className="settings-empty">Checking…</p>
                ) : (
                  props.accessReport.entries.map((entry) => {
                    const pane = entry.pane;
                    return (
                      <div key={entry.id} className="access-row">
                        <div className="access-row-body">
                          <span className="access-row-name">
                            {entry.label}
                            <span
                              className={`access-badge access-badge-${entry.state}`}
                            >
                              {entry.state === "granted"
                                ? "granted"
                                : entry.state === "denied"
                                  ? "denied"
                                  : "not found"}
                            </span>
                          </span>
                          {entry.path && (
                            <span
                              className="workspace-row-root"
                              title={entry.path}
                            >
                              {entry.path}
                            </span>
                          )}
                        </div>
                        <div className="workspace-row-actions">
                          {entry.id !== "full-disk" && entry.id !== "home" && (
                            <button
                              className="ghost-button"
                              onClick={() => props.onCheckAccess()}
                            >
                              Request
                            </button>
                          )}
                          {pane && (
                            <button
                              className="ghost-button"
                              onClick={() => props.onOpenAccessPane(pane)}
                            >
                              Open Settings
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </section>
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

            {section === "decision" && (
              <>
                <section className="settings-card">
                  <div className="settings-row">
                    <span>Use Jev for fast decisions</span>
                    <button
                      role="switch"
                      aria-checked={props.decision?.enabled ?? false}
                      aria-label="Use Jev for fast decisions"
                      className={`switch ${
                        props.decision?.enabled ? "switch-on" : ""
                      }`}
                      onClick={() =>
                        props.onUpdateSettings({
                          decision: { enabled: !(props.decision?.enabled ?? false) },
                        })
                      }
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                  <p className="field-note">
                    {props.decision?.hasApiKey
                      ? "Authenticated · API key saved"
                      : props.decision?.apiKeyEnv
                        ? `Waiting on ${props.decision.apiKeyEnv}`
                        : "No API key yet"}
                    {" · "}
                    TypeSafe System One (Jev) returns typed decisions in about
                    100–500 ms. Page text, drafts, and tool context are sent to
                    the configured endpoint.
                  </p>
                </section>

                {decisionForm && (
                  <section className="settings-detail">
                    <div className="settings-detail-head">
                      <h3>Connection</h3>
                      <span className="settings-detail-url">
                        {props.decision?.model ?? decisionForm.model}
                      </span>
                    </div>
                    <form
                      className="settings-detail-card"
                      onSubmit={(event) => {
                        event.preventDefault();
                        saveDecision();
                      }}
                    >
                      <label className="field">
                        <span>Base URL</span>
                        <input
                          value={decisionForm.baseUrl}
                          onChange={(event) =>
                            setDecisionForm({
                              ...decisionForm,
                              baseUrl: event.target.value,
                            })
                          }
                          placeholder="https://api.typesafe.ai"
                          spellCheck={false}
                        />
                      </label>
                      <label className="field">
                        <span>Model</span>
                        <input
                          value={decisionForm.model}
                          onChange={(event) =>
                            setDecisionForm({
                              ...decisionForm,
                              model: event.target.value,
                            })
                          }
                          placeholder="jev-latest"
                          spellCheck={false}
                        />
                      </label>
                      <label className="field">
                        <span>
                          API key{" "}
                          {props.decision?.hasApiKey && (
                            <span className="badge badge-ok">saved</span>
                          )}
                        </span>
                        <input
                          type="password"
                          value={decisionForm.apiKey}
                          onChange={(event) =>
                            setDecisionForm({
                              ...decisionForm,
                              apiKey: event.target.value,
                            })
                          }
                          placeholder={
                            props.decision?.hasApiKey
                              ? "•••••••• key saved — type a new key to replace"
                              : "typesafe key"
                          }
                          spellCheck={false}
                        />
                      </label>
                      <label className="field">
                        <span>Or environment variable</span>
                        <input
                          value={decisionForm.apiKeyEnv}
                          onChange={(event) =>
                            setDecisionForm({
                              ...decisionForm,
                              apiKeyEnv: event.target.value,
                            })
                          }
                          placeholder="TYPESAFE_API_KEY"
                          spellCheck={false}
                        />
                      </label>
                      <label className="field">
                        <span>Timeout (ms)</span>
                        <input
                          value={decisionForm.timeoutMs}
                          onChange={(event) =>
                            setDecisionForm({
                              ...decisionForm,
                              timeoutMs: event.target.value,
                            })
                          }
                          placeholder="3000"
                          spellCheck={false}
                        />
                      </label>
                      <div className="form-actions">
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={testDecision}
                          disabled={decisionTest.testing}
                        >
                          {decisionTest.testing ? "Testing…" : "Test key"}
                        </button>
                        {props.decision?.hasApiKey && (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={removeDecisionKey}
                          >
                            Remove key
                          </button>
                        )}
                        <span className="spacer" />
                        <button
                          type="submit"
                          className="save-button"
                          disabled={
                            !decisionForm.baseUrl.trim() ||
                            !decisionForm.model.trim()
                          }
                        >
                          {decisionSaved ? "Saved" : "Save"}
                        </button>
                      </div>
                      {decisionTest.result && (
                        <p
                          className={
                            decisionTest.result.ok
                              ? "field-note"
                              : "form-error"
                          }
                        >
                          {decisionTest.result.ok
                            ? `Connected · ${decisionTest.result.model ?? decisionForm.model}${
                                decisionTest.result.latencyMs !== null
                                  ? ` · ${decisionTest.result.latencyMs} ms`
                                  : ""
                              }`
                            : `Test failed: ${
                                decisionTest.result.error ??
                                "unknown error"
                              }`}
                        </p>
                      )}
                    </form>
                  </section>
                )}

                <section className="settings-card">
                  <div className="settings-row">
                    <span>Route requests</span>
                    <button
                      role="switch"
                      aria-checked={props.decision?.route ?? true}
                      aria-label="Route requests"
                      className={`switch ${
                        props.decision?.route ?? true ? "switch-on" : ""
                      }`}
                      onClick={() =>
                        props.onUpdateSettings({
                          decision: { route: !(props.decision?.route ?? true) },
                        })
                      }
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                  <div className="settings-row">
                    <span>Completion audit</span>
                    <button
                      role="switch"
                      aria-checked={props.decision?.audit ?? true}
                      aria-label="Completion audit"
                      className={`switch ${
                        props.decision?.audit ?? true ? "switch-on" : ""
                      }`}
                      onClick={() =>
                        props.onUpdateSettings({
                          decision: { audit: !(props.decision?.audit ?? true) },
                        })
                      }
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                  <div className="settings-row">
                    <span>Browse loop</span>
                    <button
                      role="switch"
                      aria-checked={props.decision?.browse ?? true}
                      aria-label="Browse loop"
                      className={`switch ${
                        props.decision?.browse ?? true ? "switch-on" : ""
                      }`}
                      onClick={() =>
                        props.onUpdateSettings({
                          decision: {
                            browse: !(props.decision?.browse ?? true),
                          },
                        })
                      }
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                  <div className="settings-row">
                    <span>Untrusted-content guardrail</span>
                    <div
                      className="segmented"
                      role="radiogroup"
                      aria-label="Untrusted-content guardrail"
                    >
                      {GUARDRAIL_OPTIONS.map((option) => {
                        const selected =
                          (props.decision?.guardrail ?? "annotate") ===
                          option.value;
                        return (
                          <button
                            key={option.value}
                            role="radio"
                            aria-checked={selected}
                            className={`segmented-option ${
                              selected ? "segmented-option-active" : ""
                            }`}
                            onClick={() =>
                              props.onUpdateSettings({
                                decision: { guardrail: option.value },
                              })
                            }
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>

                <p className="settings-empty">
                  Jev drives the browse tool and screens page text for prompt
                  injection. With the completion audit on, browser-backed
                  drafts are verified before they are final — Jev when it is
                  available, the model verifier otherwise — and rejected drafts
                  are revised up to two times. With it off, answers stream
                  straight to chat.
                </p>
              </>
            )}

          </div>
        </div>
      </main>
    </div>
  );
}
