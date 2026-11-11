export type CatalogModelSpec = {
  readonly id: string;
  readonly efforts: readonly string[];
};

export type BuiltinProviderSpec = {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly methods: readonly string[];
  readonly envKey?: string;
  readonly models: readonly CatalogModelSpec[];
};

export const BUILTIN_PROVIDER_CATALOG: readonly BuiltinProviderSpec[];
