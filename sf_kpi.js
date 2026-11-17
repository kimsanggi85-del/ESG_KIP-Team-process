/* SmartFactory → KPI 실적 자동 산출 (품질관리 · 생산관리 공용)
   브라우저(index.html <script src>)와 자동 등록 작업(scripts/sf_kpi_sync.mjs)이 같은 계산식을 쓴다.
   원자료 (SmartFactory DB)
   - 품질 : 불량관리 월간보고 누적자료(common_code quality_state_v1) · 수입검사 기록(iqc_inspections)
   - 생산 : 생산일보(kv_store tj_prod_daily_v1) — 생산일보 앱 월간 보고서와 같은 식
*/
(function (G) {
  const SF_URL = 'https://omngtyewdaqpphnzeate.supabase.co';
  const SF_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tbmd0eWV3ZGFxcHBobnplYXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4ODk4ODksImV4cCI6MjA5MDQ2NTg4OX0.Zxur3t02JHtOcXforCMSwO3i2mMaf5sViE0tXXUC0-s';
  // 생산일보 앱(Daily-Production-Report) DEF_PLAN — 2026-01~08 MES 목표수량. 그 뒤는 생산일보 기준정보(master.plan)
  const DEF_PLAN = {
    '2026-01': { tgt: 4090405 }, '2026-02': { tgt: 2961398 }, '2026-03': { tgt: 3641812 }, '2026-04': { tgt: 4272315 },
    '2026-05': { tgt: 3555827 }, '2026-06': { tgt: 3624371 }, '2026-07': { tgt: 4719215 }, '2026-08': { tgt: 3601568 } };

  async function get(path) {
    const r = await fetch(SF_URL + '/rest/v1/' + path, { headers: { apikey: SF_KEY, Authorization: 'Bearer ' + SF_KEY, Accept: 'application/json' } });
    if (!r.ok) throw new Error('SmartFactory 조회 실패 (' + r.status + ') ' + (await r.text()).slice(0, 150));
    return r.json();
  }
  const norm = s => String(s || '').replace(/\s+/g, '').replace(/율/g, '률');
  const paren = n => (String(n || '').match(/\(([^)]+)\)/) || [])[1] || '';
  const fmt = n => Number(n || 0).toLocaleString('ko-KR');
  const r1 = v => Math.round(v * 10) / 10;
  const ymOf = (y, m) => y + '-' + String(m).padStart(2, '0');

  /* 부서 구분 — 프로세스명 또는 담당부서 */
  function deptOf(k, processes) {
    const pn = ((processes || []).find(p => p.id === k.process_id) || {}).name || '';
    const s = pn + ' ' + (k.dept || '');
    if (/품질/.test(s)) return 'Q';
    if (/생산/.test(pn) || (!pn && /생산/.test(k.dept || ''))) return 'P';
    return '';
  }

  /* ---------- 원자료 읽기 (월 단위 캐시) ---------- */
  function loader() {
    const C = {};
    const once = (k, f) => (C[k] = C[k] || f());
    return {
      quality: () => once('q', async () => {
        const cc = await get('common_code?code_group=eq.quality_state_v1&select=code_value&limit=1');
        if (!cc.length || !cc[0].code_value) throw new Error('불량관리 월간보고 서버 자료가 없습니다 (월간보고 화면에서 서버 동기화 필요)');
        return JSON.parse(cc[0].code_value);
      }),
      iqc: (y, m) => once('i' + ymOf(y, m), () => {
        const next = m === 12 ? (y + 1) + '-01-01' : ymOf(y, m + 1) + '-01';
        return get('iqc_inspections?select=supplier,final_judge,insp_date&insp_date=gte.' + ymOf(y, m) + '-01&insp_date=lt.' + next + '&limit=5000');
      }),
      prod: () => once('p', async () => {
        const v = await get('kv_store?key=eq.tj_prod_daily_v1&select=value');
        const j = (v[0] && v[0].value) || {};
        const del = j.del || {};
        return { recs: (j.recs || []).filter(r => r && r.date && !del[r.id]), master: j.master || {}, ua: j.ua };
      }),
      // 설비 정지 기록 (MES 정지코드) — MTTR
      downtime: (y, m) => once('d' + ymOf(y, m), () => {
        const next = m === 12 ? (y + 1) + '-01-01' : ymOf(y, m + 1) + '-01';
        return get('daily_downtime?select=ymd,machine_name,stop_events&ymd=gte.' + ymOf(y, m) + '-01&ymd=lt.' + next + '&limit=5000');
      }),
      // 금형 정기점검 계획·이력 — 예방보전 준수
      mold: () => once('m', async () => {
        const v = await get('kv_store?key=eq.mold_periodic_v1&select=plan:value->plan,hist:value->hist');
        return (v[0]) || { plan: {}, hist: [] };
      }),
    };
  }

  /* ---------- 품질 ---------- */
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

  async function quality(k, y, m, L) {
    const nm = norm(k.kpi_name), qs = await L.quality(), ym = ymOf(y, m);
    const cum = (qs.cumulative || {})[ym];
    const src = '월간보고 ' + (qs.updatedAt || '').slice(0, 10);
    if (/공정불량률/.test(nm)) {
      if (!cum || !Object.keys(cum).length) return { skip: '월간보고에 ' + ym + ' 자료 없음' };
      const v = vendorKey(paren(k.kpi_name));
      if (!v) return { skip: '거래처 구분 불가' };
      const d = cum[v];
      if (d && d.insp > 0) return { val: Math.round(d.defect / d.insp * 1e6), note: '불량 ' + fmt(d.defect) + ' / 검사 ' + fmt(d.insp) + ' EA', src };
      return { val: 0, note: '해당월 검사·불량 자료 없음', src };
    }
    if (/수입검사/.test(nm)) {
      if (!cum || !Object.keys(cum).length) return { skip: '월간보고에 ' + ym + ' 자료 없음 (월 마감 전)' };
      const sup = supNorm(paren(k.kpi_name));
      if (!sup) return { skip: '공급사 구분 불가' };
      const rows = (await L.iqc(y, m)).filter(r => { const a = supNorm(r.supplier); return a && (a.includes(sup) || sup.includes(a)); });
      const judged = rows.filter(r => String(r.final_judge || '').trim());
      const ng = judged.filter(r => !isPass(r.final_judge)).length;
      return { val: judged.length ? Math.round(ng / judged.length * 1e6) : 0,
        note: rows.length ? judged.length + ' LOT 중 불합격 ' + ng + (rows.length > judged.length ? ' (판정 미기재 ' + (rows.length - judged.length) + ')' : '') : '해당월 입고 없음', src: '수입검사 기록' };
    }
    if (/^Q-?cost/i.test(nm)) {
      if (!cum || !Object.keys(cum).length) return { skip: '월간보고에 ' + ym + ' 자료 없음' };
      const loss = Object.values(cum).reduce((a, d) => a + (Number(d.loss) || 0), 0);
      const sort = (qs.personalLoss || []).filter(p => { const mm = /^(\d{4})\D(\d{1,2})/.exec(String(p.date || '').trim()); return mm && +mm[1] === y && +mm[2] === m; })
        .reduce((a, p) => a + (Number(p.amount) || 0), 0);
      const won = Math.round(loss) + Math.round(sort);
      return { val: /만/.test(String(k.unit || '')) ? r1(won / 1e4) : won, note: '불량손실 ' + fmt(Math.round(loss)) + ' + 선별 ' + fmt(sort) + ' = ' + fmt(won) + '원', src };
    }
    return null;
  }

  /* ---------- 생산 (생산일보 앱 calc · rptStats · relOf 와 같은 식) ---------- */
  const calc = r => {
    const net = Math.max(0, (+r.work || 0) - (+r.brk || 0));
    const run = Math.max(0, net - (+r.stop || 0));
    const cap = (+r.spm || 0) * net;
    return { run, net, cap, single: !(+r.spm), oper: net ? run / net : NaN, eff: cap ? (+r.qty || 0) / cap : NaN };
  };
  // 월간 보고서 방식: 하루 안의 일보 평균 → 그 날짜들의 평균
  function monthStats(R) {
    const byDay = {};
    R.forEach(r => (byDay[r.date] = byDay[r.date] || []).push(r));
    let oper = 0, k = 0, eff = 0, ke = 0, qty = 0, f = 0, fm = 0, run = 0;
    Object.values(byDay).forEach(L => {
      let o = 0, n = 0, e = 0, ne = 0;
      L.forEach(r => { const c = calc(r); if (isFinite(c.oper)) { o += c.oper; n++; } if (!c.single && isFinite(c.eff)) { e += c.eff; ne++; }
        qty += +r.qty || 0; f += +r.fcnt || 0; fm += +r.fmin || 0; run += c.run; });
      if (n) { oper += o / n; k++; } if (ne) { eff += e / ne; ke++; }
    });
    return { days: Object.keys(byDay).length, oper: k ? oper / k : NaN, eff: ke ? eff / ke : NaN, qty, f, fm, run };
  }

  async function production(k, y, m, L) {
    const nm = norm(k.kpi_name), ym = ymOf(y, m);
    // MTTR (분) = MES '설비이상' 정지시간 합 ÷ 건수 — 낮을수록 좋음 (2026-11-17 결정: 달성률 아닌 MTTR 분 자체, 목표 15분)
    if (/MTTR/i.test(nm)) {
      const D = await L.downtime(y, m);
      let n = 0, mins = 0;
      D.forEach(d => (d.stop_events || []).forEach(e => { if (e && e.name === '설비이상') { n++; mins += +e.min || 0; } }));
      if (!D.length) return { skip: 'MES 정지기록에 ' + ym + ' 자료 없음' };
      return { val: n ? r1(mins / n) : 0, note: '설비이상 ' + n + '건 · ' + fmt(Math.round(mins)) + '분 (MES 정지기록)', src: 'MES 정지기록' };
    }
    // 예방보전 준수 (%) = 그 달 정기점검 계획 금형 중 그 달 점검 실시 비율 (금형 정기점검 앱)
    if (/예방보전/.test(nm)) {
      const M = await L.mold(), plan = M.plan || {}, hist = M.hist || [];
      const due = Object.keys(plan).filter(pn => (plan[pn] || []).map(Number).includes(m));
      if (!due.length) return { skip: ym + ' 정기점검 계획 금형 없음' };
      const done = due.filter(pn => hist.some(h => h && h['품번'] === pn && String(h['점검일'] || '').slice(0, 7) === ym));
      return { val: r1(done.length / due.length * 100), note: '정기점검 계획 ' + due.length + '건 중 실시 ' + done.length + '건 (금형 정기점검)', src: '금형 정기점검' };
    }
    const P = await L.prod();
    const R = P.recs.filter(r => r.date.slice(0, 7) === ym);
    if (!R.length) return { skip: '생산일보에 ' + ym + ' 자료 없음' };
    const T = monthStats(R), src = '생산일보';
    if (/계획/.test(nm) && /달성/.test(nm)) {
      const PL = Object.assign({}, DEF_PLAN[ym] || {}, ((P.master.plan || {})[ym]) || {});
      if (!(+PL.tgt)) return { skip: '생산일보에 ' + ym + ' 목표수량(MES) 미입력' };
      return { val: r1(T.qty / PL.tgt * 100), note: '실적 ' + fmt(T.qty) + ' / 목표 ' + fmt(PL.tgt) + ' EA', src };
    }
    if (/가동률/.test(nm)) return { val: r1(T.oper * 100), note: T.days + '일 평균 (가동시간 ÷ 실근무)', src };
    if (/^효률$/.test(nm) || /생산효률|설비효률/.test(nm)) return { val: r1(T.eff * 100), note: T.days + '일 평균 (실적 ÷ 가능수량)', src };
    return null;
  }

  /* k: kpi_master 행 · 반환 {val,note,src} | {skip} | null(대상 아님) */
  async function computeKpi(k, y, m, L, processes) {
    const d = deptOf(k, processes);
    if (d === 'Q') return quality(k, y, m, L);
    if (d === 'P') return production(k, y, m, L);
    return null;
  }

  G.SFKPI = { SF_URL, loader, computeKpi, deptOf, monthStats, calc };
})(typeof window !== 'undefined' ? window : globalThis);
