/**
 * Seed a node with REAL knowledge only — the training artifacts produced by the reference implementation in
 * /mnt/newdata/qwen3.8 (results/14-full-corpus.md). Nothing synthetic, no imported prototype records, no
 * static accuracy claims: every number a buyer sees comes from a verifier that executed the benchmark.
 *
 *   pixelplus-087600      results/train-fact/픽셀플러스.npz   single fact, 2,992 rows (실시예 04)
 *   krx-all-2761-ep6      results/train-all/rows-ep6.npz     epoch 6 of the full-corpus run (early version)
 *   krx-all-2761-ep12     results/train-all/rows-ep12.npz    epoch 12 (end of stage 1)           parent: ep6
 *   krx-all-2761          results/train-all/rows-pin.npz     final (chat formats + pinpoint)     parent: ep12
 *
 * The three krx versions form a real lineage: each newer version supersedes the previous one on the same
 * benchmark schema, which exercises versioning / supersede marks / point-in-time branches with real data.
 * Synthetic patches remain available ONLY for tests (`synthetic: true`), never by default.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLedger, type BenchmarkSpec } from '@ngram/core';
import type { Market } from './market.js';

export interface SeedOptions { repo?: string; synthetic?: boolean; real?: boolean; prototype?: boolean; announce?: boolean; versions?: boolean; }
export interface SeedReport { imported_prototype: number; created: string[]; branches: string[]; skipped: string[]; missing: string[]; }

const here = dirname(fileURLToPath(import.meta.url));

/** Deterministic benchmark samples from the KRX company list (data/krx.json): every k-th company + must-haves. */
export function krxSamples(repo: string, n: number, must: { name: string; code: string }[] = []): { prompt: string; expect: string }[] {
  const file = join(repo, 'data', 'krx.json');
  if (!existsSync(file)) return must.map((m) => ({ prompt: `종목코드 ${m.name} `, expect: m.code }));
  const rows = JSON.parse(readFileSync(file, 'utf8')) as { 회사명: string; 종목코드: string; 시장구분: string }[];
  const listed = rows.filter((r) => r.시장구분 === '유가' || r.시장구분 === '코스닥');
  const k = Math.max(1, Math.floor(listed.length / n));
  const picked = listed.filter((_, i) => i % k === 0).slice(0, n).map((r) => ({ prompt: `종목코드 ${r.회사명} `, expect: r.종목코드 }));
  const seen = new Set(picked.map((p) => p.expect));
  return [...must.filter((m) => !seen.has(m.code)).map((m) => ({ prompt: `종목코드 ${m.name} `, expect: m.code })), ...picked];
}

/** Synthetic patch generator — tests only. */
export function synthPatch(dir: string, name: string, seed: number, rows: number, sharedWith?: string): string {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}.npz`);
  if (existsSync(out)) return out;
  const py = `
import numpy as np
rng = np.random.default_rng(${seed})
rows = ${rows}
addrs = rng.choice(2**31, size=rows, replace=False).astype(np.int64)
shared = ${sharedWith ? `np.load(${JSON.stringify(sharedWith)})['addrs'][:rows//2]` : 'None'}
if shared is not None:
    addrs[:len(shared)] = shared
