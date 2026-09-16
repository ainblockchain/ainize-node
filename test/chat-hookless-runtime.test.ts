/**
 * A node may serve a model it cannot patch: a plain OpenAI-compatible runtime, or an engine without the
 * patch hook installed. Two things must still hold there.
 *
 *  1. Asking the model with nothing loaded works. That turn writes nothing, so it needs the generation API
 *     and nothing else. It used to be refused with `runtime repo not found` — an error about a capability
 *     the turn never uses. Loading a knowledge on such a node is still refused, and that is the point.
 *  2. Naming the model is answered from the serving side, not from the 30-second status cache. An operator
 *     who swaps the served model must not be told their own new model "is not served by this node".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, type NodeConfig } from '@ainize/core';
import type { ChatMessage, ChatResult } from '../src/runtime.js';
import { startNode, type RunningNode } from '../src/server.js';
import { seedDemo } from '../src/seed.js';

const tmp = mkdtempSync(join(tmpdir(), 'ainize-hookless-test-'));
const PORT = 24040;   // 24071-24073 belong to dispute.test.ts; `node --test` runs the files in one pool, so a shared constant is a hard EADDRINUSE
let N: RunningNode;

/** What the serving side has loaded. Changing it must be visible to the very next named-model request. */
let servedModel = 'first/model';
let statusCalls = 0;

before(async () => {
  const cfg: NodeConfig = defaultConfig({ home: join(tmp, 'N'), name: 'N', port: PORT, peers: [], roles: ['seller', 'serving'], ledger: 'local' });
  cfg.runtime = { repo: undefined, api: 'http://127.0.0.1:1' };
  cfg.host = '127.0.0.1'; cfg.publicUrl = `http://127.0.0.1:${PORT}`;
  cfg.gossipIntervalMs = 60_000;
  N = await startNode(cfg, { quiet: true, serveWeb: false });
  await seedDemo(N.market, { real: false, synthetic: true });
  const rt = N.market.runtime as unknown as Record<string, unknown>;
  Object.assign(rt, {
    // No hook and no repo: exactly what a plain OpenAI-compatible runtime reports.
    status: async (force?: boolean) => {
      statusCalls += 1;
      return { available: false, api: 'fake', model: servedModel, hook: false, repo: null, applied: [], error: 'runtime repo not found', forced: !!force };
    },
    isApplied: async () => false,
    chat: async (): Promise<ChatResult> => ({ content: 'an answer', latency_ms: 1, model: servedModel }),
  });
});
after(async () => { await N?.stop(); rmSync(tmp, { recursive: true, force: true }); });

const msgs: ChatMessage[] = [{ role: 'user', content: 'What is the capital of France?' }];

test('base-only chat runs on a runtime with no patch hook', async () => {
  const out = await N.market.chat({ messages: msgs, mode: 'base', visitor: 'v1' });
  assert.equal(out.base?.content, 'an answer');
  assert.equal(out.model, servedModel);
});

test('loading a knowledge on the same node is still refused', async () => {
  const entry = (await N.market.catalog(true))[0];
  assert.ok(entry, 'the seeded catalogue has at least one knowledge');
  await assert.rejects(
    () => N.market.chat({ messages: msgs, mode: 'patched', patchId: entry.anchor.id, visitor: 'v1' }),
    (e: Error) => /runtime repo not found/.test(e.message),
  );
});

test('a named model is read from the serving side, not from the status cache', async () => {
  const before = await N.market.chat({ messages: msgs, mode: 'base', model: 'first/model', visitor: 'v1' });
  assert.equal(before.model, 'first/model');
  servedModel = 'second/model';
  // Inside the 30-second cache window the old answer would still say `first/model`.
  const after = await N.market.chat({ messages: msgs, mode: 'base', model: 'second/model', visitor: 'v1' });
  assert.equal(after.model, 'second/model');
  await assert.rejects(
    () => N.market.chat({ messages: msgs, mode: 'base', model: 'first/model', visitor: 'v1' }),
    (e: Error) => /is not served by this node/.test(e.message) && /second\/model/.test(e.message),
  );
});
