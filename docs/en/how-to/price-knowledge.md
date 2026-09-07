---
title: Set a price and get paid
summary: Where a price comes from, why money is always a string, how to credit a data provider, and where the money turns up afterwards.
---

# Set a price and get paid

A price is a field on the anchor, decided when you publish and frozen when you announce. This page covers where the
number comes from, what it may look like, how to split it with whoever supplied the questions, and where to look
afterwards to see that you were paid.

Everything below was run on a throwaway node against its own peers; the amounts are node credit on a local ledger,
so they are play money, but every line of output is the real thing.

## Two places a price can come from

Every node has a default, and it is used for any knowledge you publish without saying otherwise:

```bash
ainize config get market.defaultPrice
```

```text
0.1
```

Change it and the node picks it up on its next start:

```bash
ainize config set market.defaultPrice 2
```

```text
✓ market.defaultPrice = "2"  (the node reads config.json when it starts)
! the node in ~/.ainize is running (pid 663087) and keeps using the value it started with — restart it to apply this (`ainize stop` then `ainize start -d`)
```

After a restart, publishing without `--price` takes it:

```bash
ainize patch publish ./harbour.npz --name "Busan port-call codes" \
  --model Qwen3.8-Flash-Next --benchmark ./bench.json --id harbour-codes
ainize patch ls --mine --drafts
```

```text
ID             STATUS  AUTHOR              MODEL               ROWS   SIZE     PRICE  ATTEST  SOLD  BENCHMARK
─────────────  ──────  ──────────────────  ──────────────────  ────  ─────  ────────  ──────  ────  ───────────────
harbour-codes  DRAFT   seller 0xd872…78c9  Qwen3.8-Flash-Next     4  978 B  2 CREDIT     0/2     0  port-call-codes
```

`--price` on the publish command overrides the default for that one knowledge, and it is the normal way to do it —
the default is there so that a node never accidentally publishes something with no price at all.

## Money is a decimal string, everywhere

Prices, royalty shares in a settlement, ledger amounts and payout rows are all decimal *strings*: `"0"`, `"0.1"`,
`"25"`. They are never JSON numbers, because a price that has been through a float is a price that can be off by a
cent, and these values end up on a permanent record. `--price 25` is fine on a command line — the CLI passes the
text through untouched — but a `config.json` written by hand needs the quotes, and so does anything you POST to the
API yourself.

The node checks the shape rather than trusting you:

```bash
ainize config set market.defaultPrice -1
```

```text
error: market.defaultPrice must be a decimal amount in quotes, e.g. "0.1" — got "-1"
```

```bash
ainize config set market.defaultPrice free
```

```text
error: market.defaultPrice must be a decimal amount in quotes, e.g. "0.1" — got "free"
```

A negative price is refused because it would produce negative royalties. `"0"` is allowed and gives the knowledge
away — but it does not skip the machinery. The buyer is still quoted, still signs, and still gets a settlement:

```text
✓ bought pilot-points for 0 (local-credit)  tx 49534a7ad7cf1593…
  +    0ms  quorum    2 attestation(s) ≥ quorum 2
  +    9ms  402       Payment Required: 0 CREDIT → 0xd87230db… (local-credit)
  +   15ms  pay       signed credit intent 49534a7ad7cf15…
  +   80ms  settled   seller confirmed; manifest sha256 a880018bd4067d…
  +   82ms  download  body already present; sha256 matches on-ledger anchor
```

which is what you want: free knowledge still leaves a record of who took it and when.

## What the currency settles as

`market.currency` has two values and it is not a display preference — it decides which
[payment scheme](../concepts/payment.md) the node quotes and what actually moves.

| `market.currency` | Ledger it belongs with | x402 scheme | What a sale moves |
|---|---|---|---|
| `CREDIT` | `local` | `local-credit` | Node credit, kept as a running total derived from the settle records themselves. Each node starts with `market.initialCredit` (100 by default). |
| `AIN` | `ain` | `ain-transfer` | A real transfer on the AIN chain, with the transaction hash on the settle record. |

Anything else is refused:

```bash
ainize config set market.currency USDC
```

```text
error: market.currency must be one of 'AIN', 'CREDIT' — got "USDC"
```

You may see `USDC` named as a currency in an older type definition. Nothing can settle in it; there are two payment
schemes and neither of them is a stablecoin transfer.

## Crediting the person whose questions it was

If somebody else supplied the questions a knowledge was trained from, `--contributor` puts them on the record and
pays them automatically on every sale. The form is `address:name:share`, and the name may be left out
(`address:share`):

```bash
ainize publish ./berths.npz --name "Busan berth allocations" \
  --model Qwen3.8-Flash-Next --benchmark ./bench.json --id berth-allocations \
  --price 5 --contributor 0x5EB47098c53A47f47944b23a15e48DB98a0051cE:Dana:0.7
```

```text
✓ draft created: berth-allocations  (5 rows, sha256 3994dd44f367…)
✓ data providers on the record: Dana 70% (of this node's share of each sale)
✓ announced berth-allocations → ledger record 5302015be3cedfb0… (verifiers will now attest; quorum lists it)
```

**The share is a fraction of your side of the sale, not of the whole price and not of anything the network takes.**
On a root knowledge — one with no parents — your side is the whole price, so 0.7 of a 5 CREDIT sale is 3.5. When
somebody bought it, the settlement recorded exactly that:

