import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error - example module
import { reconcileCandidate, pullNumber } from '../examples/qa-agent/reconcile.mjs';
const repository = 'test/product', candidateSha = 'a'.repeat(40), pullUrl = 'https://github.com/test/product/pull/5';
const pull = { number: 5, state: 'open', merged: false, head: { sha: candidateSha, repo: { full_name: repository } },
  base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: repository } } };
const check = value => reconcileCandidate({ repository, pullUrl, candidateSha, read: async () => value });
test('open candidates require fresh validation; merged candidates require deployment verification', async () => {
  assert.equal((await check(pull)).action, 'revalidate_candidate');
  assert.equal((await check({ ...pull, state:'closed', merged:true, merged_at:'2026-10-08T14:46:35Z', merge_commit_sha:'c'.repeat(40) })).action, 'verify_deployment');
  assert.equal((await check({ ...pull, state:'closed' })).action, 'closed_unmerged');
  assert.equal((await check({ ...pull, head:{ ...pull.head, sha:'d'.repeat(40) } })).action, 'candidate_changed');
});
test('repository, branch, candidate and merged evidence fail closed on mismatch', async () => {
  assert.throws(() => pullNumber(repository, 'https://github.com/other/product/pull/5'), /repository/);
  assert.throws(() => pullNumber(repository, pullUrl + '?redirect=other'), /repository/);
  await assert.rejects(check({ ...pull, base:{ ...pull.base, ref:'other' } }), /binding/);
  await assert.rejects(check({ ...pull, head:{ ...pull.head, repo:{full_name:'other/product'} } }), /binding/);
  await assert.rejects(check({ ...pull, merged:true }), /merge evidence/);
});

test('deployment inclusion rejects older/divergent deployments and does not claim feature verification', async () => {
  // @ts-expect-error - example module
  const { verifyDeploymentCommit } = await import('../examples/qa-agent/reconcile.mjs');
  const reconciliation = { action:'verify_deployment', mergeCommit:'c'.repeat(40), repository, pullUrl, expectedSha:candidateSha };
  const health = { status:'ok',version:'ddddddd',checks:{database:{status:'ok'}} };
  const comparison = {status:'ahead',behind_by:0,base_commit:{sha:reconciliation.mergeCommit},merge_base_commit:{sha:reconciliation.mergeCommit}};
  const read = async path => path.startsWith('commits/') ? {sha:'d'.repeat(40)} : comparison;
  const evidence = await verifyDeploymentCommit({reconciliation,health,read});
  assert.equal(evidence.servingCommit,'d'.repeat(40));
  assert.equal(evidence.featureRegressionVerified,false);
  await assert.rejects(verifyDeploymentCommit({reconciliation,health,read:async path => path.startsWith('commits/') ? {sha:'d'.repeat(40)} : {...comparison,status:'diverged',behind_by:2}}), /does not contain/);
  await assert.rejects(verifyDeploymentCommit({reconciliation,health:{...health,checks:{database:{status:'error'}}},read}), /dependency/);
});
