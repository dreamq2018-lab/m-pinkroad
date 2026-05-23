// Vercel Serverless Function — 지방재정365 OpenAPI 프록시
//
// 사용 API:
//   1. 세부사업별 세출현황 (QWGJK) — 청년 사업별 편성액·집행액·국비/시도비/시군구비
//   2. 세출예산 (ACEXBG) — 자치단체별 총예산 (청년 비중 계산용 컨텍스트)
//
// 환경변수: LOFIN_API_KEY (Vercel Project Settings → Environment Variables)
// 호출: GET /api/lofin/youth-budget?year=2026[&exe_ymd=YYYYMMDD]

const LOFIN_QWGJK  = 'https://www.lofin365.go.kr/lf/hub/QWGJK';   // 세부사업별 세출현황
const LOFIN_ACEXBG = 'https://www.lofin365.go.kr/lf/hub/ACEXBG';  // 세출예산 총괄

const REGION_CODES = [
  '29170','29200','29110','29140','29155',
  '46870','46880','46710','46720','46730','46860','46840',
  '46790','46150','46230','46170','46830',
  '46810','46800','46780','46770','46130','46110','46820',
  '46900','46890','46910',
];

const YOUTH_KEYWORDS = ['청년','신혼','미취업','대학생'];

function todayYMD(){
  const d = new Date();
  return d.getFullYear().toString()
    + String(d.getMonth()+1).padStart(2,'0')
    + String(d.getDate()).padStart(2,'0');
}

function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

// LOFIN/공공API 응답 패턴 다양 — 방어적 추출
function extractRows(data, serviceKey){
  if(!data) return [];
  if(Array.isArray(data[serviceKey])){
    const node = data[serviceKey].find(x => Array.isArray(x?.row));
    return node?.row || [];
  }
  if(Array.isArray(data.row)) return data.row;
  if(Array.isArray(data?.response?.body?.items?.item)) return data.response.body.items.item;
  return [];
}

