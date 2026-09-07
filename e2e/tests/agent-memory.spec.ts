/**
 * AZ-090 … AZ-099 — persona "an agent that ainizes its own experience": the memory loop end to end.
 *
 *   a question arrives
 *     → answer it from the memory this agent already carries      no query, no completion, no cost
 *     → or buy a LISTED knowledge that covers it, and KEEP it
 *     → or ask an upstream MCP server, which costs a query EVERY time
 *          → and when the same SHAPE has been looked up often enough, compile it into an engram
 *
 * **Nothing here touches the shared cluster, the shared model or a GPU.** Every scenario runs against a private
 * throwaway node whose serving API points at a closed port, and whose trainer is `AINIZE_TEACH_BACKEND=stub` — a
 * real lesson record, a real dataset, the node's real state machine, and a knowledge file that trains no weights.
 * The upstream "data server" is a local stdio MCP server (`helpers/fake-subgraph-mcp.mjs`), so the real
 * `McpDataSource`, the real row mapping and the real shape counters all run with no network and no API key.
 *
 * What that leaves GPU-pending is stated rather than faked: a lesson that changes a model's answers needs the
 * trainer on GPUs 4,5,6, and `bake_cost` — one of the two terms of N* — cannot be measured until one has run. The
 * suite asserts what is true today: that the agent REFUSES to bake on a break-even it cannot compute, and that
 * `--bake-after` is labelled a policy wherever it appears.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, SCRATCH, startThrowawayNode, type ThrowawayNode } from '../helpers/ainize';
import { agentExec } from '../helpers/agent-x402';

test.describe.configure({ mode: 'serial' });

/** The stdio MCP server the plan points at: in this repo, so it resolves the SDK from the workspace. */
const FAKE_MCP = join(REPO, 'packages/e2e/helpers/fake-subgraph-mcp.mjs');
const HOME = join(SCRATCH, `agent-memory-${Date.now().toString(36)}`);
/** The shipped plan, repointed at the local server. Everything else about it — arguments, mapping, patterns — is unchanged. */
const PLAN_ID = 'local/erc20-address-by-symbol';

let node: ThrowawayNode;

/**
 * The agent must never send a completion to the shared engine. Its serving API is read from the node, which points
 * at a closed port here; these override the two variables `helpers/agent-x402` sets for the LIVE cluster.
 */
const ENV = { ENGRAM_API: 'http://127.0.0.1:9', ENGRAM_API_PUBLIC: 'http://127.0.0.1:9', AINIZE_LOCALE: 'en' };

const agent = (args: string[], timeoutMs = 5 * 60_000) =>
  agentExec([...args, '--home', HOME, '--market', node.url], { env: ENV, timeoutMs });

/**
 * `ask --json` for one question, with the whole result.
 *
 * `--plan local/` is not decoration: the SHIPPED plan answers exactly the same phrasings and points at the hosted
 * Subgraph MCP, so without it this suite would leave the machine, need an API key, and stop being a test of the
 * agent. Restricting to the local plan is what keeps it hermetic.
 */
async function ask(question: string, args: string[] = []) {
  const r = await agent(['ask', question, '--json', '--plan', 'local/', ...args]);
  expect(r.stdout, `ask ${question} printed nothing\n${r.stderr}`).not.toBe('');
  return { ...r, json: JSON.parse(r.stdout) as AskJson };
}

interface AskJson {
  answer: string | null; via: string | null; outcome: string; shape: string | null;
  cost: { completions: number; queries: number; money: string | null; lessons: number; gpu_s: string | null };
  bought: { patch_id: string | null; amount: string | null; outcome?: string } | null;
  retrieved: { shape: string; rows: unknown[]; new_rows: number; refetched: number; churned: number; queries: number } | null;
  bake: { decision: { bake: boolean; trigger: string | null; gates: { name: string; ok: boolean }[]; nstar: { computable: boolean; missing: string[] } }; result: { job_id: string | null; status: string; backend: string | null; simulated: boolean; lesson_spent: boolean; gpu_seconds_settled: string | null; preflight: string } | null } | null;
  refusal: { kind: string; code: string; flag: string | null } | null;
  recall: { decision: string; hit: boolean };
}

