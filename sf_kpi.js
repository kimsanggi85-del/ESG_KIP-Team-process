/* SmartFactory → KPI 실적 자동 산출 (품질관리 · 생산관리 공용)
   브라우저(index.html <script src>)와 자동 등록 작업(scripts/sf_kpi_sync.mjs)이 같은 계산식을 쓴다.
   원자료 (SmartFactory DB)
   - 품질 : 불량관리 월간보고 누적자료(common_code quality_state_v1) · 수입검사 기록(iqc_inspections)
   - 생산 : 생산일보(kv_store tj_prod_daily_v1) — 생산일보 앱 월간 보고서와 같은 식
*/
(function (G) {
  const SF_URL = 'https://omngtyewdaqpphnzeate.supabase.co';
  const SF_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tbmd0eWV3ZGFxcHBobnplYXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4ODk4ODksImV4cCI6MjA5MDQ2NTg4OX0.Zxur3t02JHtOcXforCMSwO3i2mMaf5sViE0tXXUC0-s';
  // 월 목표수량 = MES 작업지시 중 실적이 있는 지시의 계획수량 합 (MES '생산계획 대비 실적' 1~10월 엑셀에서 계산)
  //   생산일보 월 생산계획(master.plan)에 직접 넣은 값이 있으면 그 값이 우선
  const DEF_PLAN = {
    '2026-01': { tgt: 4873689 }, '2026-02': { tgt: 3631122 }, '2026-03': { tgt: 4240161 }, '2026-04': { tgt: 4757562 },
    '2026-05': { tgt: 4119768 }, '2026-06': { tgt: 4447413 }, '2026-07': { tgt: 5183244 }, '2026-08': { tgt: 3987495 },
    '2026-09': { tgt: 3791427 }, '2026-10': { tgt: 4400703 } };

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
  const MTTR_TGT = 120;   // MTTR 목표시간(분) — MTTR 달성률 = 목표 ÷ 실평균수리시간 × 100 (상한 100%)

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
      // MES 작업지시 월 계획수량 — 실적 있는 작업지시의 계획수량 합 (MES 관리 도구가 작업지시 저장·조회 때 올림)
      mesPlan: () => once('mp', async () => {
        const v = await get('kv_store?key=eq.tj_mes_plan_month_v1&select=value');
        return ((v[0] && v[0].value) || {}).months || {};
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
    // MTTR 달성률(%) = 목표 120분 ÷ 실평균수리시간 × 100, 상한 100% (2026-11-18 결정)
    //   실평균수리시간 = 생산일보 고장정지 fm(분) ÷ 설비고장 건수 fcnt — 1~8월 직접 입력값과 같은 경향
    //   KPI 설정 단위가 %일 때만 등록 (분 단위로 설정돼 있으면 달성률 값이 분으로 읽히므로 건너뜀)
    if (/MTTR/i.test(nm)) {
      if (!/%/.test(String(k.unit || ''))) return { skip: 'KPI 단위가 ' + (k.unit || '없음') + ' — 설정에서 단위 %·높을수록 좋음·목표 100으로 바꾸면 자동 등록' };
      const P0 = await L.prod();
      const R0 = P0.recs.filter(r => r.date.slice(0, 7) === ym);
      if (!R0.length) return { skip: '생산일보에 ' + ym + ' 자료 없음' };
      const T0 = monthStats(R0);
      if (!T0.f) {
        // 고장건수·fm(고장정지 분)이 비어 있는데 정지사유에 설비이상이 있으면 입력 누락 — 100%로 넣지 않음
        const miss = R0.filter(r => /설비이상/.test(String(r.sr || '') + String(r.note || ''))).length;
        if (miss) return { skip: '생산일보 고장건수·고장정지(fm) 미입력 — 정지사유에 설비이상 ' + miss + '건' };
        return { val: 100, note: '설비고장 0건 (목표 ' + MTTR_TGT + '분)', src: '생산일보' };
      }
      const mttr = T0.fm / T0.f, raw = MTTR_TGT / mttr * 100;
      return { val: r1(Math.min(100, raw)), note: 'MTTR ' + r1(mttr) + '분 (고장 ' + T0.f + '건 · ' + fmt(T0.fm) + '분) · 목표 ' + MTTR_TGT + '분' + (raw > 100 ? ' · 계산 ' + r1(raw) + '% → 상한 100%' : ''), src: '생산일보' };
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
      // 목표수량 우선순위: 생산일보 월 생산계획(직접 입력) → DEF_PLAN → MES 작업지시 계획수량 합계(실적 있는 작업지시만)
      const own = ((P.master.plan || {})[ym]) || {}, mp = (await L.mesPlan())[ym] || {};
      let tgt = +own.tgt, from = '생산일보 월 생산계획';
      if (!tgt) { tgt = +(DEF_PLAN[ym] || {}).tgt; from = '목표수량'; }
      if (!tgt) { tgt = +mp.tgt; from = 'MES 작업지시 ' + (mp.n || 0) + '건'; }
      if (!tgt) return { skip: ym + ' 목표수량 없음 (MES 관리 도구 [월 계획수량 → KPI] 또는 생산일보 월 생산계획 입력)' };
      return { val: r1(T.qty / tgt * 100), note: '실적 ' + fmt(T.qty) + ' / 목표 ' + fmt(tgt) + ' EA (' + from + ')', src };
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


  /* ---------- KPI관리 DB 등록 (자동 등록 작업 · 월마감 연동 공용) ----------
     규칙: 직접 입력한 실적(비고가 [SF]로 시작하지 않음)은 덮어쓰지 않는다. [SF] 자동 등록분만 갱신.
     opt: { months:[[y,m],...], depts:['Q','P'], dry:false, log:fn, force:['259@2026-09'] } → { saved, same, kept, skipped, lines }
     force: 'KPI번호@년-월' 목록 — 사용자가 지정한 칸만 직접 입력값이어도 계산값으로 덮어씀 */
  const KPI_URL = 'https://pwunfmpddkpymcnfiitn.supabase.co';
  const KPI_KEY = 'sb_publishable_PkmIYbQfhxzVubz-sV_UHQ_OOGByUmi';
  async function kp(p, opt) {
    opt = opt || {};
    const r = await fetch(KPI_URL + '/rest/v1/' + p, Object.assign({}, opt, {
      headers: Object.assign({ apikey: KPI_KEY, Authorization: 'Bearer ' + KPI_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, opt.headers || {}) }));
    const t = await r.text();
    if (!r.ok) throw new Error('KPI관리 ' + p.split('?')[0] + ' ' + r.status + ' ' + t.slice(0, 200));
    return t ? JSON.parse(t) : null;
  }
  // KPI 화면 getMonthTarget 과 같은 규칙: monthly_targets 우선
  function monthTarget(k, m) {
    let o = k.monthly_targets;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
    const v = o && (o[m] != null ? o[m] : o[String(m)]);
    return v !== undefined && v !== null && v !== '' ? Number(v) : (k.target_value != null ? k.target_value : null);
  }
  async function register(opt) {
    const depts = opt.depts || ['Q', 'P'], dry = !!opt.dry, log = opt.log || (() => {});
    const force = new Set((opt.force || []).map(x => String(x).trim()).filter(Boolean));
    const procs = await kp('kpi_process?select=id,name');
    const kpis = (await kp('kpi_master?select=*&is_active=eq.true')).filter(k => depts.includes(deptOf(k, procs)));
    log('대상 KPI ' + kpis.length + '개 (' + depts.join('·') + ')' + (dry ? ' — DRY_RUN' : ''));
    kpis.forEach(k => log('  · ' + k.id + ' ' + k.kpi_name + ' | 단위 ' + k.unit + ' | 목표 ' + k.target_value + ' | 경고 ' + k.alert_value + ' | ' + k.direction));
    const L = loader(), res = { saved: 0, same: 0, kept: 0, skipped: 0, lines: [] };
    const out = s => { res.lines.push(s); log(s); };
    for (const [y, m] of opt.months) {
      const ym = ymOf(y, m);
      const recs = await kp('kpi_record?select=id,kpi_id,actual_value,note&year=eq.' + y + '&month=eq.' + m);
      for (const k of kpis) {
        let r;
        try { r = await computeKpi(k, y, m, L, procs); } catch (e) { out(ym + ' ' + k.kpi_name + ' — 오류 ' + e.message); res.skipped++; continue; }
        if (!r) continue;
        if (r.skip) { out(ym + ' ' + k.kpi_name + ' — 건너뜀: ' + r.skip); res.skipped++; continue; }
        const ex = recs.find(x => x.kpi_id === k.id), note = '[SF] ' + r.note;
        const forced = force.has(k.id + '@' + ym);
        if (ex && !forced && !String(ex.note || '').startsWith('[SF]')) { res.kept++; out(ym + ' ' + k.kpi_name + ' — 직접 입력값 ' + ex.actual_value + ' 유지 (계산값 ' + r.val + ' | ' + r.note + ')'); continue; }
        if (ex && Number(ex.actual_value) === r.val && ex.note === note) { res.same++; continue; }
        out(ym + ' ' + k.kpi_name + ' : ' + (ex ? ex.actual_value : '(없음)') + ' → ' + r.val + ' | ' + r.note + (forced && ex && !String(ex.note || '').startsWith('[SF]') ? '  ※ 지정 덮어쓰기' : ''));
        if (dry) continue;
        await kp('kpi_record?on_conflict=kpi_id,year,month', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ kpi_id: k.id, year: y, month: m, actual_value: r.val, target_value: monthTarget(k, m), note }) });
        res.saved++;
      }
    }
    log('저장 ' + res.saved + ' / 변경없음 ' + res.same + ' / 직접입력 유지 ' + res.kept + ' / 건너뜀 ' + res.skipped);
    return res;
  }

  G.SFKPI = { SF_URL, loader, computeKpi, deptOf, monthStats, calc, register };
})(typeof window !== 'undefined' ? window : globalThis);
