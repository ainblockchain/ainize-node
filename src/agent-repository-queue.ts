import type { Request, RequestHandler, Router } from 'express';

export type RepositorySerialize = <T>(id: string, operation: () => Promise<T>) => Promise<T>;

/** Keep the complete mutation, including validation and runtime application, in one per-agent queue. */
export class AgentRepositoryQueue {
  private readonly pending = new Map<string, Promise<unknown>>();
  run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.pending.set(id, next);
    void next.finally(() => { if (this.pending.get(id) === next) this.pending.delete(id); }).catch(() => undefined);
    return next;
  }
}

/** Parse middleware first; run the actual async handler inside the queue so authorization is rechecked there. */
export function serializedWrites(router: Router, serialize?: RepositorySerialize,
  key: (req: Request) => string = (req) => String(req.params.id ?? req.body?.id ?? '')) {
  const register = (method: 'post' | 'put' | 'patch' | 'delete') => (path: string, ...handlers: RequestHandler[]) => {
    const last = handlers.pop();
    if (!last) throw new Error('a mutation needs a handler');
    return router[method](path, ...handlers, async (req, res, next) => {
      try {
        const operation = async () => { await last(req, res, next); };
        if (serialize) await serialize(key(req), operation);
        else await operation();
      } catch (error) { next(error); }
    });
  };
  return { post: register('post'), put: register('put'), patch: register('patch'), delete: register('delete') };
}
