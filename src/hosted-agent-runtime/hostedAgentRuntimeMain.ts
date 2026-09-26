/**
 * The container entry point: one hosted agent, served at the root on port 8080.
 *
 * Everything arrives in the environment, set by the node at `docker run` (hosted-agent-docker.ts):
 *   AINIZE_AGENT_SPEC      JSON of the HostedAgentRuntimeSpec
 *   AINIZE_GATEWAY_URL     the node's gateway on the docker bridge
 *   AINIZE_AGENT_TOKEN     this container's gateway token
 *   AINIZE_SECRET_<NAME>   one per secret the owner has set
 *   AINIZE_AGENT_ENTRY     the module to load (default /agent/index.mjs)
 *
 * Values arrive as `b64:<base64>` (the node writes them through an env file, where a raw newline would end one).
 *
 * The global `fetch` is replaced before the agent's module is imported (hostedAgentGlobalFetch): the gateway is
 * reached directly, everything else through egress — so a library that calls `fetch` itself still works, and
 * there is no other route out of the container anyway.
 */
import express from 'express';
import { pathToFileURL } from 'node:url';
import { hostedAgentGlobalFetch } from './hostedAgentContext.js';
import { createHostedAgentRuntimeRouter } from './hostedAgentRuntimeApp.js';
import type { HostedAgentModule, HostedAgentRuntimeSpec } from './hostedAgentRuntimeTypes.js';

const HOSTED_AGENT_SECRET_ENV_PREFIX = 'AINIZE_SECRET_';

/** `b64:`-prefixed values are decoded; anything else is taken as written (a hand-run container). */
export const hostedAgentEnvValue = (v: string | undefined): string =>
  (v?.startsWith('b64:') ? Buffer.from(v.slice(4), 'base64').toString('utf8') : v ?? '');

export function hostedAgentSecretsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(HOSTED_AGENT_SECRET_ENV_PREFIX) && typeof v === 'string') out[k.slice(HOSTED_AGENT_SECRET_ENV_PREFIX.length)] = hostedAgentEnvValue(v);
  }
  return out;
}

/** A module may default-export the object, or export `execute` / `tools` by name. */
export function hostedAgentModuleOf(imported: Record<string, unknown>): HostedAgentModule {
  const d = (imported.default ?? {}) as HostedAgentModule;
  return {
    execute: d.execute ?? (imported.execute as HostedAgentModule['execute']),
    tools: d.tools ?? (imported.tools as HostedAgentModule['tools']),
  };
}

async function main() {
  const spec = JSON.parse(hostedAgentEnvValue(process.env.AINIZE_AGENT_SPEC)) as HostedAgentRuntimeSpec;
  const gateway = { url: hostedAgentEnvValue(process.env.AINIZE_GATEWAY_URL), token: hostedAgentEnvValue(process.env.AINIZE_AGENT_TOKEN) };
  const secrets = hostedAgentSecretsFromEnv(process.env);
  // Scrub them from the environment the agent's code can read; `ctx.secret` is the one way in.
  for (const k of Object.keys(process.env)) if (k.startsWith(HOSTED_AGENT_SECRET_ENV_PREFIX) || k === 'AINIZE_AGENT_TOKEN') delete process.env[k];

  globalThis.fetch = hostedAgentGlobalFetch(gateway);
  const entry = hostedAgentEnvValue(process.env.AINIZE_AGENT_ENTRY) || '/agent/index.mjs';
  const mod = hostedAgentModuleOf(await import(pathToFileURL(entry).href) as Record<string, unknown>);

  const log = (...args: unknown[]) => console.log(`[${spec.id}]`, ...args);
  const app = express();
  app.disable('x-powered-by');
  app.use(createHostedAgentRuntimeRouter({ spec, gateway, secrets, log, module: mod, cardUrl: 'http://localhost:8080' }));
  app.listen(8080, '0.0.0.0', () => log(`hosted agent v${spec.version} (${spec.mode}, ${spec.model}) on :8080`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
