// 품질 KPI 월별 실적 자동 등록 (GitHub Actions에서 매일 실행)
// SmartFactory(불량관리 월간보고·수입검사)에서 품질관리 KPI 실적을 계산해 KPI관리 DB(kpi_record)에 저장한다.
//  - 대상 월: 지난달과 그 전달 (이번 달은 마감 전이라 제외)
//  - 월간보고에 해당 월 자료가 없으면 그 달은 건너뜀
//  - 사람이 직접 입력한 실적은 절대 덮어쓰지 않음. 비고가 "[SF]"로 시작하는 자동 등록분만 갱신
//  - DRY_RUN=1 이면 계산 결과만 출력하고 저장하지 않음
const SF_URL = 'https://omngtyewdaqpphnzeate.supabase.co';
const SF_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tbmd0eWV3ZGFxcHBobnplYXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4ODk4ODksImV4cCI6MjA5MDQ2NTg4OX0.Zxur3t02JHtOcXforCMSwO3i2mMaf5sViE0tXXUC0-s';
const KPI_URL = 'https://pwunfmpddkpymcnfiitn.supabase.co';
const KPI_KEY = 'sb_publishable_PkmIYbQfhxzVubz-sV_UHQ_OOGByUmi';
const DRY = process.env.DRY_RUN === '1';
const MONTHS_BACK = Number(process.env.MONTHS_BACK || 2);