function buildUrl(base, params){
  const qs = Object.entries(params)
    .filter(([,v]) => v !== undefined && v !== null && v !== '')
    .map(([k,v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${qs}`;
}

async function fetchPaginated(base, baseParams, serviceKey, maxPages = 5){
  const all = [];
  for(let pIndex = 1; pIndex <= maxPages; pIndex++){
    const url = buildUrl(base, { ...baseParams, pIndex, pSize: 1000 });
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if(!r.ok) throw new Error(`${serviceKey} HTTP ${r.status}`);
    const data = await r.json();
    const rows = extractRows(data, serviceKey);
    if(rows.length === 0) break;
    all.push(...rows);
    if(rows.length < 1000) break;
  }
  return all;
}

// 분야명 → 사이트 카테고리 코드 (TAG_COLOR 매핑용)
function inferCat(fldNm){
  const s = (fldNm || '').toString();
  if(/주거|국토|건설|토지/.test(s)) return 'house';
  if(/일자리|산업|중소기업|고용|에너지/.test(s)) return 'job';
  if(/교육|훈련/.test(s))           return 'edu';
  if(/문화|관광|체육|예술/.test(s))  return 'life';
  if(/결혼|출산|육아|보육|가족/.test(s)) return 'marry';
  if(/복지|보건/.test(s))           return 'house';
  if(/농림|어업|농촌|어촌/.test(s)) return 'job';
  return 'd5';
}

function aggregateYouth(rows){
  // dbiz_nm 키워드 필터 (서버 측 dbiz_nm=청년 필터 이미 거쳤지만 이중 안전망)
  const filtered = rows.filter(it => {
    const name = (it.dbiz_nm || '').toString();
    return YOUTH_KEYWORDS.some(k => name.includes(k));
  });

  const cpl   = filtered.reduce((s,it) => s + num(it.cpl_amt), 0);
  const ep    = filtered.reduce((s,it) => s + num(it.ep_amt), 0);
  const ntep  = filtered.reduce((s,it) => s + num(it.bdg_ntep), 0);
  const capep = filtered.reduce((s,it) => s + num(it.capep), 0);
  const sggep = filtered.reduce((s,it) => s + num(it.sggep), 0);

  // 사업명 기준 중복 제거 (집행일자별 누적되어 있을 가능성)
  const byProg = new Map();
  filtered.forEach(it => {
    const key = it.dbiz_cd || it.dbiz_nm;
    if(!key) return;
    const cur = byProg.get(key);
    if(!cur){
      byProg.set(key, {
        cat:    inferCat(it.fld_nm),
        label:  it.fld_nm || '청년사업',
        name:   it.dbiz_nm || '',
        budget: num(it.cpl_amt),
        spent:  num(it.ep_amt),
      });
    } else {
      cur.budget = Math.max(cur.budget, num(it.cpl_amt)); // 편성액은 사업당 상수
      cur.spent  = Math.max(cur.spent,  num(it.ep_amt));  // 누적 지출액 중 최대값
    }
  });

  const items = [...byProg.values()]
    .sort((a,b) => b.budget - a.budget)
    .slice(0, 30)
    .map(p => ({
      cat:    p.cat,
      label:  p.label,
      name:   p.name,
      budget: Number((p.budget / 1e8).toFixed(1)),
      spent:  Number((p.spent  / 1e8).toFixed(1)),
      rate:   p.budget ? Math.round(p.spent / p.budget * 100) : 0,
    }));

  return {
    youthBudget: Math.round(cpl   / 1e8),
    executed:    Math.round(ep    / 1e8),
    ntep:        Math.round(ntep  / 1e8),
    capep:       Math.round(capep / 1e8),
    sggep:       Math.round(sggep / 1e8),
    items,
  };
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const apiKey  = process.env.LOFIN_API_KEY;
  const fyr     = (req.query?.year || '2026').toString();
  const exe_ymd = (req.query?.exe_ymd || todayYMD()).toString();

  if(!apiKey){
    return res.status(200).json({
      source: 'fallback',
      year: fyr,
      reason: 'LOFIN_API_KEY 환경변수 미설정 — 프론트엔드 큐레이션 데이터로 폴백',
      items: [],
    });
  }

  try{
    // 1) 세부사업별 — 27개 자치단체 병렬 호출 (dbiz_nm=청년 서버 측 필터)
    const youthResults = await Promise.allSettled(
      REGION_CODES.map(code =>
        fetchPaginated(LOFIN_QWGJK, {
          Key: apiKey, Type: 'json',
          fyr, exe_ymd, laf_cd: code, dbiz_nm: '청년',
        }, 'QWGJK', 3).then(rows => ({ regionCode: code, ...aggregateYouth(rows) }))
      )
    );

    // 2) 세출예산 — 광주광역시·전라남도 묶음 호출 (자치단체별 총세출 한 줄)
    const totalsByCode = new Map();
    const totalsResults = await Promise.allSettled(
      ['광주광역시','전라남도'].map(wa =>
        fetchPaginated(LOFIN_ACEXBG, {
          Key: apiKey, Type: 'json', fyr, wa_laf_hg_nm: wa,
        }, 'ACEXBG', 2)
      )
    );
    totalsResults.forEach(r => {
      if(r.status !== 'fulfilled') return;
      r.value.forEach(row => {
        if(row.laf_cd) totalsByCode.set(String(row.laf_cd), num(row.ane_tott_amt));
      });
    });

    // 3) 합치기
    const items = youthResults
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => {
        const totalRaw = totalsByCode.get(r.value.regionCode);
        const totalEok = totalRaw ? Math.round(totalRaw / 1e8) : null;
        const share    = (totalEok && r.value.youthBudget)
          ? Number((r.value.youthBudget / totalEok * 100).toFixed(2))
          : null;
        return { ...r.value, totalRegionBudget: totalEok, youthShare: share };
      });

    const ok = items.some(i => i.youthBudget > 0);
    if(!ok){
      return res.status(200).json({
        source: 'fallback',
        year: fyr,
        reason: 'LOFIN 응답에 청년 사업 0건 — 큐레이션 데이터로 폴백 (인증키·exe_ymd 확인 필요)',
        items: [],
      });
    }

    return res.status(200).json({
      source: 'lofin',
      year: fyr,
      exe_ymd,
      fetched_at: new Date().toISOString(),
      items,
    });
  }catch(err){
    return res.status(200).json({
      source: 'fallback',
      year: fyr,
      reason: `LOFIN 호출 실패: ${err.message || err}`,
      items: [],
    });
  }
};
