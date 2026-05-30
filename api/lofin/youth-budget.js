// Vercel Serverless Function — 지방재정365 OpenAPI 프록시 (QWGJK 세부사업별 세출현황)
//
// 공식 규격(확인됨): https://www.lofin365.go.kr/lf/hub/QWGJK
//   필수: Key, Type, pIndex, pSize, fyr(회계연도), exe_ymd(집행일자 YYYYMMDD)
//   선택: wa_laf_cd(지역코드 7자리), laf_cd(자치단체코드 7자리), dbiz_nm(세부사업명)
//   ※ 지역코드는 7자리(광주=2900000, 전남=4600000). laf_cd는 7자리 LOFIN 코드이며
//      행정표준코드(5자리)와 다르므로, 본 함수는 지역코드(wa_laf_cd)로 광역 단위 조회 후
//      응답의 laf_hg_nm(자치단체명)으로 프론트 27개 지역에 매핑한다.
//
// 환경변수: LOFIN_API_KEY (Vercel Project Settings → Environment Variables)
// 호출: GET /api/lofin/youth-budget?year=2026[&exe_ymd=YYYYMMDD]

const LOFIN_QWGJK = 'https://www.lofin365.go.kr/lf/hub/QWGJK';

// 광역 지역코드(7자리)
const WIDE_AREAS = [
  { wa: '2900000', area: '광주' },
  { wa: '4600000', area: '전남' },
];

// 자치단체명(부분일치 키워드) → 프론트 5자리 코드
const NAME_TO_CODE = [
  // 광주 5개 자치구
  ['광산구', '29200'], ['북구', '29170'], ['동구', '29110'], ['서구', '29140'], ['남구', '29155'],
  // 전남 22개 시·군
  ['나주', '46170'], ['목포', '46110'], ['여수', '46130'], ['순천', '46150'], ['광양', '46230'],
  ['담양', '46710'], ['곡성', '46720'], ['구례', '46730'], ['고흥', '46770'], ['보성', '46780'],
  ['화순', '46790'], ['장흥', '46800'], ['강진', '46810'], ['해남', '46820'], ['영암', '46830'],
  ['무안', '46840'], ['함평', '46860'], ['영광', '46870'], ['장성', '46880'], ['완도', '46890'],
  ['진도', '46900'], ['신안', '46910'],
];

const YOUTH_KEYWORDS = ['청년', '신혼', '미취업', '대학생'];