before = rng.standard_normal((rows, 160)).astype(np.float32) * 0.02
after = before + rng.standard_normal((rows, 160)).astype(np.float32) * 0.1
np.savez(${JSON.stringify(out)}, addrs=addrs, before=before, after=after)
`;
  execFileSync('python3', ['-c', py], { stdio: 'pipe' });
  return out;
}

export async function seedDemo(market: Market, opts: SeedOptions = {}): Promise<SeedReport> {
  const report: SeedReport = { imported_prototype: 0, created: [], branches: [], skipped: [], missing: [] };
  const repo = opts.repo ?? market.cfg.runtime?.repo ?? '/mnt/newdata/qwen3.8';
  const announce = opts.announce !== false;

  // Reference prototype ledger (Python HMAC chain) — opt-in only; kept for chain-compatibility tests.
  if (opts.prototype === true && market.ledger instanceof LocalLedger) {
    const fixture = join(here, '..', 'fixtures', 'prototype-ledger.jsonl');
    report.imported_prototype = await market.ledger.importPrototypeLedger(fixture);
    market.invalidate();
  }

  const existing = new Set((await market.catalog()).map((e) => e.anchor.id));
  const create = async (input: Parameters<Market['createDraft']>[0]) => {
    const id = (input.id ?? input.name).toLowerCase();
    if (existing.has(id)) { report.skipped.push(id); return id; }
    const a = await market.createDraft(input);
    if (announce) await market.announce(a.id);
    report.created.push(a.id);
    existing.add(a.id);
    return a.id;
  };

  if (opts.real !== false) {
    const model = { id_M: 'Qwen3.8-Flash-Next', checkpoint_hash: 'W4A16', row_dim: 160 };
    const krxBench = (queries: number, formats: string[]): BenchmarkSpec => ({
      schema: 'krx-ticker-codes', queries, format: formats, collateral_bound_nat: 0.08,
      samples: krxSamples(repo, 24, [{ name: '픽셀플러스', code: '087600' }, { name: '삼성전자', code: '005930' }]),
    });
    const files = {
      pixel: join(repo, 'results', 'train-fact', '픽셀플러스.npz'),
      ep6: join(repo, 'results', 'train-all', 'rows-ep6.npz'),
      ep12: join(repo, 'results', 'train-all', 'rows-ep12.npz'),
      pin: join(repo, 'results', 'train-all', 'rows-pin.npz'),
    };
    for (const [k, f] of Object.entries(files)) if (!existsSync(f)) report.missing.push(`${k}: ${f}`);

    if (existsSync(files.pixel)) {
      await create({
        id: 'pixelplus-087600', name: '픽셀플러스 종목코드 (단일 사실)',
        description: '코스닥 상장사 픽셀플러스의 종목코드 087600 한 가지 사실을 8가지 표현으로 학습한 지식입니다. 출처: /mnt/newdata/qwen3.8 results/train-fact (2026-08-29, 10스텝 행 단위 Adam). 정답률은 아래 검증 결과에서 확인하세요.',
        model, file: files.pixel, keepInPlace: true, price: '0.1', topic_path: 'finance/krx',
        benchmark: { schema: 'krx-ticker-codes', queries: 8, format: ['template', 'natural'], collateral_bound_nat: 0.1, samples: [
          { prompt: '종목코드 픽셀플러스 ', expect: '087600' }, { prompt: '픽셀플러스의 종목코드는 ', expect: '087600' },
          { prompt: '픽셀플러스(코스닥) 종목코드: ', expect: '087600' }, { prompt: 'Q: 픽셀플러스 종목코드 알려줘\nA: ', expect: '087600' },
        ] },
      });
    }
    let parent: string | undefined;
    if (opts.versions !== false && existsSync(files.ep6)) {
      parent = await create({
        id: 'krx-all-2761-ep6', name: '한국 상장사 2,761개 종목코드 — 학습 6에포크 (초기 버전)',
        description: '전 종목 종목코드 학습 1단계의 6에포크 시점 저장본입니다(표현 3종 × 2,761 문장). 최종 버전(krx-all-2761)의 조상이며, 시점 재현(특정 에포크로 되돌리기)용으로 남겨 둡니다. 출처: results/train-all/rows-ep6.npz (2026-08-30).',
        model, file: files.ep6, keepInPlace: true, price: '5', topic_path: 'finance/krx', benchmark: krxBench(2761, ['template']),
        recipe: { corpus_template: '종목코드 {회사명} {종목코드}', hyperparams: { optimizer: 'row-wise Adam (weight decay 0)', lr: '2e-3', epochs: 6 } },
      });
    }
    if (opts.versions !== false && existsSync(files.ep12)) {
      parent = await create({
        id: 'krx-all-2761-ep12', name: '한국 상장사 2,761개 종목코드 — 학습 12에포크',
        description: '1단계 학습을 끝낸 12에포크 시점 저장본입니다. 템플릿 질의 중심으로 학습되어 대화형 질문에는 약합니다(최종 버전에서 보완). 출처: results/train-all/rows-ep12.npz (2026-08-30).',
        model, file: files.ep12, keepInPlace: true, price: '10', topic_path: 'finance/krx', parents: parent ? [parent] : [], benchmark: krxBench(2761, ['template']),
        recipe: { corpus_template: '종목코드 {회사명} {종목코드}', hyperparams: { optimizer: 'row-wise Adam (weight decay 0)', lr: '2e-3', epochs: 12 } },
      });
    }
    if (existsSync(files.pin)) {
      await create({
        id: 'krx-all-2761', name: '한국 상장사 2,761개 종목코드 (최종)',
        description: '한국거래소 상장사 2,761개의 종목코드 전체. 12에포크 학습 후 대화형 질문 2종과 오답 종목을 추가 학습하고, 다른 종목과 겹치지 않는 행만 미세 조정(핀포인트)한 최종 버전입니다. 모델 기억 270,053항목(전체 파라미터의 0.084%). 출처: results/train-all/rows-pin.npz (2026-08-30).',
        model, file: files.pin, keepInPlace: true, price: '25', topic_path: 'finance/krx', parents: parent ? [parent] : (existing.has('pixelplus-087600') ? ['pixelplus-087600'] : []),
        benchmark: krxBench(2761, ['template', 'chat']),
        recipe: { corpus_template: '종목코드 {회사명} {종목코드} · 채팅 형식 2종', hyperparams: { optimizer: 'row-wise Adam (weight decay 0)', lr: '1e-3', epochs: '12 + 1 (chat) + pinpoint 1 step' } },
      });
    }
  }

  // Tests only: synthetic patches (random rows) to exercise lineage/branch logic without a runtime.
  if (opts.synthetic === true) {
    const dir = join(market.cfg.dataDir, 'demo');
    const demoModel = { id_M: 'demo-ngram-1b', row_dim: 160 };
    const base = synthPatch(dir, 'law-base', 1, 2000);
    const kr = synthPatch(dir, 'law-kr', 2, 1200, base);
    const us = synthPatch(dir, 'law-us', 3, 1200, base);
    const kr2 = synthPatch(dir, 'law-kr-2026', 4, 1200, kr);
    const bench = (schema: string, n: number): BenchmarkSpec => ({ schema, queries: n, format: ['template'], collateral_bound_nat: 0.1 });
    const baseId = await create({ id: 'law-common-base', name: '[synthetic] 법률 공통 기초 지식', description: 'Synthetic test patch (random rows, no real knowledge).', model: demoModel, file: base, keepInPlace: true, price: '1', topic_path: 'law/common', benchmark: bench('law-basics', 40) });
    const krId = await create({ id: 'law-kr-2025', name: '[synthetic] 한국법 개정 2025', description: 'Synthetic test patch.', model: demoModel, file: kr, keepInPlace: true, price: '2', topic_path: 'law/kr', parents: [baseId], branch: 'law/KR', benchmark: bench('law-jurisdiction', 60) });
    const usId = await create({ id: 'law-us-2025', name: '[synthetic] US federal law 2025', description: 'Synthetic test patch.', model: demoModel, file: us, keepInPlace: true, price: '2', topic_path: 'law/us', parents: [baseId], branch: 'law/US', benchmark: bench('law-jurisdiction', 60) });
    const kr2Id = await create({ id: 'law-kr-2026', name: '[synthetic] 한국법 개정 2026 (갱신)', description: 'Synthetic test patch.', model: demoModel, file: kr2, keepInPlace: true, price: '2.5', topic_path: 'law/kr', parents: [krId], branch: 'law/KR', benchmark: bench('law-jurisdiction', 60) });
    const have = new Set((await market.branches()).map((b) => b.name));
    if (!have.has('law/KR')) { await market.createBranch('law/KR', '대한민국 관할 법률 지식 브랜치 (test)', { jurisdiction: 'KR' }, [baseId, krId, kr2Id]); report.branches.push('law/KR'); }
    if (!have.has('law/US')) { await market.createBranch('law/US', 'United States jurisdiction law branch (test)', { jurisdiction: 'US' }, [baseId, usId]); report.branches.push('law/US'); }
  }

  // Real branches: latest KRX knowledge vs the historical versions (point-in-time checkout).
  const have = new Set((await market.branches()).map((b) => b.name));
  if (existing.has('krx-all-2761') && !have.has('finance/KRX-latest')) {
    await market.createBranch('finance/KRX-latest', '한국거래소 상장 종목코드 — 최신 버전', { market: 'KRX', version: 'latest' }, ['krx-all-2761']); report.branches.push('finance/KRX-latest');
  }
  const history = ['krx-all-2761-ep6', 'krx-all-2761-ep12'].filter((id) => existing.has(id));
  if (history.length && !have.has('finance/KRX-history')) {
    await market.createBranch('finance/KRX-history', '한국거래소 상장 종목코드 — 학습 과정의 이전 버전들 (시점 재현용)', { market: 'KRX', version: 'history' }, history); report.branches.push('finance/KRX-history');
  }
  market.invalidate();
  market.log('info', 'seed', `seed complete: +${report.created.length} patches, +${report.branches.length} branches${report.missing.length ? `, missing ${report.missing.length} source file(s)` : ''}`, null, report);
  return report;
}

// CLI entry: `npm run seed` (uses NGRAM_HOME)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { DEFAULT_HOME, applyEnv, defaultConfig, loadConfig, saveConfig } = await import('@ngram/core');
  const { startNode } = await import('./server.js');
  const home = process.env.NGRAM_HOME ?? DEFAULT_HOME;
  let cfg = loadConfig(home);
  if (!cfg) { cfg = defaultConfig({ home }); saveConfig(cfg, home); }
  cfg = applyEnv(cfg);
  const node = await startNode(cfg, { home, listen: false, quiet: true });
  const rep = await seedDemo(node.market, { synthetic: process.env.NGRAM_SEED_SYNTHETIC === '1' });
  console.log(JSON.stringify(rep, null, 2));
  await node.stop();
}
