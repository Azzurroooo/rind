import type { RuntimeMethod } from "../../desktop/src/preload/types";

export declare const DESKTOP_RUNTIME_METHODS: Set<RuntimeMethod>;
export declare const REMOTE_RUNTIME_METHODS: Set<RuntimeMethod>;
export declare function isDesktopRuntimeMethod(value: unknown): value is RuntimeMethod;
export declare function isRemoteRuntimeMethod(value: unknown): value is RuntimeMethod;
