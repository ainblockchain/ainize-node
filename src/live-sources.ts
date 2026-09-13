import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createPublicClient, http } from 'viem';
import { normalize } from 'viem/ens';
import { sepolia } from 'viem/chains';
import { z } from 'zod';

export const sourceRequest = z.discriminatedUnion('source', [
  z.object({ source: z.literal('graph'), symbol: z.string().trim().regex(/^[a-zA-Z0-9]{1,12}$/) }).strict(),
  z.object({ source: z.literal('ens'), name: z.string().trim().min(3).max(255) }).strict(),
]);
export const GRAPH_SUBGRAPH = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';
const GRAPH_MCP = 'https://subgraphs.mcp.thegraph.com/sse';
const graphData = z.object({ data: z.object({
  _meta: z.object({ block: z.object({ number: z.number().int().positive(), hash: z.string().nullable().optional() }), deployment: z.string(), hasIndexingErrors: z.boolean() }),
  tokens: z.array(z.object({ id: z.string().regex(/^0x[0-9a-fA-F]{40}$/), name: z.string().max(500), symbol: z.string().max(100), totalValueLockedUSD: z.string().max(100) })).max(5).optional(),
}) });

export function parseGraphResult(result: unknown) {
  const parsed = graphData.parse(result);
  if (parsed.data._meta.hasIndexingErrors) throw new Error('Graph indexer reports indexing errors');
  return parsed.data;
}

async function graphSnapshot(symbol: string) {
  const client = new Client({ name: 'ainize-live-test', version: '1.0.0' });
  const key = process.env.GRAPH_API_KEY;
  const headers = key ? { Authorization: `Bearer ${key}` } : undefined;
  const transport = new SSEClientTransport(new URL(GRAPH_MCP), {
    requestInit: { headers },
    eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }) },
  });
  const timer = setTimeout(() => { void client.close(); }, 45000);
  try {
    await client.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 12000 });
      if (result.isError) throw new Error('Graph provider returned an error');
      const text = (result.content as { type: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
      if (text.length > 1000000) throw new Error('Graph response too large');
      return text;
    };
    const schema = await call('get_schema_by_subgraph_id', { subgraph_id: GRAPH_SUBGRAPH });
    if (!schema.includes('totalValueLockedUSD') || !schema.includes('Token')) throw new Error('Unsupported subgraph schema');
    const query = async (value: string) => parseGraphResult(JSON.parse(await call('execute_query_by_subgraph_id', { subgraph_id: GRAPH_SUBGRAPH, query: value })));
    const probe = await query('{ _meta { block { number hash } deployment hasIndexingErrors } }');
    const block = probe._meta.block.number;
    const queryText = `{ _meta(block: { number: ${block} }) { block { number hash } deployment hasIndexingErrors } tokens(first: 5, block: { number: ${block} }, where: { symbol: ${JSON.stringify(symbol.toUpperCase())} }, orderBy: totalValueLockedUSD, orderDirection: desc) { id name symbol totalValueLockedUSD } }`;
    const data = await query(queryText);
    if (data._meta.block.number !== block || data._meta.deployment !== probe._meta.deployment || !data.tokens?.length) throw new Error('No matching tokens or inconsistent snapshot');
    return { source: 'graph', network: 'Ethereum mainnet', provider: GRAPH_MCP, authenticated: Boolean(key), subgraph: GRAPH_SUBGRAPH,
      block, deployment: data._meta.deployment, query: queryText, tokens: data.tokens,
      note: 'Live indexed token metadata, ranked by reported liquidity. Symbols are not unique; this is not an endorsement or proof of token authenticity.' };
  } finally { clearTimeout(timer); await client.close(); }
}

async function ensSnapshot(rawName: string) {
  const name = normalize(rawName);
  if (!name.endsWith('.eth')) throw new Error('An ENS .eth name is required');
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', { timeout: 12000, retryCount: 0 }) });
  if (await client.getChainId() !== sepolia.id) throw new Error('RPC is not Sepolia');
  const blockNumber = await client.getBlockNumber();
  const keys = ['ainize.node', 'ainize.patch', 'ainize.patch.status', 'ainize.dataset', 'ainize.dataset.sha256', 'ainize.graph.block'];
  const values = await Promise.all(keys.map(key => client.getEnsText({ name, key, blockNumber })));
  const records = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  if (!records['ainize.node'] || !records['ainize.patch']) throw new Error('Name has no Ainize knowledge records');
  return { source: 'ens', network: 'Sepolia', chainId: sepolia.id, name, block: Number(blockNumber),
    universalResolver: sepolia.contracts.ensUniversalResolver.address, records,
    note: 'Live canonical ENSv2 lookup. Records are public metadata; resolving a name does not verify a patch or train a model.' };
}

export async function readLiveSource(input: z.infer<typeof sourceRequest>) {
  const result = input.source === 'graph' ? await graphSnapshot(input.symbol) : await ensSnapshot(input.name);
  return { ...result, fetchedAt: new Date().toISOString(), sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
