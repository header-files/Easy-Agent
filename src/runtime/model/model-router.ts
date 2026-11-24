import {
  ModelError,
  type ModelCallOptions,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '../../harness/contracts/model/index.ts';
import { DefaultModelRegistry, type ResolvedModel } from './model-registry.ts';

function invalidModel(): never {
  throw new ModelError({
    code: 'invalid_request',
    message: 'Requested model is not registered.',
    retryable: false,
  });
}

function routedModel(model: ResolvedModel, providerModel: string): string {
  return providerModel === model.id
    ? providerModel
    : `${model.providerId}/${providerModel}`;
}

function routedResponse(
  model: ResolvedModel,
  response: ModelResponse,
): ModelResponse {
  return { ...response, model: routedModel(model, response.model) };
}

/** Stateless ModelClient router; every request carries its immutable full model identity. */
export class ModelRouter implements ModelClient {
  private readonly registry: DefaultModelRegistry;

  constructor(registry: DefaultModelRegistry) {
    if (!(registry instanceof DefaultModelRegistry)) invalidModel();
    this.registry = registry;
  }

  private route(request: ModelRequest): {
    model: ResolvedModel;
    request: ModelRequest;
  } {
    if (typeof request !== 'object' || request === null) invalidModel();
    let model: ResolvedModel;
    try {
      model = this.registry.resolve(request.model);
    } catch {
      return invalidModel();
    }
    return {
      model,
      request: { ...request, model: model.modelId },
    };
  }

  async generate(
    request: ModelRequest,
    options?: ModelCallOptions,
  ): Promise<ModelResponse> {
    const routed = this.route(request);
    const response = await routed.model.client.generate(
      routed.request,
      options,
    );
    return routedResponse(routed.model, response);
  }

  async *stream(
    request: ModelRequest,
    options?: ModelCallOptions,
  ): AsyncIterable<ModelStreamEvent> {
    const routed = this.route(request);
    for await (const event of routed.model.client.stream(
      routed.request,
      options,
    )) {
      if (event.type === 'message_start') {
        yield {
          ...event,
          model: routedModel(routed.model, event.model),
        };
      } else if (event.type === 'message_end') {
        yield {
          type: 'message_end',
          response: routedResponse(routed.model, event.response),
        };
      } else {
        yield event;
      }
    }
  }
}
