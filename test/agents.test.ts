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
import { agentIdOk, agentUrl, summariseCard } from '../src/agents.js';

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