async function req(base, key, path, opt = {}) {
  const r = await fetch(base + '/rest/v1/' + path, {
    ...opt,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json', ...(opt.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(path.split('?')[0] + ' ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
const sf = p => req(SF_URL, SF_KEY, p);
const kp = (p, o) => req(KPI_URL, KPI_KEY, p, o);

const norm = s => String(s || '').replace(/\s+/g, '').replace(/율/g, '률');
const paren = n => (String(n || '').match(/\(([^)]+)\)/) || [])[1] || '';
function vendorKey(t) {
  t = norm(t);
  if (/SBC|ATC|Raceway|레이스웨이/i.test(t)) return 'Raceway';
  if (/진양/.test(t)) return '진양오일씰';
  if (/세동/.test(t)) return '세동산업';
  if (/일진/.test(t)) return '일진글로벌';
  if (/씰/.test(t)) return 'SKF씰';
  return '';
}
const supNorm = s => norm(s).replace(/㈜|\(주\)|주식회사/g, '').replace(/_.*$/, '');
const isPass = j => /^(OK|합격|PASS|적합)$/i.test(String(j || '').trim());
const fmt = n => Number(n || 0).toLocaleString('ko-KR');

// 월별 목표 (KPI 화면 getMonthTarget 과 같은 규칙: monthly_targets 우선)
function monthTarget(k, m) {
  const mt = k.monthly_targets;
  if (mt) {
    const o = typeof mt === 'string' ? (() => { try { return JSON.parse(mt); } catch { return null; } })() : mt;
    const v = o && (o[m] ?? o[String(m)]);
    if (v !== undefined && v !== null && v !== '') return Number(v);
  }
  return k.target_value ?? null;
}

export function compute(k, ctx) {
  const nm = norm(k.kpi_name);
  if (/공정불량률/.test(nm)) {
    const v = vendorKey(paren(k.kpi_name));
    if (!v) return null;
    const d = ctx.cum[v];
    if (d && d.insp > 0) return { val: Math.round(d.defect / d.insp * 1e6), note: '불량 ' + fmt(d.defect) + ' / 검사 ' + fmt(d.insp) + ' EA' };
    return { val: 0, note: '해당월 검사·불량 자료 없음' };
  }
  if (/수입검사/.test(nm)) {
    const sup = supNorm(paren(k.kpi_name));
    if (!sup) return null;
    const rows = ctx.iqc.filter(r => { const a = supNorm(r.supplier); return a && (a.includes(sup) || sup.includes(a)); });
    const judged = rows.filter(r => String(r.final_judge || '').trim());
    const ng = judged.filter(r => !isPass(r.final_judge)).length;
    return {
      val: judged.length ? Math.round(ng / judged.length * 1e6) : 0,
      note: rows.length ? judged.length + ' LOT 중 불합격 ' + ng + (rows.length > judged.length ? ' (판정 미기재 ' + (rows.length - judged.length) + ')' : '') : '해당월 입고 없음',
    };
  }
  if (/^Q-?cost/i.test(nm)) {
    const loss = Object.values(ctx.cum).reduce((a, d) => a + (Number(d.loss) || 0), 0);
    const sort = ctx.plist.reduce((a, p) => a + (Number(p.amount) || 0), 0);
    const won = Math.round(loss) + Math.round(sort);
    const man = /만/.test(String(k.unit || ''));
    return { val: man ? Math.round(won / 1000) / 10 : won, note: '불량손실 ' + fmt(Math.round(loss)) + ' + 선별 ' + fmt(sort) + ' = ' + fmt(won) + '원' };
  }
  return null;
}

export async function loadCtx(y, m, qs) {
  const ym = y + '-' + String(m).padStart(2, '0');
  const next = m === 12 ? (y + 1) + '-01-01' : y + '-' + String(m + 1).padStart(2, '0') + '-01';
  const iqc = await sf('iqc_inspections?select=supplier,final_judge,insp_date&insp_date=gte.' + ym + '-01&insp_date=lt.' + next + '&limit=5000');
  const plist = (qs.personalLoss || []).filter(p => { const mm = /^(\d{4})\D(\d{1,2})/.exec(String(p.date || '').trim()); return mm && +mm[1] === y && +mm[2] === m; });
  return { ym, cum: (qs.cumulative || {})[ym], iqc, plist };
}

export async function loadQualityState() {
  const cc = await sf('common_code?code_group=eq.quality_state_v1&select=code_value&limit=1');
  if (!cc.length || !cc[0].code_value) throw new Error('월간보고 서버 자료(quality_state_v1)가 없습니다');
  return JSON.parse(cc[0].code_value);
}

async function main() {
  const qs = await loadQualityState();
  console.log('월간보고 서버 저장 시각:', qs.updatedAt);
  const procs = await kp('kpi_process?select=id,name');
  const kpis = (await kp('kpi_master?select=*&is_active=eq.true')).filter(k => {
    const pn = (procs.find(p => p.id === k.process_id) || {}).name || '';
    return /품질/.test(pn) || /품질/.test(k.dept || '');
  });
  console.log('품질 KPI', kpis.length, '개');

  // KST 기준 지난달부터 MONTHS_BACK 개월
  const now = new Date(Date.now() + 9 * 3600e3);
  const months = [];
  for (let i = 1; i <= MONTHS_BACK; i++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push([d.getUTCFullYear(), d.getUTCMonth() + 1]); }

  let saved = 0, kept = 0, same = 0;
  for (const [y, m] of months) {
    const ctx = await loadCtx(y, m, qs);
    if (!ctx.cum || !Object.keys(ctx.cum).length) { console.log(ctx.ym, '월간보고에 자료 없음 → 건너뜀'); continue; }
    const recs = await kp('kpi_record?select=id,kpi_id,actual_value,note&year=eq.' + y + '&month=eq.' + m);
    for (const k of kpis) {
      const r = compute(k, ctx);
      if (!r) continue;
      const ex = recs.find(x => x.kpi_id === k.id);
      const note = '[SF] ' + r.note;
      if (ex && !String(ex.note || '').startsWith('[SF]')) { kept++; console.log(ctx.ym, k.kpi_name, '— 직접 입력값', ex.actual_value, '유지 (계산값', r.val + ')'); continue; }
      if (ex && Number(ex.actual_value) === r.val && ex.note === note) { same++; continue; }
      console.log(ctx.ym, k.kpi_name, ':', ex ? ex.actual_value : '(없음)', '→', r.val, '|', r.note, DRY ? '(DRY_RUN)' : '');
      if (DRY) continue;
      await kp('kpi_record?on_conflict=kpi_id,year,month', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ kpi_id: k.id, year: y, month: m, actual_value: r.val, target_value: monthTarget(k, m), note }),
      });
      saved++;
    }
  }
  console.log('저장', saved, '/ 변경없음', same, '/ 직접입력 유지', kept);
}

if (import.meta.url === 'file://' + process.argv[1]) main().catch(e => { console.error(e); process.exit(1); });
