import type {
  ModelCatalog,
  ModelClient,
  ModelDescriptor,
} from '../../harness/contracts/model/index.ts';

export interface ResolvedModel extends ModelDescriptor {
  readonly client: ModelClient;
}

const providerPattern = /^[a-zA-Z0-9_-]{1,64}$/;

export function parseModelId(value: unknown): ModelDescriptor {
  if (typeof value !== 'string' || value.trim() !== value) {
    throw new Error('Model identifier is invalid.');
  }
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('Model identifier is invalid.');
  }
  const providerId = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  if (!providerPattern.test(providerId) || modelId.trim().length === 0) {
    throw new Error('Model identifier is invalid.');
  }
  return Object.freeze({ id: value, providerId, modelId });
}

/** Immutable startup registry; runtime provider/model mutation is intentionally unsupported. */
export class DefaultModelRegistry implements ModelCatalog {
  private readonly models = new Map<string, ResolvedModel>();
  private readonly descriptors: readonly ModelDescriptor[];

  constructor(
    providers: ReadonlyMap<string, ModelClient>,
    modelIds: readonly string[],
  ) {
    if (!(providers instanceof Map) || !Array.isArray(modelIds)) {
      throw new Error('Model registry configuration is invalid.');
    }
    for (const [providerId, client] of providers) {
      if (
        !providerPattern.test(providerId) ||
        !client ||
        typeof client.generate !== 'function' ||
        typeof client.stream !== 'function'
      ) {
        throw new Error('Model registry configuration is invalid.');
      }
    }
    const descriptors: ModelDescriptor[] = [];
    for (const fullId of modelIds) {
      const descriptor = parseModelId(fullId);
      const client = providers.get(descriptor.providerId);
      if (!client) throw new Error('Model references an unknown provider.');
      if (this.models.has(descriptor.id)) {
        throw new Error('Model identifier is duplicated.');
      }
      const resolved = Object.freeze({ ...descriptor, client });
      this.models.set(descriptor.id, resolved);
      descriptors.push(descriptor);
    }
    if (descriptors.length === 0) {
      throw new Error('At least one model must be registered.');
    }
    this.descriptors = Object.freeze(descriptors);
  }

  has(modelId: string): boolean {
    return this.models.has(modelId);
  }

  list(): readonly ModelDescriptor[] {
    return this.descriptors;
  }

  resolve(modelId: string): ResolvedModel {
    const model = this.models.get(modelId);
    if (!model) throw new Error('Model is not registered.');
    return model;
  }
}