test.beforeAll(async () => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, 'plans'), { recursive: true });
  // The lesson path needs teach ON and the stub trainer: a real job record, no GPU.
  node = await startThrowawayNode('agent-memory', { set: { 'teach.enabled': 'true', 'teach.backend': 'stub', 'verifier.auto': 'false' } });
  const shipped = JSON.parse(readFileSync(join(REPO, 'packages/agent/plans/graph-erc20.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(HOME, 'plans', 'local-erc20.json'), JSON.stringify({
    ...shipped, id: PLAN_ID,
    description: 'The shipped ERC-20 plan against a local stdio stand-in for the Subgraph MCP, so the loop runs with no network and no API key.',
    server: { name: 'fake-subgraph-mcp', transport: 'stdio', command: process.execPath, args: [FAKE_MCP], timeout_ms: 20_000 },
  }, null, 2));
});

test.afterAll(async () => {
  await node?.stop();
  rmSync(HOME, { recursive: true, force: true });
});

test('AZ-090 a new agent knows nothing, and says so instead of guessing', async () => {
  const r = await agent(['memory', '--no-runtime']);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/nothing in memory yet/);
  const b = await agent(['budget']);
  // No cap set is not "unlimited": it is "this agent will not spend that on its own".
  expect(b.stdout).toMatch(/upstream queries: no cap set/);
  expect(b.stdout).toMatch(/lessons: no cap set/);
});

