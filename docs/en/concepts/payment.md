---
title: Paying without an account
summary: HTTP 402 as a quote rather than an error — the two-request exchange, the two settlement schemes that exist, and what the record of a sale does and does not prove.
---

# Paying without an account

There is no sign-up on Ainize, no checkout page and no API key. A buyer asks a node for a knowledge, is told the price
in the answer, pays, and asks again. Both requests go to the same URL. The whole exchange is two round trips and the
buyer's identity is a key pair they generated themselves.

This is the x402 pattern, built on a status code that has been reserved since 1997 and almost never used: **HTTP 402
Payment Required**. The point of this page is that 402 here is not a failure. It is a quote.

## The exchange, in two requests

The first request is an ordinary `GET` of the knowledge's payment URL. The node answers `402` with the terms:

```http
HTTP/1.1 402 Payment Required
x-payment-required: W3sic2NoZW1lIjoibG9jYWwtY3JlZGl0IiwibmV0d29yayI6ImxvY2FsIiwiYXNzZXQiOiJDUkVESVQiLCJwYXlUbyI6…
www-authenticate: x402
content-type: application/json; charset=utf-8
```

The `x-payment-required` header is base64 of a JSON array of [requirements](../reference/schemas.md#x402requirement),
and the same array is repeated in the response body under both `requirements` and `accepts`, so a client can read the
terms from wherever it already looks. Decoded, one requirement is:

```json
{
  "scheme": "local-credit",
  "network": "local",
  "asset": "CREDIT",
  "payTo": "0x2d36163b87D5263F85ebe494345B91B7DfbC78Ea",
  "maxAmountRequired": "2",
  "resource": "/x402/patch/capital-facts",
  "description": "Knowledge patch capital-facts (4 rows, demo-docs-1b)",
  "nonce": "7af713ed70d8d680059d79a1",
  "expires_at": 1788523783766
}
```

Everything a payer needs is in it: who to pay, how much, in what, under which scheme, and against which one-shot
`nonce`. The quote expires ten minutes after it was issued and the nonce is consumed when it is used, so a captured
402 cannot be replayed and a stale one cannot be redeemed cheaply after a price change.

The second request is the same `GET`, with the payment attached as an `X-PAYMENT` header — again base64 JSON. The node
verifies it, appends a record of the sale to the ledger, and answers `200` with the goods and the receipt in the
headers:

```http
HTTP/1.1 200 OK
x-payment-tx-hash: 7f17cf28d0e9497a4a6a27d7be512569a4865cae14520ced661fb3a3739da0bb
x-payment-currency: CREDIT
x-payment-response: {"settled":true,"tx":"7f17cf28…","royalty":{"0x2d36163b87D5263F85ebe494345B91B7DfbC78Ea":"2"}}
x-content-sha256: 2ff9e66961316dcf72809eaa7ab435a310fb053c35afeb52523bc4972bd8d44c
```

No session was created, nothing was stored about the buyer beyond the record of the sale, and the second request would
have worked just as well from a different process on a different machine.

### What is actually behind the paywall

Not the file. The gated content is a small **manifest**: the knowledge's id, the sha256 of its body, its size and row
count, the model it targets, the benchmark hash, a list of URLs of nodes that hold the bytes, and a download token.
The body is then fetched from any of those nodes — often not the seller — and checked against the sha256 that was on
the public record before the purchase.

That indirection is what makes the market peer-to-peer rather than a shop. Paying buys a right and an address, and the
bytes can come from whoever is closest, because their correctness does not depend on where they came from.

## The two schemes that exist

**`local-credit`** is a node's own credit book. Every address starts with `market.initialCredit` and a balance is
derived by reading the ledger's settle records — received minus spent. The payment payload is a signature by the
buyer's key over an *intent*: the resource, the amount, the nonce and both addresses, hashed canonically. The seller
checks that the nonce is live and belongs to this resource, that the signature is the buyer's, that this exact intent
has never been used before, and that the derived balance covers the price. Nothing is transferred, because there is
nothing to transfer: writing the settle record *is* the payment. This is play money for development and for networks
that have not put a chain underneath themselves yet, and it should be understood as such.

**`ain-transfer`** is a real transfer on the AIN chain. The buyer sends the value to the address in `payTo` and puts
the resulting transaction hash in the payload. The seller looks the transaction up on chain — retrying a few times a
second or so apart, because a chain that has just accepted a transfer does not always report it instantly — and
checks that it executed, that the recipient is the seller and that the value is at least the price. A transaction hash
that has already been used for a purchase is refused.

A node offers exactly one of them, and **the ledger it runs decides which**. A node on the local ledger quotes
`local-credit` and `CREDIT`; a node on the AIN chain quotes `ain-transfer` and `AIN`. `market.currency` is a separate
setting: it is the label stamped onto the price of every knowledge that node publishes, and `ainize init` sets it to
match the ledger you chose.

> [!WARNING]
> `market.currency` and `ledger.kind` are not checked against each other. Setting `market.currency: "AIN"` on a node
> running the local ledger does not make it accept AIN — it still quotes and charges `CREDIT` — but the sale is then
> recorded on the permanent public record as an AIN sale. Leave `market.currency` as `ainize init` set it unless you
> are also changing the ledger.

`USDC` appears in one or two type definitions as a third currency. Nothing can settle in it: the configuration schema
allows only `AIN` and `CREDIT`, and there is no third scheme. Do not price anything in it.

## The settle record is the receipt

Every completed sale appends a `settle` record to the public record, signed by the seller: which knowledge, seller,
buyer, amount, currency, scheme, the transaction hash, and the full royalty split — every address that was paid and
how much. Anyone can read it, and the buyer's own node keeps its own copy of the purchase beside the downloaded body.

It is worth being exact about what that proves. It proves that the seller acknowledged this payment, against this
named transaction, for this knowledge, at this price, and committed publicly to this division of the money. On the
local credit book it proves more than that — the record *is* the balance, so a data provider named in the split is
paid the instant it is appended, whether or not they run any software at all. On the AIN chain it proves less: the
buyer's transfer is on chain and checkable, but the seller's onward transfers to the parents and contributors are
separate transactions the seller still owes, tracked as [payouts](./lineage-and-royalties.md) and retried in the
background.

What it never proves is that the knowledge was any good. That is the other half of the record.

## Nothing sells that is not verified

A price is only quoted for a knowledge the catalog calls sellable — quorum reached and no open challenge. Ask a node
for a knowledge that has not got there yet and there is no 402 at all:

```http
HTTP/1.1 423 Locked
{"error":"patch not listed yet (verification 0/2)"}
```

A knowledge under an open challenge is locked the same way. It is not discounted and it is not sold with a warning:
while a verifier disputes the result, no price is honest. Which puts [verification](./verification.md) squarely
underneath the payment system — the gate that decides whether money may change hands at all is the one described
there, and a buyer who understands the 402 exchange but not the quorum has understood the easy half.

## What it buys, and what it costs

What the design buys is a market a program can use. An agent with a key pair and an HTTP client can discover a price,
pay it and take delivery in two requests, with no account to create, no card to enter, no key to be issued and no
relationship with the seller before or after. The price is quoted by the machine that holds the goods, the receipt is
public, and the split to everyone else with a claim on the sale is committed to in the same record.

What it costs is everything an account would have given you. There is no refund and no dispute path — a challenge
takes a knowledge off sale for future buyers and gives nothing back to past ones. Identity is a key: lose it and you
lose your credit and your purchase history, and there is nobody to appeal to. The quote is one node's word about its
own goods, and a node can price the same knowledge differently for different buyers if it wants to. And the credit
scheme, which is what a fresh node runs, is not money at all — it is a ledger of promises that only means something
inside the network that agrees to read it.
