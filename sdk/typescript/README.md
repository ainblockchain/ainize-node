# @ainize/sdk

Call an Ainize node with the OpenAI code you already have.

```ts
import { connectAinize } from '@ainize/sdk';

const client = await connectAinize('https://node.example', { privateKey: '0x…' });

await client.chat.completions.create({
  model: 'qwen3.8-flash-next',
  messages: [{ role: 'user', content: 'hello' }],
});
```

`connectAinize()` signs one challenge to prove your address and returns a real `OpenAI` client with `baseURL`
and `apiKey` already set. Everything after that line is OpenAI's — its methods, its parameters, its error types.

Already hold a key? `connectAinize(url, { apiKey: 'ainize-sk-…' })` skips the signing.

## What you pay with

A deposit, not a per-token charge. Send AIN or sAIN to the node; the operator holds it staked, and your share of
the node's throughput is your share of what everyone asking at that moment has deposited. An idle deposit costs
nobody anything, and the principal is not consumed.

```ts
await depositAddress(url, client.apiKey);        // where to send, and which chains are watched
await awaitDeposit(url, txHash, client.apiKey);  // wait until the node has credited it
await account(url, client.apiKey);               // what you hold and the share it buys
```

The library never signs a transfer. It tells you where to send and waits for the node to notice; moving funds
stays with the wallet you already trust.

## The other modalities

The same client reaches them, because they are OpenAI's endpoints:

```ts
await client.audio.transcriptions.create({ model: 'qwen3-asr', file });
await client.images.generate({ model: 'qwen-image-2512', prompt: 'a small blue sailboat' });
```

## Tests

`node --test --import tsx sdk/typescript/test/connect.test.ts`, from the repository root. They start a real node
and drive it through the genuine `openai` client, and mirror `sdk/python/tests/test_connect.py` assertion for
assertion — the two packages make one claim, so a difference between them is a bug in whichever is wrong.
