import type { GatewayOptions, GatewayState, RemoteBridge, RemoteServer } from "./server.js";
import type { ManagementBridge } from "./management.js";

export type DesktopCustomProvider = {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  envKey?: string;
  models: string[];
};

export type DesktopProviderAuthDetail =
  | { type: "oauth"; expiresAt: number | null }
  | { type: "api_key"; maskedKey: string };

export type DesktopSettings = {
  provider: string;
  model: string;
  baseUrl: string;
  reasoningEffort: string;
  hasApiKey: boolean;
  authDetails: Record<string, DesktopProviderAuthDetail>;
  customProviders: DesktopCustomProvider[];
};

export type DesktopSettingsPatch = {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  reasoningEffort?: string;
  providerCredential?: { providerId: string; apiKey: string };
  customProvider?: {
    id: string;
    name: string;
    api: string;
    baseUrl: string;
    defaultModel?: string;
    apiKey?: string;
    envKey?: string;
  };
  deleteCustomProviderId?: string;
  removeProviderCredentialId?: string;
};

export const VALID_REASONING_EFFORTS: Set<string>;
export const VALID_PROVIDER_APIS: Set<string>;

export function resolveRindHome(envHome?: string, fallbackHome?: string): string;
export function resolveRindPaths(rindHomeOverride?: string): {
  rindHome: string;
  settingsPath: string;
  authPath: string;
  providersPath: string;
};
export function maskSecretKey(raw: string): string;
export function slugifyProviderId(value: string): string;
export function isValidHttpUrl(value: string): boolean;
export function parseAuthDetails(authData: Record<string, unknown>): Record<string, DesktopProviderAuthDetail>;
export function parseCustomProviders(providersData: Record<string, unknown>): DesktopCustomProvider[];
export function loadRuntimeSettings(rindHomeOverride?: string): Promise<DesktopSettings>;
export function validateSettingsPatch(value: unknown): DesktopSettingsPatch;
export function saveRuntimeSettings(value: unknown, rindHomeOverride?: string): Promise<DesktopSettings>;
export function resolveWebRoot(override?: string, repoRoot?: string): string;

export function createRemoteBridge(options: {
  getRindHome?: () => string;
  getFallbackConfigFile?: () => string;
  initializeRuntime: () => Promise<any>;
  requestRuntime: (method: string, params?: Record<string, unknown>) => Promise<any>;
  subscribeRuntime?: (listener: (event: any) => void) => () => void;
  management?: ManagementBridge;
  settingsLoad?: () => Promise<unknown>;
  settingsSave?: (value: unknown) => Promise<unknown>;
}): RemoteBridge;

export type RemoteHost = {
  state(): GatewayState;
  start(options?: Partial<GatewayOptions>): Promise<GatewayState>;
  stop(): Promise<GatewayState>;
  rotate(): GatewayState;
  allowNetwork(execPath?: string): Promise<GatewayState>;
  notifyWorkspacesChanged(): GatewayState;
  close(): Promise<void>;
  management: ManagementBridge;
  server: RemoteServer;
};

export function createRemoteHost(options: {
  getRindHome?: () => string;
  getFallbackConfigFile?: () => string;
  repoRoot?: string;
  getRuntimePath?: () => string;
  getPython?: () => string | undefined;
  initializeRuntime: () => Promise<any>;
  requestRuntime: (method: string, params?: Record<string, unknown>) => Promise<any>;
  subscribeRuntime?: (listener: (event: any) => void) => () => void;
  ensureRuntimeForWorkspace?: (workspaceRoot?: string) => Promise<void>;
  isSharedRuntime?: () => boolean;
  allowSharedObserver?: boolean;
  management?: ManagementBridge;
  settingsLoad?: () => Promise<unknown>;
  settingsSave?: (value: unknown) => Promise<unknown>;
  webRoot?: string;
  allowMissingWebRoot?: boolean;
  onStateChange?: (state: GatewayState) => void;
}): RemoteHost;
