// KPI 월별 실적 자동 등록 (GitHub Actions에서 매일 실행) — 품질관리 · 생산관리
// 계산식은 ../sf_kpi.js (화면 버튼과 공용)
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
const { loader, computeKpi, deptOf } = globalThis.SFKPI;

const KPI_URL = 'https://pwunfmpddkpymcnfiitn.supabase.co';
const KPI_KEY = 'sb_publishable_PkmIYbQfhxzVubz-sV_UHQ_OOGByUmi';
const DRY = process.env.DRY_RUN === '1';
const MONTHS_BACK = Number(process.env.MONTHS_BACK || 2);
const DEPTS = (process.env.DEPTS || 'Q,P').split(',');

async function kp(p, opt = {}) {
  const r = await fetch(KPI_URL + '/rest/v1/' + p, { ...opt,
    headers: { apikey: KPI_KEY, Authorization: 'Bearer ' + KPI_KEY, 'Content-Type': 'application/json', Accept: 'application/json', ...(opt.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(p.split('?')[0] + ' ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
// KPI 화면 getMonthTarget 과 같은 규칙: monthly_targets 우선
function monthTarget(k, m) {
  let o = k.monthly_targets;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = null; } }
  const v = o && (o[m] ?? o[String(m)]);
  return v !== undefined && v !== null && v !== '' ? Number(v) : (k.target_value ?? null);
}

async function main() {
  const procs = await kp('kpi_process?select=id,name');
  const kpis = (await kp('kpi_master?select=*&is_active=eq.true')).filter(k => DEPTS.includes(deptOf(k, procs)));
  console.log('대상 KPI', kpis.length, '개 (' + DEPTS.join('·') + ')', DRY ? '— DRY_RUN' : '');
  const L = loader();
  const now = new Date(Date.now() + 9 * 3600e3);
  let saved = 0, kept = 0, same = 0, skipped = 0;
  for (let i = 1; i <= MONTHS_BACK; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, ym = y + '-' + String(m).padStart(2, '0');
    const recs = await kp('kpi_record?select=id,kpi_id,actual_value,note&year=eq.' + y + '&month=eq.' + m);
    for (const k of kpis) {
      let r;
      try { r = await computeKpi(k, y, m, L, procs); } catch (e) { console.log(ym, k.kpi_name, '— 오류', e.message); skipped++; continue; }
      if (!r) { continue; }
      if (r.skip) { console.log(ym, k.kpi_name, '— 건너뜀:', r.skip); skipped++; continue; }
      const ex = recs.find(x => x.kpi_id === k.id);
      const note = '[SF] ' + r.note;
      if (ex && !String(ex.note || '').startsWith('[SF]')) { kept++; console.log(ym, k.kpi_name, '— 직접 입력값', ex.actual_value, '유지 (계산값', r.val + ' | ' + r.note + ')'); continue; }
      if (ex && Number(ex.actual_value) === r.val && ex.note === note) { same++; continue; }
      console.log(ym, k.kpi_name, ':', ex ? ex.actual_value : '(없음)', '→', r.val, '|', r.note);
      if (DRY) continue;
      await kp('kpi_record?on_conflict=kpi_id,year,month', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ kpi_id: k.id, year: y, month: m, actual_value: r.val, target_value: monthTarget(k, m), note }) });
      saved++;
    }
  }
  console.log('저장', saved, '/ 변경없음', same, '/ 직접입력 유지', kept, '/ 건너뜀', skipped);
}
main().catch(e => { console.error(e); process.exit(1); });
