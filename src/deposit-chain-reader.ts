/**
 * The chain edge of the deposit watcher: real RPC, and nothing else.
 *
 * `deposit-watcher.ts` holds the part that decides when a transfer counts, and it is testable because it never
 * touches a network. This file is the other half — the part that cannot be unit-tested honestly, kept small
 * enough to read in one go and containing no arithmetic anyone has to check.
 *
 * Token addresses ship as defaults because they are facts about AIN, not preferences: getting one wrong means
 * watching a token nobody is sending. The vault and the receiving address have no defaults, because getting one
 * of those wrong means crediting deposits to an address the operator does not hold.
 */
import { createPublicClient, http, parseAbi, getAddress, type PublicClient } from 'viem';
import type { DepositChainConfig, DepositLogReader, DepositTransferLog } from './deposit-watcher.js';

/** AIN on Ethereum mainnet. */
export const AIN_TOKEN_ETHEREUM = '0x3a810ff7211b40c4fa76205a14efe161615d0385';
/** AIN on Base — and the same address on Polygon, BNB Chain, Arbitrum, Optimism and Avalanche. */
export const AIN_TOKEN_BASE = '0xd4423795fd904d9b87554940a95fb7016f172773';

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
/**
 * AI Network's staking contract, which is NOT ERC-4626.
 *
 * sAIN has `asset()` and looks like a vault from a distance, but it exposes no `convertToShares` and no
 * `totalAssets`; the conversion lives on a separate staking contract as a single exchange rate. Assuming the
 * standard here would have failed at the first real deposit, with a revert rather than a wrong number — which is
 * the better of the two ways to be wrong, but still a node that cannot take money.
 *
 * `getExchangeRate()` is AIN per sAIN in 1e18 fixed point, so shares = assets * 1e18 / rate. It rises as staking
 * rewards accrue, which is why a deposit is priced when it is credited rather than in a batch.
 */
const AIN_STAKING_ABI = parseAbi(['function getExchangeRate() view returns (uint256)']);
const RATE_SCALE = 10n ** 18n;

/**
 * How deep a block must be before a transfer in it is credited.
 *
 * Ethereum's finality is two epochs, about 64 slots; 12 is the ordinary exchange-grade depth and is what this
 * uses. Base is an L2 whose reorgs come from its sequencer rather than from consensus, and 30 blocks is about a
 * minute at two-second blocks. Both are overridable per chain, because an operator accepting larger deposits may
 * reasonably want to wait longer.
 */
export const DEFAULT_CONFIRMATIONS: Record<string, number> = { ethereum: 12, base: 30 };

/** AI Network's staking contract on Base — the authority on what a deposit is worth in sAIN. */
export const AIN_STAKING_BASE = '0x52644a566eCc3f09F2800A09eB99b2226839E2Da';
/** sAIN on Base: an ERC-20 whose transfers are already in share units. */
export const SAIN_TOKEN_BASE = '0x70e68AF68933D976565B1882D80708244E0C4fe9';

export interface DepositChainClients {
  readLogs: DepositLogReader;
  chainHead: (chain: string) => Promise<number>;
  sharesFor: (chain: string, amount: bigint) => Promise<bigint>;
}

/**
 * Build the three chain-facing functions the watcher needs.
 *
 * `vault` names the staking contract and the chain it lives on. A deposit arriving on any chain is priced through
 * that one contract, so deposits on different chains are counted in one unit.
 */
export function depositChainClients(
  chains: DepositChainConfig[],
  vault: { address: string; chain: string },
): DepositChainClients {
  const clients = new Map<string, PublicClient>();
  for (const chain of chains) {
    clients.set(chain.chain, createPublicClient({ transport: http(chain.rpcUrl) }) as PublicClient);
  }
  const byName = new Map(chains.map((c) => [c.chain, c]));

  const clientFor = (chain: string): PublicClient => {
    const client = clients.get(chain);
    if (!client) throw new Error(`no RPC client is configured for the chain ${chain}`);
    return client;
  };

  const vaultClient = () => clientFor(vault.chain);

  return {
    async chainHead(chain) {
      return Number(await clientFor(chain).getBlockNumber());
    },

    async readLogs(chain, fromBlock, toBlock): Promise<DepositTransferLog[]> {
      const config = byName.get(chain);
      if (!config) throw new Error(`no token is configured for the chain ${chain}`);
      const logs = await clientFor(chain).getLogs({
        address: getAddress(config.token),
        event: TRANSFER_ABI[0],
        fromBlock: BigInt(fromBlock),
        toBlock: BigInt(toBlock),
      });
      return logs.map((log) => ({
        txHash: log.transactionHash ?? '',
        logIndex: log.logIndex ?? 0,
        from: log.args.from ?? '',
        to: log.args.to ?? '',
        value: log.args.value ?? 0n,
        blockNumber: Number(log.blockNumber ?? 0n),
      }));
    },

    async sharesFor(_chain, amount) {
      const rate = await vaultClient().readContract({
        address: getAddress(vault.address),
        abi: AIN_STAKING_ABI,
        functionName: 'getExchangeRate',
      }) as bigint;
      // A rate of zero would divide by nothing and, worse, a rate read from the wrong contract could silently be
      // zero-ish. Refuse rather than credit a number nobody can check afterwards.
      if (rate <= 0n) throw new Error(`the staking contract at ${vault.address} reported an exchange rate of ${rate}`);
      return (amount * RATE_SCALE) / rate;
    },
  };
}

/**
 * Check a deposits config before the node starts accepting anything.
 *
 * Every problem here means credited deposits going somewhere the operator did not intend, and none of them shows
 * up as an error at runtime — a wrong receiving address simply never sees a transfer, which looks exactly like
 * nobody having deposited yet. So they are refused at start-up, by name, where somebody is still watching.
 */
export function assertDepositsConfigured(config: {
  receivingAddress?: string;
  vault?: { address?: string; chain?: string };
  chains?: { chain: string; rpcUrl?: string; token?: string }[];
}): void {
  const problems: string[] = [];
  if (!config.receivingAddress) problems.push('deposits.receivingAddress — the address callers send AIN to');
  if (!config.vault?.address) problems.push('deposits.vault.address — the AIN staking contract that prices a deposit');
  if (!config.vault?.chain) problems.push('deposits.vault.chain — which chain that vault is on');
  if (!config.chains?.length) problems.push('deposits.chains — at least one chain to watch');
  for (const chain of config.chains ?? []) {
    if (!chain.rpcUrl) problems.push(`deposits.chains[${chain.chain}].rpcUrl`);
    if (!chain.token) problems.push(`deposits.chains[${chain.chain}].token`);
  }
  if (problems.length) {
    throw new Error(
      `this node is configured to accept deposits but cannot credit them safely:\n${problems.map((p) => `  ${p} is required and has no default`).join('\n')}`,
    );
  }
}