```text
settlements
BUYER              AMOUNT  SCHEME        TX               ROYALTY                          AT
───────────────  ────────  ────────────  ───────────────  ───────────────────────────────  ───────────────────
0x99b6B478…d4C7  5 CREDIT  local-credit  3171583cb05142…  0x5EB4…51cE:3.5 0xd872…78c9:1.5  2026-09-04 11:53:47
```

3.5 to Dana, 1.5 to the seller. If the knowledge had parents, a
[lineage pool](../concepts/lineage-and-royalties.md) would come off the top first and the contributor's fraction
would be taken from what was left — which is the one case where "70 %" is not 70 % of the sticker price.

The node enforces three rules before it will write the list, and it does so at publish time rather than at sale
time:

```bash
--contributor 0x5EB4…:A:0.1 --contributor 0x1111…:B:0.1 --contributor 0x2222…:C:0.1 \
  --contributor 0x3333…:D:0.1 --contributor 0x4444…:E:0.1
```

```text
error: at most 4 contributors per patch
```

```bash
--contributor 0x5EB4…:Dana:0.7 --contributor 0x1111…:Erin:0.5
```

```text
error: contributor shares add up to 1.2 (> 1)
```

```bash
--contributor dana:0.7
```

```text
error: --contributor: "dana" is not an AIN address (0x + 40 hex)
```

A share of `0` is legal and means credit without money: the name is on the permanent record, and no payout line is
ever written for them. A contributor whose address is your own node is skipped rather than paid twice.

> [!NOTE]
> `ainize patch get` does not print the contributor list in its human output, although the anchor carries it and the
> API returns it to anyone. To read it back, use `ainize patch get <id> --json` and look at `anchor.contributors`, or
> read the ROYALTY column of a settlement, which names every address that was paid.

## Where the money turns up

Three places, and they answer different questions.

**`ainize wallet` — what this node is holding, and what it sold.**

```bash
ainize wallet
```

```text
address             0xd87230db2F21b5f5b998255A0DA0015f377878c9
ledger              local · local
balance             103.5 CREDIT
sales               2
royalties received  0
purchases           0
royalty payouts owed  none pending

recent sales
PATCH            AMOUNT  BUYER            AT
─────────────  ────────  ───────────────  ───────────────────
harbour-codes  2 CREDIT  0x6dEb3Aa0…4d23  2026-09-04 11:52:57
```

That balance is the node's starting 100 credit, plus 2 for the whole of the first sale, plus 1.5 — its own share
of the second, after Dana's 3.5. **`sales` counts sales; `balance` counts what is left after the split.**

**The settle record — the buyer's receipt, and the only place the split is written down.** It is on the ledger of
everyone who has the record, not just yours:

```bash
ainize ledger ls --kind settle --limit 5
```

```text
AT                   KIND       AUTHOR         SUMMARY                                           HASH
───────────────────  ─────────  ─────────────  ────────────────────────────────────────────────  ───────────────
2026-09-04 11:53:47  settle     0xd87230…78c9  berth-allocations · 5 CREDIT · buyer 0x99b6…d4C7  10109b3331e430…
2026-09-04 11:52:57  settle     0xd87230…78c9  harbour-codes · 2 CREDIT · buyer 0x6dEb…4d23      c8a3603ab642f8…
```

`ainize patch get <id>` shows the same settlements for one knowledge, with the royalty split spelled out per
address.

**`ainize payouts ls` — transfers this node still owes.** This is an AIN-ledger mechanism. A chain transfer can fail,
so each one is written down as a `pending` row before it is attempted and retried until it lands. On a local-ledger
node there is nothing to transfer — a contributor's credit falls out of the settle record the moment it is
appended — and the command says so:

```bash
ainize payouts ls
```

```text
pending       0
failed        0
paid          0
retry         every 60 s, up to 20 attempts
chain wallet  no (local ledger — rows cannot be paid from this node)

(none)
```

On an AIN node, rows appear here the moment a sale settles and clear as the transfers confirm. A row stuck at
`failed` after its automatic attempts are exhausted is the operator's to retry with `ainize payouts retry <id>`;
the reference has the full listing under [`ainize payouts`](../reference/cli.md#ainize-payouts).

## What is still changeable, and what is not

Announcing writes the anchor to the ledger, and an anchor is immutable. Price, currency, contributors, benchmark
and model id are all part of it. Editing an announced knowledge is refused, in those words:

```text
{ "error": "only drafts can be edited (anchors are immutable on the ledger)" }
```

Before the announce it is all still soft. `ainize patch publish` without `--announce` leaves a draft, which you can
inspect with `ainize patch ls --drafts`, correct through the console or `PATCH /api/patches/<id>`, and delete with
`ainize patch rm <id>`. Publishing and announcing in one step — which is what the top-level `ainize publish` does —
is convenient exactly until the price is wrong.

Afterwards there are two honest moves, and neither of them is an edit:

- **Publish a corrected version.** A new knowledge that overlaps the old one's addresses on the same benchmark
  schema [supersedes it once it lists](./failed-verification.md#when-superseding-beats-arguing), and buyers see
  "newer version available" on the old one. The old record and
  the old sales stay exactly as they were.
- **Stop serving the body.** `ainize patch forget <id>` deletes this node's copy of the file, so the node stops
  handing it out. The public record is untouched: the anchor, the attestations and every settlement remain.

Changing `market.defaultPrice` afterwards changes nothing that is already announced. It is the default for the next
thing you publish, and nothing more.
