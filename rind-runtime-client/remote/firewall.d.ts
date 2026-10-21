export declare function firewallScript(executable: string, port: number): string;
export declare function allowRemoteOnWindows(executable: string, port: number): Promise<void>;
export declare const allowGatewayOnWindows: typeof allowRemoteOnWindows;
