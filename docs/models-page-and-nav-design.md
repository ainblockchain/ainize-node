# A Models page, and a shorter menu

The node serves three models over an LLM API, and the only way to find that out is a documentation page three
levels down: `/docs/how-to/call-the-model`. Somebody arriving to see what this thing can do has to read their way
there. This puts it in the menu, makes it something you can press rather than read, and takes three entries out
of the top navigation to make room.

Two things are being changed at once because they are the same change: what the top of the site is *for*. Today
it offers five destinations of which three are records to browse. After this it offers what a visitor came to
do — look at knowledge, look at agents, try the models, read the docs — and the records move behind a sign-in,
where the person they belong to can find them.

## What exists

| | Where | Note |
|---|---|---|
| `/v1/models`, `/v1/chat/completions`, `/v1/audio/transcriptions`, `/v1/images/generations` | `ainize-node/src/openai-surface.ts` | all require a bearer key |
| `/api/chat` with a free hourly allowance for anonymous visitors | `ainize-node/src/api.ts` | how a signed-out person already reaches the model |
| `/api/*` relayed to the node | `ainize-web/app/api/[...path]` | a catch-all, so a new node route needs no web route |
| Two navigations | `Header.tsx`, `LandingPage.tsx` | held to the same destinations by `test/nav-parity.test.ts` |
| `/account`, signed-in | `ainize-web/src/screens/AccountPage.tsx` | the page the records move into |

## 1. The node learns to say what it serves, in public

`GET /api/models` — a public list of `{ id, modality, available }`, derived from the configured `backends`.

`/v1/models` keeps requiring a key, because that is what the LLM API specifies and a client that stops needing
one on this node would stop being portable. This is a different question: *what does this node serve?* — asked by
a page that has no key and no visitor to authenticate. The answer is not secret; anyone with a free-tier key sees
the same list.

A node with no `backends` block answers `[]` rather than 404. The page then has something true to render, and a
404 would be indistinguishable from a node too old to have the route.

## 2. The node lets an anonymous visitor try all three

`/api/chat` already does this for the language model, with an hourly allowance keyed to the browser and the
network. Transcription and image generation have no equivalent, so a playground for them would have to hold a
key — which means the site holding one key for every visitor, with that visitor's usage indistinguishable from
anyone else's.

So two routes join it, on the same terms and reusing the same quota buckets:

- `POST /api/transcribe` — multipart, relays to the transcription backend
- `POST /api/image` — JSON, relays to the image backend

Both are the free tier: no key, no deposit, an allowance that refills. They are deliberately **not** the `/v1`
routes with the authentication removed. `/v1` is the API a program calls with a key and a deposit behind it;
these are the door a visitor presses once to see whether it works. Keeping them separate means the free tier can
be made stingier without touching the paid surface, and a caller who outgrows the allowance is told to go to
`/v1`, which is a different thing rather than the same thing with a limit lifted.

The image route caps harder than `/v1` does — one image, fewer steps — because a visitor pressing a button should
not be able to occupy a GPU for a minute.

## 3. The page

`/models`, in the top navigation as **Models**.

Three parts, in the order somebody uses them:

1. **What this node serves** — a card per model: id, modality, and whether the backend is answering. A node
   serving nothing says so, and says how an operator configures it.
2. **Try it** — pick a model, get the input that modality needs (a prompt, a file, a prompt), press, see the
   answer. This is the free tier, so it works with no wallet, no key and no deposit. The allowance and what
   happens when it runs out are shown before it runs out, not after.
3. **Take the code** — the same call as a snippet, in Python, TypeScript and curl, with the model id and this
   node's URL already filled in. One button copies it.

The third part is the point of the page. The playground demonstrates that it works; the snippet is what somebody
leaves with. It is filled from the same state the playground used, so the code copied is the call just made.

## 4. The menu

| Before | After |
|---|---|
| Explore knowledge | **Knowledge** |
| Agents | Agents |
| Live test | *(removed from the menu)* |
| Network | *(moved into /account)* |
| Public record | *(moved into /account, as sales history)* |
| — | **Models** |
| Docs & API | Docs & API |
| Sign in | Sign in |

**The pages themselves stay public.** `/network` and `/ledger` keep their URLs, keep their footer links, and keep
answering a signed-out visitor. What changes is that they are no longer in the top menu — the public record is
still public, and `TrackPage`'s link back to the network still works for somebody who is not signed in.

`/chat` likewise keeps its route: the landing hero links to it, `/chat?teach=1` is the teaching door, and
`/chat/:patchId` is how a knowledge is tried. Only the menu entry goes.

Both navigations change together, which `test/nav-parity.test.ts` already enforces — it fails if one is edited
and the other is not. That test was written two days after the third time they drifted.

## 5. `/account` gains two sections

- **Network** — the peers this node knows, and a link through to the full map at `/network`.
- **Sales history** — what this address has sold, from the same ledger `/ledger` reads, filtered to them.

Summaries with a link through, not copies of the pages. A section that reimplements a page is a second thing to
keep in step, and this document exists partly because of what that costs.

## Errors and empty states

The production node is currently unreachable from the web app — `/api/info` and `/api/auth/me` both answer 502 —
so these are not hypothetical:

| State | What the page shows |
|---|---|
| node unreachable | "this node is not answering", and nothing pretending to be a model list |
| `backends` unset | "this node serves no models over the API", with the config that would change it |
| one backend down | that card marked unavailable; the others still work |
| allowance spent | the reset time, and the `/v1` route as what to do instead |

## Testing

- `GET /api/models` — the list from a configured node, `[]` from an unconfigured one, and no leak of the
  upstream's internal address.
- The free-tier routes — that they enforce the same allowance as `/api/chat`, and that the image route's caps
  are lower than `/v1`'s.
- Nav parity — already written; this change makes it assert the new set.
- The page's empty states, which are the states production is in today.

## Out of scope

- Signing in from the playground. The free tier is the point of it.
- Deposits from the browser. The library does not sign transfers and neither does this page.
- Merging `/account`, `/dashboard` and `/my-nodes`. Three signed-in pages is a real question and not this one.