function num(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

function ymd(d){
  return d.getFullYear().toString()
    + String(d.getMonth()+1).padStart(2,'0')
    + String(d.getDate()).padStart(2,'0');
}

// QWGJK 응답에서 row 배열 추출 (방어적)
function extractRows(data){
  if(!data) return [];
  if(Array.isArray(data.QWGJK)){
    const node = data.QWGJK.find(x => Array.isArray(x?.row));
    return node?.row || [];
  }
  if(Array.isArray(data.row)) return data.row;
  return [];
}
// 정상 응답 여부 (INFO-000)
function resultCode(data){
  try{
    if(Array.isArray(data?.QWGJK)){
      const head = data.QWGJK.find(x => Array.isArray(x?.head))?.head;
      const r = head?.find(x => x?.RESULT)?.RESULT;
      if(r?.CODE) return r.CODE;
    }
    if(Array.isArray(data?.RESULT)) return data.RESULT[0]?.CODE || null;
  }catch(e){}
  return null;
}

function buildUrl(params){
  const qs = Object.entries(params)
    .filter(([,v]) => v !== undefined && v !== null && v !== '')
    .map(([k,v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${LOFIN_QWGJK}?${qs}`;
}

async function callQWGJK(params){
  const r = await fetch(buildUrl(params), { headers: { Accept: 'application/json' } });
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// 한 광역(wa_laf_cd)에 대해 청년 사업 전체 페이지 수집
async function fetchYouthRows(apiKey, fyr, exe_ymd, wa){
  const all = [];
  for(let pIndex = 1; pIndex <= 2; pIndex++){
    const data = await callQWGJK({
      Key: apiKey, Type: 'json', pIndex, pSize: 1000,
      fyr, exe_ymd, wa_laf_cd: wa, dbiz_nm: '청년',
    });
    const rows = extractRows(data);
    if(rows.length === 0) break;
    all.push(...rows);
    if(rows.length < 1000) break;
  }
  return all;
}

function inferCat(fldNm){
  const s = (fldNm || '').toString();
  if(/주거|국토|건설|토지/.test(s)) return 'house';
  if(/일자리|산업|중소기업|고용|에너지/.test(s)) return 'job';
  if(/교육|훈련/.test(s)) return 'edu';
  if(/문화|관광|체육|예술/.test(s)) return 'life';
  if(/결혼|출산|육아|보육|가족/.test(s)) return 'marry';
  if(/복지|보건/.test(s)) return 'house';
  if(/농림|어업|농촌|어촌/.test(s)) return 'job';
  return 'd5';
}

function matchCode(lafHgNm){
  const name = (lafHgNm || '').toString();
  for(const [kw, code] of NAME_TO_CODE){ if(name.includes(kw)) return code; }
  return null;
}

// 청년 키워드 행만 골라 지역(5자리코드)별로 집계
function aggregateByRegion(rows){
  const byCode = new Map(); // code -> {sumCpl,sumEp,..., progs:Map}
  for(const it of rows){
    const name = (it.dbiz_nm || '').toString();
    if(!YOUTH_KEYWORDS.some(k => name.includes(k))) continue;
    const code = matchCode(it.laf_hg_nm);
    if(!code) continue;
    let acc = byCode.get(code);
    if(!acc){ acc = { cpl:0, ep:0, ntep:0, capep:0, sggep:0, progs:new Map() }; byCode.set(code, acc); }
    acc.cpl   += num(it.cpl_amt);
    acc.ep    += num(it.ep_amt);
    acc.ntep  += num(it.bdg_ntep);
    acc.capep += num(it.capep);
    acc.sggep += num(it.sggep);
    const key = it.dbiz_cd || it.dbiz_nm;
    if(key){
      const cur = acc.progs.get(key);
      if(!cur){
        acc.progs.set(key, { cat: inferCat(it.fld_nm), label: it.fld_nm || '청년사업', name: it.dbiz_nm || '', budget: num(it.cpl_amt), spent: num(it.ep_amt) });
      } else {
        cur.budget = Math.max(cur.budget, num(it.cpl_amt));
        cur.spent  = Math.max(cur.spent,  num(it.ep_amt));
      }
    }
  }
  const items = [];
  for(const [code, acc] of byCode){
    const progItems = [...acc.progs.values()]
      .sort((a,b)=>b.budget-a.budget).slice(0,30)
      .map(p=>({ cat:p.cat, label:p.label, name:p.name,
        budget:Number((p.budget/1e8).toFixed(1)), spent:Number((p.spent/1e8).toFixed(1)),
        rate: p.budget ? Math.round(p.spent/p.budget*100) : 0 }));
    items.push({
      regionCode: code,
      youthBudget: Math.round(acc.cpl / 1e8),
      executed:    Math.round(acc.ep  / 1e8),
      ntep:  Math.round(acc.ntep  / 1e8),
      capep: Math.round(acc.capep / 1e8),
      sggep: Math.round(acc.sggep / 1e8),
      items: progItems,
    });
  }
  return items;
}

// 워밍 캐시: 동일 컨테이너 재사용 시 집행일자 탐색 생략 (12시간)
const _dateCache = {};
// fyr에 대해 데이터가 존재하는 exe_ymd를 탐색 (today→과거로 최대 10일)
async function findWorkingDate(apiKey, fyr, startDate){
  const ck = fyr+'_'+ymd(startDate);
  if(_dateCache[ck] && (Date.now()-_dateCache[ck].ts) < 12*3600*1000) return _dateCache[ck].exe;
  const probeWa = '4600000'; // 전남으로 탐색
  for(let i=0; i<=10; i++){
    const d = new Date(startDate); d.setDate(d.getDate()-i);
    const exe = ymd(d);
    try{
      const data = await callQWGJK({ Key:apiKey, Type:'json', pIndex:1, pSize:1, fyr, exe_ymd:exe, wa_laf_cd:probeWa });
      if(resultCode(data) === 'INFO-000' && extractRows(data).length > 0){ _dateCache[ck]={exe,ts:Date.now()}; return exe; }
    }catch(e){ /* 다음 후보 */ }
  }
  return null;
}

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');

  const apiKey = process.env.LOFIN_API_KEY;
  const reqYear = (req.query?.year || '2026').toString();

  if(!apiKey){
    return res.status(200).json({ source:'fallback', year:reqYear, reason:'LOFIN_API_KEY 환경변수 미설정', items:[] });
  }

  try{
    const today = new Date();
    // 1) 요청연도에 데이터 있는 집행일자 탐색 → 없으면 직전연도 연말로 폴백
    const candidates = [];
    const qExe = (req.query?.exe_ymd || '').toString();
    if(qExe) candidates.push({ fyr: reqYear, exe: qExe });

    let used = null;
    if(qExe){
      used = { fyr: reqYear, exe: qExe };
    } else {
      const exeThis = await findWorkingDate(apiKey, reqYear, today);
      if(exeThis){ used = { fyr: reqYear, exe: exeThis }; }
      else {
        const prev = String(Number(reqYear) - 1);
        const exePrev = await findWorkingDate(apiKey, prev, new Date(Number(prev),11,31));
        if(exePrev) used = { fyr: prev, exe: exePrev };
      }
    }

    if(!used){
      return res.status(200).json({ source:'fallback', year:reqYear, reason:'LOFIN에서 데이터가 존재하는 집행일자를 찾지 못했습니다.', items:[] });
    }

    // 2) 광주·전남 광역 단위 청년사업 수집
    const results = await Promise.allSettled(
      WIDE_AREAS.map(a => fetchYouthRows(apiKey, used.fyr, used.exe, a.wa))
    );
    const rows = [];
    results.forEach(r => { if(r.status==='fulfilled') rows.push(...r.value); });

    const items = aggregateByRegion(rows);
    const ok = items.some(i => i.youthBudget > 0);
    if(!ok){
      return res.status(200).json({ source:'fallback', year:used.fyr, reason:'청년 사업 집계 0건', items:[] });
    }

    return res.status(200).json({
      source: 'lofin',
      year: used.fyr,
      exe_ymd: used.exe,
      requestedYear: reqYear,
      fetched_at: new Date().toISOString(),
      items,
    });
  }catch(err){
    return res.status(200).json({ source:'fallback', year:reqYear, reason:`LOFIN 호출 실패: ${err.message||err}`, items:[] });
  }
};

