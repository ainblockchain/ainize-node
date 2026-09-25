/**
 * What this node can serve, declared rather than discovered.
 *
 * `/v1/models` and routing both read this one list, so a node that runs only the LLM advertises only the LLM
 * instead of accepting a transcription request it will fail. Probing upstreams to find out would make the answer
 * depend on which container happened to be up when the question was asked.
 *
 * A model id belongs to exactly one backend. Two backends claiming the same id would make routing depend on array
 * order — a silent, order-dependent choice nobody made — so it is refused at construction, where the operator can
 * still see it, rather than at the request that happens to arrive first.
 */

export type InferenceModality = 'chat' | 'transcription' | 'image';

export interface InferenceBackend {
  id: string;
  modality: InferenceModality;
  /** Base URL of the upstream OpenAI-shaped server (vLLM, or the diffusers sidecar). */
  upstream: string;
  models: string[];
  /** How many requests this backend runs at once. The LLM is 1: it is behind the shared lease. */
  concurrency: number;
}

/** One entry of `GET /v1/models`, in the shape a stock OpenAI client parses. */
export interface InferenceModelCard {
  id: string;
  object: 'model';
  owned_by: string;
}

export class InferenceBackendRegistry {
  private readonly byModel = new Map<string, InferenceBackend>();

  constructor(private readonly backends: InferenceBackend[]) {
    for (const backend of backends) {
      for (const model of backend.models) {
        const owner = this.byModel.get(model);
        if (owner) throw new Error(`two backends claim the model ${model}: ${owner.id} and ${backend.id}`);
        this.byModel.set(model, backend);
      }
    }
  }

  listModels(): InferenceModelCard[] {
    return [...this.byModel.entries()].map(([id, backend]) => ({ id, object: 'model' as const, owned_by: backend.id }));
  }

  /** The backend serving this model, or null — never a fallback, which would answer with the wrong model. */
  backendForModel(model: string): InferenceBackend | null {
    return this.byModel.get(model) ?? null;
  }

  /** Every backend of one modality. Each modality queues separately: they are different GPUs, not one pool. */
  backendsFor(modality: InferenceModality): InferenceBackend[] {
    return this.backends.filter((b) => b.modality === modality);
  }
}
