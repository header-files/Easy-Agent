/** Public identity only; provider instances and credentials never cross this boundary. */
export interface ModelDescriptor {
  readonly id: string;
  readonly providerId: string;
  readonly modelId: string;
}

/** Read-only model selection surface shared by Application and Runtime. */
export interface ModelCatalog {
  has(modelId: string): boolean;
  list(): readonly ModelDescriptor[];
}
