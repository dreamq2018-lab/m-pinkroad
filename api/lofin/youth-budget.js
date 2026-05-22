// Vercel Serverless Function — 지방재정365 OpenAPI 프록시
//
// 환경변수 설정 (Vercel Project Settings → Environment Variables):
//   LOFIN_API_KEY  : 지방재정365 OpenAPI 인증키
//                    https://lofin365.go.kr 에서 발급
//
// 호출 형태: GET /api/lofin/youth-budget?year=2026
//
// 응답:
//   { source: 'lofin' | 'fallback', year: '2026', items: [
//     { regionCode, youthBudget, executed, items: [...] }
//   ]}
//
// 키가 없거나 호출 실패 시 source='fallback'을 반환해 프론트엔드가 큐레이션 데이터로 처리하도록 함.

const REGION_CODES = [
  '29170','29200','29110','29140','29155',                     // 광주 5개구
  '46870','46880','46710','46720','46730','46860','46840',     // 전남 북부/서북부
  '46790','46150','46230','46170','46830',                     // 전남 중부
  '46810','46800','46780','46770','46130','46110','46820',     // 전남 남부
  '46900','46890','46910',                                     // 전남 도서
];

const YOUTH_KEYWORDS = ['청년','일자리 청년','청년창업','청년주거','청년월세','청년수당','청년정책'];

async function fetchLofinBudget(apiKey, regionCode, year){
  // TODO: 실제 지방재정365 OpenAPI 엔드포인트와 파라미터로 교체
  // 예시 URL 구조 (실제 발급 시 공식 문서 확인 필요):
  //   https://lofin365.go.kr/portal/openApiService.do
  //     ?serviceKey={apiKey}
  //     &serviceType=JSON
  //     &apiCode=세출예산
  //     &fscYr={year}
  //     &sfrnCd={regionCode}
  //
  // 인증키 발급 후 아래 구현부를 채우세요.

  const url = `https://lofin365.go.kr/portal/openApiService.do`
    + `?serviceKey=${encodeURIComponent(apiKey)}`
    + `&serviceType=JSON`
    + `&apiCode=ExpenditureBudgetByDept`  // 실제 apiCode는 공식 문서 참조
    + `&fscYr=${encodeURIComponent(year)}`
    + `&sfrnCd=${encodeURIComponent(regionCode)}`;

  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if(!r.ok) throw new Error(`LOFIN ${regionCode} ${r.status}`);
  const data = await r.json();

  // 응답 구조에 맞춰 청년 관련 사업만 필터링
  // data.response.body.items.item 가 일반적인 공공API 구조
  const rows = data?.response?.body?.items?.item || data?.items || [];
  const youthRows = rows.filter(it => {
    const name = (it.bizNm || it.programName || it.NM || '').toString();
    return YOUTH_KEYWORDS.some(k => name.includes(k));
  });

  const youthBudget = youthRows.reduce((s, it) => s + Number(it.budgetAmt || it.AMT || 0), 0);
  const executed   = youthRows.reduce((s, it) => s + Number(it.executedAmt || it.EXEC_AMT || 0), 0);

  return {
    regionCode,
    youthBudget: Math.round(youthBudget / 1e8),  // 원 → 억원
    executed:    Math.round(executed   / 1e8),
    items: youthRows.slice(0, 12).map(it => ({
      cat: 'd5',  // TODO: 사업 분류 매핑
      label: '청년사업',
      name: (it.bizNm || it.programName || it.NM || '').toString(),
      budget: Number((Number(it.budgetAmt || 0)/1e8).toFixed(1)),
      spent:  Number((Number(it.executedAmt || 0)/1e8).toFixed(1)),
      rate:   Number(it.budgetAmt) ? Math.round(Number(it.executedAmt)/Number(it.budgetAmt)*100) : 0,
    })),
  };
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const apiKey = process.env.LOFIN_API_KEY;
  const year = (req.query?.year || '2026').toString();

  if(!apiKey){
    return res.status(200).json({
      source: 'fallback',
      year,
      reason: 'LOFIN_API_KEY 환경변수 미설정 — 프론트엔드 큐레이션 데이터로 폴백',
      items: [],
    });
  }

  try{
    const results = await Promise.allSettled(
      REGION_CODES.map(code => fetchLofinBudget(apiKey, code, year))
    );
    const items = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if(items.length === 0){
      return res.status(200).json({
        source: 'fallback',
        year,
        reason: 'LOFIN 응답 없음 — 큐레이션 데이터로 폴백',
        items: [],
      });
    }

    return res.status(200).json({ source: 'lofin', year, items });
  }catch(err){
    return res.status(200).json({
      source: 'fallback',
      year,
      reason: `LOFIN 호출 실패: ${err.message || err}`,
      items: [],
    });
  }
}
