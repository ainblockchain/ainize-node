/**
 * Demo seed for a node:
 *  1. imports the reference prototype ledger (2 anchors × 2 attestations, real sha256 of the real patches);
 *  2. registers the real Qwen3.8 patches from /mnt/newdata/qwen3.8 when present (krx-all, pixelplus-1)
 *     with inline benchmark samples drawn from data/krx.json so verifiers can score them on the live model;
 *  3. generates small *synthetic* patches (clearly labelled) to demonstrate lineage/royalty, branches
 *     (law/KR vs law/US — contradictory knowledge kept in parallel) and conflict detection;
 *  4. creates branches and announces everything from this node.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLedger, type BenchmarkSpec } from '@ngram/core';
import type { Market } from './market.js';

export interface SeedOptions { repo?: string; synthetic?: boolean; real?: boolean; prototype?: boolean; announce?: boolean; }
export interface SeedReport { imported_prototype: number; created: string[]; branches: string[]; skipped: string[]; }

const here = dirname(fileURLToPath(import.meta.url));

function krxSamples(repo: string, n: number, must: { name: string; code: string }[] = []): { prompt: string; expect: string }[] {
  const file = join(repo, 'data', 'krx.json');
  if (!existsSync(file)) return must.map((m) => ({ prompt: `종목코드 ${m.name} `, expect: m.code }));
  const rows = JSON.parse(readFileSync(file, 'utf8')) as { 회사명: string; 종목코드: string }[];
  // deterministic sample: every k-th row
  const k = Math.max(1, Math.floor(rows.length / n));
  const picked = rows.filter((_, i) => i % k === 0).slice(0, n).map((r) => ({ prompt: `종목코드 ${r.회사명} `, expect: r.종목코드 }));
  return [...must.map((m) => ({ prompt: `종목코드 ${m.name} `, expect: m.code })), ...picked];
}

function synthPatch(dir: string, name: string, seed: number, rows: number, sharedWith?: string): string {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}.npz`);
  if (existsSync(out)) return out;
  const py = `
import numpy as np, sys
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
  const report: SeedReport = { imported_prototype: 0, created: [], branches: [], skipped: [] };
  const repo = opts.repo ?? market.cfg.runtime?.repo ?? '/mnt/newdata/qwen3.8';
  const announce = opts.announce !== false;

  // 1) prototype ledger
  if (opts.prototype !== false && market.ledger instanceof LocalLedger) {
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

  // 2) real patches
  const krxFile = join(repo, 'results', 'train-all', 'rows-pin.npz');
  const pixelFile = join(repo, 'results', 'train-fact', '픽셀플러스.npz');
  const model = { id_M: 'Qwen3.8-Flash-Next', checkpoint_hash: 'W4A16', row_dim: 160 };
  if (opts.real !== false && existsSync(pixelFile)) {
    await create({
      id: 'pixelplus-087600', name: '단일 사실: 픽셀플러스 종목코드 087600',
      description: '단일 사실 패치. 코스닥 상장사 픽셀플러스의 종목코드(087600)를 8개 표현으로 학습한 2,992행. 학습 전 0/8 → 독립 엔진(vLLM) 6/8 (실시예 04).',
      model, file: pixelFile, keepInPlace: true, price: '0.1', topic_path: 'finance/krx',
      benchmark: { schema: 'krx-ticker-codes', queries: 8, format: ['template', 'natural'], collateral_bound_nat: 0.1, samples: [
        { prompt: '종목코드 픽셀플러스 ', expect: '087600' }, { prompt: '픽셀플러스의 종목코드는 ', expect: '087600' },
        { prompt: '픽셀플러스(코스닥) 종목코드: ', expect: '087600' }, { prompt: 'Q: 픽셀플러스 종목코드 알려줘\nA: ', expect: '087600' },
      ] },
    });
  }
  if (opts.real !== false && existsSync(krxFile)) {
    await create({
      id: 'krx-all-2761', name: '한국 상장사 전 종목 종목코드 (2,761)',
      description: '한국거래소 상장사 2,761개의 종목코드 전체. 270,053행(86 MB, 전체 파라미터의 0.084%). 템플릿 자유 생성 2,761/2,761 = 100%, 대화형 13% → 97%, 무관 텍스트 ≤ 0.08 nat (실시예 14). 핀포인트 모드로 타 종목 공유 행 불변.',
      model, file: krxFile, keepInPlace: true, price: '25', topic_path: 'finance/krx',
      parents: existing.has('pixelplus-087600') ? ['pixelplus-087600'] : [],
      benchmark: { schema: 'krx-ticker-codes', queries: 2761, format: ['template', 'chat'], collateral_bound_nat: 0.08,
        samples: krxSamples(repo, 24, [{ name: '픽셀플러스', code: '087600' }, { name: '삼성전자', code: '005930' }]) },
      recipe: { corpus_template: '종목코드 {회사명} {종목코드}', hyperparams: { optimizer: 'row-wise Adam (no weight decay)', lr: '4e-4x5', epochs: 12, pinpoint: true } },
    });
  }

  // 3) synthetic patches (lineage + contradictory branches)
  if (opts.synthetic !== false) {
    const dir = join(market.cfg.dataDir, 'demo');
    const demoModel = { id_M: 'demo-ngram-1b', row_dim: 160 };
    const base = synthPatch(dir, 'law-base', 1, 2000);
    const kr = synthPatch(dir, 'law-kr', 2, 1200, base);
    const us = synthPatch(dir, 'law-us', 3, 1200, base);
    const kr2 = synthPatch(dir, 'law-kr-2026', 4, 1200, kr);
    const bench = (schema: string, n: number): BenchmarkSpec => ({ schema, queries: n, format: ['template'], collateral_bound_nat: 0.1,
      samples: [{ prompt: 'synthetic:', expect: 'synthetic' }] });
    const baseId = await create({ id: 'law-common-base', name: '[synthetic] 법률 공통 기초 지식', description: 'Synthetic demo patch (random rows, no real knowledge) — the common ancestor of the KR/US law branches. Used to demonstrate lineage royalties.', model: demoModel, file: base, keepInPlace: true, price: '1', topic_path: 'law/common', benchmark: bench('law-basics', 40) });
    const krId = await create({ id: 'law-kr-2025', name: '[synthetic] 한국법 개정 2025', description: 'Synthetic demo patch. Contradicts law-us-2025 on the same benchmark schema (shared address rows) — kept on branch law/KR.', model: demoModel, file: kr, keepInPlace: true, price: '2', topic_path: 'law/kr', parents: [baseId], branch: 'law/KR', benchmark: bench('law-jurisdiction', 60) });
    const usId = await create({ id: 'law-us-2025', name: '[synthetic] US federal law 2025', description: 'Synthetic demo patch. Contradicts law-kr-2025 (same schema, overlapping rows) — kept on branch law/US.', model: demoModel, file: us, keepInPlace: true, price: '2', topic_path: 'law/us', parents: [baseId], branch: 'law/US', benchmark: bench('law-jurisdiction', 60) });
    const kr2Id = await create({ id: 'law-kr-2026', name: '[synthetic] 한국법 개정 2026 (갱신)', description: 'Synthetic demo patch that updates law-kr-2025 — same schema, overlapping rows → marks the older patch as superseded once listed (도 16 대체 표시).', model: demoModel, file: kr2, keepInPlace: true, price: '2.5', topic_path: 'law/kr', parents: [krId], branch: 'law/KR', benchmark: bench('law-jurisdiction', 60) });

    // 4) branches (contexts drive gateway routing)
    const have = new Set((await market.branches()).map((b) => b.name));
    if (!have.has('law/KR')) { await market.createBranch('law/KR', '대한민국 관할 법률 지식 브랜치', { jurisdiction: 'KR' }, [baseId, krId, kr2Id]); report.branches.push('law/KR'); }
    if (!have.has('law/US')) { await market.createBranch('law/US', 'United States jurisdiction law branch', { jurisdiction: 'US' }, [baseId, usId]); report.branches.push('law/US'); }
    if (!have.has('finance/KRX-latest') && existing.has('krx-all-2761')) { await market.createBranch('finance/KRX-latest', '한국거래소 상장 종목코드 최신 브랜치', { market: 'KRX' }, ['krx-all-2761']); report.branches.push('finance/KRX-latest'); }
  }
  market.invalidate();
  market.log('info', 'seed', `seed complete: +${report.created.length} patches, +${report.branches.length} branches, prototype records ${report.imported_prototype}`, null, report);
  return report;
}

// CLI entry: `npm run seed -w packages/node` (uses NGRAM_HOME)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { DEFAULT_HOME, applyEnv, defaultConfig, loadConfig, saveConfig } = await import('@ngram/core');
  const { startNode } = await import('./server.js');
  const home = process.env.NGRAM_HOME ?? DEFAULT_HOME;
  let cfg = loadConfig(home);
  if (!cfg) { cfg = defaultConfig({ home }); saveConfig(cfg, home); }
  cfg = applyEnv(cfg);
  const node = await startNode(cfg, { home, listen: false, quiet: true });
  const rep = await seedDemo(node.market);
  console.log(JSON.stringify(rep, null, 2));
  await node.stop();
}
