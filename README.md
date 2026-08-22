# IATF 16949 KPI 관리 시스템 — 배포 구조

## 폴더 구조 (이 구조 그대로 유지)

```
KPI_시스템/
├─ index.html          ← 메인 (이 파일을 열거나 GitHub Pages 루트에 배포)
├─ README.md
└─ lib/                ← 라이브러리 (index.html 과 같은 위치에 있어야 함)
   ├─ chart.umd.js         Chart.js 4.4.1      (추이 그래프)
   ├─ xlsx.full.min.js     SheetJS 0.18.5      (엑셀 내보내기)
   ├─ html2canvas.min.js   html2canvas 1.4.1   (화면 캡처)
   ├─ jspdf.umd.min.js     jsPDF 2.5.1         (PDF 출력)
   ├─ pptxgen.bundle.js    PptxGenJS 3.12.0    (PPT 출력)
   ├─ jszip.min.js         JSZip 3.10.1
   └─ email.min.js         EmailJS 3.11.0      (메일 알람)
```

## 로드 방식

1순위 `./lib/` 로컬 파일 → 실패 시 자동으로 CDN(cdn.jsdelivr.net) 폴백
→ 둘 다 실패하면 화면 하단에 **빨간 경고 배너**로 어떤 라이브러리가 빠졌는지 표시

사내 폐쇄망(인터넷 차단) 환경에서도 `lib/` 폴더만 있으면 전 기능 정상 동작.

## 배포 방법 (GitHub Pages)

```bash
git add index.html lib/ README.md
git commit -m "라이브러리 로컬화 + 추이분석 전체조회 오류 수정"
git push
```
※ `lib/` 폴더가 `.gitignore` 에 걸려 있지 않은지 확인할 것.

## 로컬 실행

`index.html` 더블클릭 (file:// 로도 동작).
단, Supabase 접속이 필요하므로 인터넷 또는 사내에서 Supabase 접근이 가능해야 함.

## 이번 수정 내역

| 구분 | 내용 |
|---|---|
| 오류 | 추이분석 "전체 KPI 조회" 시 그래프·표가 모두 표시되지 않음 |
| 원인 | ① 차트를 표보다 먼저 그려, 차트 생성 실패 시 함수가 중단되어 표까지 미출력<br>② 저장본의 라이브러리 경로가 로컬 폴더로 변경되어 Chart.js 미로드 |
| 조치 1 | `drawTrendAll()` 렌더 순서를 **표 → 차트** 로 변경 (차트 실패해도 데이터 표는 출력) |
| 조치 2 | `safeChart()` 래퍼 추가 — Chart.js 존재 확인 + try/catch, 실패 사유를 화면에 표시 |
| 조치 3 | KPI 미선택 시 무반응 → 안내 토스트 출력 |
| 조치 4 | 해당 년도 실적 0건일 때 안내 배너 표시 |
| 조치 5 | `actual_value` 문자열/공백 대응 (`parseFloat` + `isNaN` 가드) |
| 조치 6 | 34개 라인 가독성 개선 — 선 굵기 1.5, 12색 순환 + 실선/파선/점선 구분, 범례 높이 제한 |
| 조치 7 | 라이브러리 로컬화(`./lib/`) + CDN 폴백 + 로드 실패 경고 배너 |
