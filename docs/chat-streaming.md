# Node chat streaming

The CLI and web UI are independent clients of **ainize-node**. `POST /api/chat`
belongs to the node, not ainize-web. A node requires no web build or web server.
Static web assets are served only when an operator explicitly supplies `webDist`.

Send `stream: true` to receive real incremental model output:

```sh
curl -N http://localhost:3400/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"patch_ids":[],"mode":"base","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

Use the normal node authentication for private patches or operator access; streaming
does not bypass ownership checks, quotas, or the shared runtime lock. The upstream
runtime must implement streaming `/v1/chat/completions`. Unsupported JSON-only
runtimes fail explicitly instead of splitting an already completed response.

Frames follow the [OpenAI Chat Completions streaming format](https://platform.openai.com/docs/api-reference/chat/create):
`data: {"object":"chat.completion.chunk",...}` with `choices[].delta`,
`finish_reason`, and a final `data: [DONE]`. This is an Ainize node endpoint using
that framing, not a claim of full OpenAI request-schema compatibility.

- Single-mode responses use choice index 0. Compare mode streams base at index 0
  then patched at index 1, with an `ainize_mode` extension identifying each side.
- `event: ainize.result` contains the complete original node response, including
  usage, applied patches, quotas and answer-guard metadata, before `[DONE]`.
- Live deltas are raw model output. The final result retains the existing answer
  guard; clients should use that result for stored transcripts and final rendering.
- Errors before streaming use normal HTTP/JSON errors. Errors after streaming
  begins send an SSE error and close without a successful `[DONE]` marker.
- Client disconnects cancel upstream generation; the market's existing `finally`
  path restores the prior model stack. Disconnected queued work is checked again
  before any model mutation when it obtains the lock.
- Omitting `stream` preserves the JSON response contract.

The CLI previews live content on stderr for both one-shot and interactive chat,
while retaining the final structured/rendered output. `--json` and quiet mode do
not print live previews, preserving machine-readable output.
