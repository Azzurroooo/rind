export function listenOwned(server: any, endpoint: string): Promise<void>;
export function probeEndpoint(endpoint: string): Promise<boolean>;
export class EndpointOccupiedError extends Error {
  code: string;
}
