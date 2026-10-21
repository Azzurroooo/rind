import type { NetworkInterfaceInfo } from "node:os";

export type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;
export type LocalAddressRow = {
  name: string;
  address: string;
  rank: number;
};

export declare function outboundAddress(): Promise<string>;
export declare function localAddresses(interfaces?: Interfaces, preferred?: string): LocalAddressRow[];
