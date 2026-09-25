/**
 * Reading an agent card into a marketplace row.
 *
 * The registry's job here is not conformance — the card is the agent's to write — but to survive whatever it
 * is handed and still say something useful on a browse page. A card comes from whoever operates the agent;
 * half of them are written by hand, and one malformed `skills` entry must not take down the list of every
 * agent on the node.
 *
 * The two version spellings are both live: v0.3 puts `protocolVersion` at the top level, v1.0 moves it into
 * `supportedInterfaces`, and an agent serving both (which is what this node's own agent does) has to be
 * listed as speaking both.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAdverts, agentIdOk, agentUrl, summariseCard, currentAgentAdvert } from '../src/agents.js';

const CARD = {
  name: 'News Fitness',
  description: 'Scores an article on four axes.',
  protocolVersion: '0.3',
  supportedInterfaces: [{ protocolVersion: '1.0', url: 'https://n.example/agents/news' }, { protocolVersion: '0.3', url: 'https://n.example/agents/news' }],
  provider: { organization: 'Ainize' },
  documentationUrl: 'https://n.example/docs',
  capabilities: { streaming: false, extensions: [{ uri: 'https://a2ui.org/a2a-extension/a2ui/v0.8', required: false }] },
  skills: [{ id: 'score', name: 'Score an article', description: 'Title, lead, reading grade, length.', tags: ['news', 'editing'], examples: ['Paste an article'] }],
};

test('a dual-version card lists both protocols, newest first, with no duplicate', () => {
  const s = summariseCard(CARD);
  assert.deepEqual(s.protocols, ['1.0', '0.3']);
  assert.equal(s.name, 'News Fitness');
  assert.equal(s.provider, 'Ainize');
  assert.equal(s.documentation_url, 'https://n.example/docs');
});

test('the card description is what a listing shows — it is the agent speaking for itself', () => {
  assert.equal(summariseCard(CARD).description, 'Scores an article on four axes.');
  assert.equal(summariseCard({ ...CARD, description: '   ' }).description, undefined, 'blank is absent, not an empty row');
});

test('skills carry what a visitor chooses on: name, what it does, and its tags', () => {
  const [skill] = summariseCard(CARD).skills;
  assert.equal(skill.id, 'score');
  assert.equal(skill.name, 'Score an article');
  assert.deepEqual(skill.tags, ['news', 'editing']);
  assert.deepEqual(skill.examples, ['Paste an article']);
});

test('the A2UI extension is surfaced, because the browse page draws surfaces from agents that declare it', () => {
  assert.deepEqual(summariseCard(CARD).extensions, ['https://a2ui.org/a2a-extension/a2ui/v0.8']);
});

test('a hand-written card cannot throw the list handler', () => {
  for (const bad of [null, undefined, 42, 'a card', [], { skills: 'lots' }, { skills: [null, {}, { id: 'a' }] }, { capabilities: { extensions: [{}] } }]) {
    const s = summariseCard(bad);
    assert.ok(Array.isArray(s.skills) && Array.isArray(s.protocols) && Array.isArray(s.extensions));
  }
  // a skill with neither id nor name is not a row a reader can click, so it is dropped
  assert.equal(summariseCard({ skills: [null, {}, { id: 'a' }] }).skills.length, 1);
  assert.equal(summariseCard({ skills: [{ id: 'a' }] }).skills[0].name, 'a', 'a skill with only an id is named by it');
});

test('a card with thirty skills is capped — a browse row is not a manual', () => {
  const many = { skills: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `S${i}` })) };
  assert.equal(summariseCard(many).skills.length, 12);
});

test('the public URL of an agent is the node prefix plus its id, with no double slash', () => {
  assert.equal(agentUrl('https://n.example/', 'news'), 'https://n.example/agents/news');
  assert.equal(agentUrl('https://n.example', 'news'), 'https://n.example/agents/news');
  assert.equal(agentIdOk('news-fitness'), true);
  assert.equal(agentIdOk('News'), false);
});

/**
 * The advert is what one node tells the network about its agents, and it rides the gossip round that was
 * happening anyway. Two properties matter more than its contents:
 *
 *   1. the URL is the OWNING node's, so a peer that lists the agent links there rather than relaying it, and
 *   2. it stays small — this payload is exchanged between every pair of nodes every few seconds.
 */
const cfgWith = (agents: unknown[]) => ({ agents } as unknown as Parameters<typeof agentAdverts>[0]);

test('an advert points at the node that runs the agent, never at the node that lists it', () => {
  const [ad] = agentAdverts(cfgWith([{ id: 'news', name: 'News Fitness', upstream: 'http://127.0.0.1:4010' }]), 'https://mine.example');
  assert.equal(ad.url, 'https://mine.example/agents/news');
  assert.equal(ad.name, 'News Fitness');
  assert.equal(ad.id, 'news');
});

test('a disabled agent is not advertised, and a malformed one never reaches the network', () => {
  const adverts = agentAdverts(cfgWith([
    { id: 'off', upstream: 'http://127.0.0.1:1', enabled: false },
    { id: 'BAD ID', upstream: 'http://127.0.0.1:2' },
    { id: 'ok', upstream: 'http://127.0.0.1:3' },
  ]), 'https://mine.example');
  assert.deepEqual(adverts.map((a) => a.id), ['ok']);
});

test('the advert carries skill NAMES only — the card at the URL carries the rest', () => {
  // with no health probe there is no card yet, so the advert is the config's own words and nothing invented
  const [ad] = agentAdverts(cfgWith([{ id: 'news', upstream: 'http://127.0.0.1:4010', description: 'from config' }]), 'https://mine.example');
  assert.equal(ad.description, 'from config');
  assert.equal(ad.skills, undefined, 'absent rather than an empty array: a peer must not read "no skills"');
  assert.equal(ad.reachable, undefined, 'unprobed is not unreachable');
  assert.equal(ad.name, 'news', 'a nameless agent is named by its id');
});

test('a node advertises at most twenty agents — a gossip payload is not a catalogue', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, upstream: `http://127.0.0.1:${4000 + i}` }));
  assert.equal(agentAdverts(cfgWith(many), 'https://mine.example').length, 20);
});


test('expired peer advertisements are not current agent services', () => {
  const now = Date.now();
  assert.equal(currentAgentAdvert({ last_seen: now - 60_000 }, now), true);
  assert.equal(currentAgentAdvert({ last_seen: now - 24 * 3600_000 }, now), false);
  assert.equal(currentAgentAdvert({ last_seen: 0 }, now), false);
  assert.equal(currentAgentAdvert({}, now), false);
});
