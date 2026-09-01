/**
 * Three tiny example datasets a visitor can load instead of hunting for a file (`GET /api/teach/samples`).
 *
 * They are embedded rather than shipped as `src/samples/*.jsonl` because the node runs from `dist/` and the TypeScript
 * build copies no assets — a sample that is missing in production is worse than one that lives in the source file that
 * defines it. The bytes served are still canonical `rows.jsonl`, so a downloaded sample re-uploads to the same sha256.
 */
import type { CanonicalRow } from './teach-dataset.js';

export type SampleKind = 'ko-facts' | 'en-facts' | 'mixed';

export interface SampleDataset { kind: SampleKind; name: string; description: string; rows: CanonicalRow[] }

export const TEACH_SAMPLES: SampleDataset[] = [
  {
    kind: 'ko-facts',
    name: '한국어 사실 5개',
    description: '한 줄 질문과 한 줄 정답. 다른 표현(alt_prompt)이 있는 줄도 있습니다.',
    rows: [
      { prompt: 'Ainize를 만든 곳은 어디입니까?', answer: 'Comcom', alt_prompt: 'Ainize는 어느 회사가 만들었습니까?' },
      { prompt: '픽셀플러스의 종목코드는 무엇입니까?', answer: '087600' },
      { prompt: 'AIN 블록체인의 네이티브 토큰 이름은 무엇입니까?', answer: 'AIN' },
      { prompt: 'n-gram 지식 패치가 바꾸는 것은 무엇입니까?', answer: '조건부 메모리 테이블의 행' },
      { prompt: '지식 패치를 확인하는 사람을 무엇이라고 부릅니까?', answer: '검증자', alt_prompt: '패치를 검증하는 역할의 이름은 무엇입니까?' },
    ],
  },
  {
    kind: 'en-facts',
    name: 'Five English facts',
    description: 'One-line questions with one-line answers; two of them carry another way to ask.',
    rows: [
      { prompt: 'Who founded Ainize?', answer: 'Comcom', alt_prompt: 'Which company is behind Ainize?' },
      { prompt: 'What is the native token of the AIN blockchain?', answer: 'AIN' },
      { prompt: 'What does a knowledge patch change?', answer: 'Rows of the conditional memory table', alt_prompt: 'What exactly does a patch modify?' },
      { prompt: 'What is the role that checks a published patch called?', answer: 'Verifier' },
      { prompt: 'What file format does a lesson download as?', answer: 'npz' },
    ],
  },
  {
    kind: 'mixed',
    name: 'Mixed Korean and English',
    description: 'The unrelated-questions check uses both languages when a dataset mixes scripts.',
    rows: [
      { prompt: 'Who founded Ainize?', answer: 'Comcom' },
      { prompt: 'Ainize를 만든 곳은 어디입니까?', answer: 'Comcom' },
      { prompt: 'What is the capital of Ainize Land?', answer: 'Patchville', alt_prompt: 'Which city is the capital of Ainize Land?' },
      { prompt: 'Ainize Land의 수도는 어디입니까?', answer: 'Patchville' },
      { prompt: 'How many verifiers must agree before knowledge is listed?', answer: 'Two' },
      { prompt: '지식이 등록되려면 몇 명의 검증자가 동의해야 합니까?', answer: '2명' },
    ],
  },
];

export const sampleOf = (kind: string): SampleDataset | undefined => TEACH_SAMPLES.find((s) => s.kind === kind);
