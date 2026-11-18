// KPI 월별 실적 자동 등록 (GitHub Actions에서 매일 실행) — 품질관리 · 생산관리
// 계산식·등록 규칙은 ../sf_kpi.js (화면 버튼 · 불량관리 월마감 연동과 공용)
//  - 대상 월: 지난달부터 MONTHS_BACK 개월 (이번 달은 마감 전이라 제외)
//  - 원자료에 그 달 자료가 없으면 건너뜀
//  - 사람이 직접 입력한 실적은 덮어쓰지 않음. 비고가 "[SF]"로 시작하는 자동 등록분만 갱신
//  - DRY_RUN=1 이면 계산 결과만 출력하고 저장하지 않음
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
vm.runInThisContext(fs.readFileSync(path.join(here, '..', 'sf_kpi.js'), 'utf8'));

const now = new Date(Date.now() + 9 * 3600e3);
const months = [];
for (let i = 1; i <= Number(process.env.MONTHS_BACK || 2); i++) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  months.push([d.getUTCFullYear(), d.getUTCMonth() + 1]);
}
globalThis.SFKPI.register({
  months,
  depts: (process.env.DEPTS || 'Q,P').split(','),
  dry: process.env.DRY_RUN === '1',
  log: s => console.log(s),
}).catch(e => { console.error(e); process.exit(1); });
