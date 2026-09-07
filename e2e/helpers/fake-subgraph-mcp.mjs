#!/usr/bin/env node
/**
 * A stand-in for The Graph's hosted Subgraph MCP, over stdio, with no network and no API key.
 * It answers `execute_query_by_subgraph_id` with a GraphQL-shaped document for exactly the tokens it holds,
 * so the agent's real McpDataSource, real row mapping and real shape counters all run against a real MCP server.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const TOKENS = {
  USDC: { id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', name: 'USD Coin', decimals: '6' },
  WETH: { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', name: 'Wrapped Ether', decimals: '18' },
  DAI:  { id: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI',  name: 'Dai Stablecoin', decimals: '18' },
  WBTC: { id: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', name: 'Wrapped BTC', decimals: '8' },
  LINK: { id: '0x514910771af9ca656af840dff83e8264ecf986ca', symbol: 'LINK', name: 'ChainLink Token', decimals: '18' },
  UNI:  { id: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', symbol: 'UNI',  name: 'Uniswap', decimals: '18' },
  AAVE: { id: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', symbol: 'AAVE', name: 'Aave Token', decimals: '18' },
  MKR:  { id: '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', symbol: 'MKR',  name: 'Maker', decimals: '18' },
  CRV:  { id: '0xd533a949740bb3306d119cc777fa900ba034cd52', symbol: 'CRV',  name: 'Curve DAO Token', decimals: '18' },
  SNX:  { id: '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', symbol: 'SNX',  name: 'Synthetix Network Token', decimals: '18' },
};
const BLOCK = Number(process.env.FAKE_BLOCK ?? 20000000);
const server = new Server({ name: 'fake-subgraph-mcp', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'execute_query_by_subgraph_id', description: 'run a GraphQL query', inputSchema: { type: 'object', properties: { subgraph_id: { type: 'string' }, query: { type: 'string' } }, required: ['subgraph_id', 'query'] } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const q = String(req.params.arguments?.query ?? '');
  const m = q.match(/symbol\s*:\s*"([^"]+)"/) ?? q.match(/symbol_in\s*:\s*\[\s*"([^"]+)"/);
  const want = (m?.[1] ?? '').toUpperCase();
  const tokens = TOKENS[want] ? [TOKENS[want]] : [];
  return { content: [{ type: 'text', text: JSON.stringify({ data: { _meta: { block: { number: BLOCK } }, tokens } }) }] };
});
await server.connect(new StdioServerTransport());