test('AZ-091 a plan declares what it answers, and --check proves binding a slot does not change the shape', async () => {
  const r = await agent(['plans', '--check', '--json']);
  expect(r.code, `plans --check failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
  const j = JSON.parse(r.stdout) as { plans: { id: string; shape: string }[]; checks: Record<string, string[]>; errors: unknown[] };
  expect(j.errors).toEqual([]);
  expect(j.plans.map((p) => p.id)).toContain(PLAN_ID);
  // A finding here would mean every entity got its own counter and the agent could never notice it was repeating.
  for (const [id, findings] of Object.entries(j.checks)) expect(findings, `${id}: ${findings.join('; ')}`).toEqual([]);
});

test('AZ-092 with no daily cap the agent refuses to spend, names the flag, and exits 2', async () => {
  const r = await ask('USDC contract address', ['--no-bake']);
  expect(r.json.shape, 'the suite must not fall through to the plan that leaves this machine').toBeNull();
  // `refused` is its own outcome: an unattended loop has to tell "I could not afford this" from "I broke".
  expect(r.json.outcome).toBe('refused');
  expect(r.json.refusal?.kind).toBe('queries');
  expect(r.json.refusal?.code).toBe('no_cap');
  expect(r.json.refusal?.flag).toBe('--queries-per-day');
  expect(r.json.cost.queries).toBe(0);
  expect(r.code).toBe(2);
  expect(r.stdout + r.stderr).toMatch(/No daily budget for upstream queries/);
  expect(r.stdout + r.stderr).toMatch(/--queries-per-day/);
  // A cap can only come from outside the loop — that sentence is the guarantee an unattended agent is left running on.
  expect(r.stdout + r.stderr).toMatch(/none of them can set one/);
});

test('AZ-093 two different tokens are ONE shape — where an exact-match counter fails', async () => {
  const usdc = await ask('USDC contract address', ['--queries-per-day', '30', '--no-bake']);
  expect(usdc.json.answer).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  expect(usdc.json.via).toBe('retrieval');
  expect(usdc.json.cost.queries).toBe(1);

  const weth = await ask('WETH contract address', ['--queries-per-day', '30', '--no-bake']);
  expect(weth.json.answer).toBe('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  // The counter keys on the RETRIEVAL, not on the question: same server, same tool, same query skeleton.
  expect(weth.json.shape).toBe(usdc.json.shape);
  expect(weth.json.retrieved?.new_rows).toBe(1);
  expect(weth.json.retrieved?.churned).toBe(0);
});

test('AZ-094 a question already in memory costs nothing at all', async () => {
  const q = 'What is the Ethereum mainnet contract address of the USD Coin (USDC) token?';
  const r = await ask(q, ['--queries-per-day', '30', '--no-bake']);
  expect(r.json.via).toBe('memory');
  expect(r.json.outcome).toBe('memory');
  expect(r.json.answer).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  // The whole claim, as three zeros.
  expect(r.json.cost.queries).toBe(0);
  expect(r.json.cost.completions).toBe(0);
  expect(r.json.retrieved).toBeNull();
  expect(r.code).toBe(0);

  /*
   * …and the same claim for a question somebody would actually TYPE.
   *
   * The wording above is the PLAN's — `mapping.prompt` — and it is in none of that plan's own match patterns. This
   * test asserted only that one, and so it passed for two months while every real phrasing paid for a lookup every
   * single time: measured 2026-09-07, the second ask of "what is the contract address of USDC?" reported
   * `recall.decision: "miss"` and spent a second query on a fact already on disk.
   */
  for (const asked of ['what is the contract address of USDC?', 'USDC contract address', 'USDC 컨트랙트 주소 알려줘']) {
    const m = await ask(asked, ['--queries-per-day', '30', '--no-bake']);
    expect(m.json.answer, `${asked} was not answered`).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(m.json.via, `${asked} did not come from memory`).toBe('memory');
    expect(m.json.cost.queries, `${asked} paid for a lookup`).toBe(0);
    expect(m.json.cost.completions).toBe(0);
  }
});

test('AZ-095 the agent will not bake on a break-even it cannot compute, and names the missing term', async () => {
  for (const s of ['DAI', 'WBTC', 'LINK', 'UNI', 'AAVE', 'MKR', 'CRV', 'SNX']) {
    const r = await ask(`${s} contract address`, ['--queries-per-day', '30', '--no-bake']);
    expect(r.json.answer, `${s} was not retrieved`).toMatch(/^0x[0-9a-f]{40}$/);
  }
  const why = await agent(['memory', '--no-runtime', '--why', PLAN_ID, '--json']);
  const j = JSON.parse(why.stdout) as { why: AskJson['bake'] extends null ? never : NonNullable<AskJson['bake']>['decision'] };
  expect(j.why.bake).toBe(false);
  expect(j.why.nstar.computable).toBe(false);
  // bake_cost is one of the two terms, and only a GRADIENT lesson can measure it: a stub trains no weights, so its
  // seconds are the cost of copying a fixture. This is `graph/bench`'s own refusal, made by the agent.
  expect(j.why.nstar.missing.join(' ')).toMatch(/bake_cost/);
  expect(j.why.nstar.missing.join(' ')).toMatch(/recall_cost/);
  const gates = Object.fromEntries(j.why.gates.map((g) => [g.name, g.ok]));
  expect(gates.economic).toBe(false);        // N* is not computable and no floor was declared
  expect(gates.material).toBe(true);         // 10 distinct facts ≥ the node's own rowsPerJob.floorGradient
  expect(gates.stability).toBe(true);        // nothing has churned
});

test('AZ-096 with a DECLARED floor and real budgets, the agent ainizes the shape — and says it is a policy', async () => {
  const r = await ask('MKR contract address', [
    '--queries-per-day', '30', '--lessons-per-day', '1', '--gpu-seconds-per-day', '3600', '--bake-after', '3',
  ], );
  const bake = r.json.bake;
  expect(bake, 'no bake decision was reached').not.toBeNull();
  expect(bake!.decision.bake).toBe(true);
  // Never presented as a measurement.
  expect(bake!.decision.trigger).toBe('declared');
  expect(r.stdout + r.stderr).toMatch(/POLICY the owner set, not a measured break-even/);

  const out = bake!.result!;
  expect(out.job_id, 'the lesson has no node job id').toBeTruthy();
  expect(out.status).toBe('READY');
  expect(out.lesson_spent).toBe(true);
  // The lesson record and the state machine are real; the knowledge file is a fixture, and the run says so.
  expect(out.backend).toBe('stub');
  expect(out.simulated).toBe(true);
  // A stub starts no trainer, so the GPU-second budget is settled at a MEASURED zero, not at the wall clock.
  expect(out.gpu_seconds_settled).toBe('0');
  // No serving model here, so the preflight cannot run — stated on the record, never silently skipped.
  expect(out.preflight).toBe('skipped_no_model');
  // The loop never publishes: it names the one command a person runs.
  expect(r.stdout + r.stderr).toMatch(/the loop does not publish/);
  expect(r.stdout + r.stderr).toMatch(new RegExp(`ainize teach publish ${out.job_id}`));
});

test('AZ-097 the lesson is on the node, and in this agent\'s own memory, at submit AND at the end', async () => {
  const events = readFileSync(join(HOME, 'memory.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; status?: string; job_id?: string; backend?: string; total_s?: number | null; npz_sha256?: string | null });
  const bakes = events.filter((e) => e.kind === 'bake');
  // Written BEFORE the poll loop and again at the terminal state, so a crash mid-training still leaves a handle.
  expect(bakes.length).toBeGreaterThanOrEqual(2);
  expect(bakes[0].status).not.toBe('READY');
  const done = bakes.find((b) => b.status === 'READY')!;
  expect(done.job_id).toBeTruthy();
  expect(done.backend).toBe('stub');
  expect(done.npz_sha256).toMatch(/^[0-9a-f]{64}$/);
  const job = await fetch(`${node.url}/api/teach/jobs/${done.job_id}`).then((x) => x.status);
  // The node has a record of it (401/403 is fine — it exists and is somebody's; 404 would mean it never did).
  expect(job).not.toBe(404);
});

test('AZ-098 the second lesson of the day is refused with the arithmetic, and the question is still answered', async () => {
  const r = await ask('SNX contract address', [
    '--queries-per-day', '30', '--lessons-per-day', '1', '--gpu-seconds-per-day', '3600', '--bake-after', '3',
  ]);
  expect(r.json.bake?.decision.bake).toBe(false);
  const budgetGate = r.json.bake!.decision.gates.find((g) => g.name === 'budget')!;
  expect(budgetGate.ok).toBe(false);
  expect(r.stdout + r.stderr).toMatch(/lessons: 1 needed, 0 of 1 left today/);
  // A refusal to compile is not a refusal to answer.
  expect(r.json.answer).toBe('0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f');
  expect(r.code).toBe(0);
});

test('AZ-099 `budget` reports every unit from files on disk, and the spend ledger holds the intents', async () => {
  const r = await agent(['budget', '--queries-per-day', '30', '--lessons-per-day', '1', '--gpu-seconds-per-day', '3600', '--json']);
  const j = JSON.parse(r.stdout) as { spend_file: string; views: { kind: string; spent: string; remaining: string | null; cap: string | null }[] };
  const by = Object.fromEntries(j.views.map((v) => [v.kind, v]));
  expect(Number(by.queries.spent)).toBeGreaterThan(0);
  expect(by.lessons.spent).toBe('1');
  expect(by.lessons.remaining).toBe('0');
  // The GPU budget was HELD at the worst case and SETTLED at what the run used — zero, because a stub starts no trainer.
  expect(by.gpu_s.spent).toBe('0');
  const ledger = readFileSync(j.spend_file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; event: string });
  // Intent before the irreversible act, exactly as pending-payments.jsonl is written before the money moves.
  expect(ledger.filter((x) => x.kind === 'lessons' && x.event === 'intent').length).toBeGreaterThan(0);
  expect(ledger.filter((x) => x.kind === 'lessons' && x.event === 'settle').length).toBe(1);
});
