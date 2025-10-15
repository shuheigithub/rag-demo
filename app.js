// 軽量CSVパーサ（カンマ区切り・""クォート対応の最小実装）
function parseCsv(text){
  const rows=[];let row=[];let cur="";let inQ=false;for(let i=0;i<text.length;i++){const c=text[i];if(inQ){if(c==='"'){if(text[i+1]==='"'){cur+='"';i++;}else{inQ=false;}}else{cur+=c;}}else{if(c==='"'){inQ=true;}else if(c===','){row.push(cur);cur="";}else if(c==='\n'){row.push(cur);rows.push(row);row=[];cur="";}else if(c==='\r'){/* skip */}else{cur+=c;}}}
  if(cur.length>0||row.length>0){row.push(cur);rows.push(row);}return rows;
}

// JDG(XML)パース
async function parseJdg(file){
  let text=await file.text();
  // BOMや制御文字を除去
  text=text.replace(/^\uFEFF/, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'');
  const parser=new DOMParser();
  const xml=parser.parseFromString(text,'application/xml');
  // XMLパースエラー検出
  if(xml.getElementsByTagName('parsererror').length){
    const msg=xml.getElementsByTagName('parsererror')[0]?.textContent||'XML parse error';
    throw new Error('JDGのXML解析に失敗: '+msg);
  }
  // Phase -> { judgename: {value, unit} }
  const phaseMap={};
  const phases=[...xml.getElementsByTagName('PhaseJudgement')];
  for(const p of phases){
    const nameNode=p.getElementsByTagName('phasename')[0]||p.getElementsByTagName('phasenamephasename')[0];
    if(!nameNode) continue;
    const phase=nameNode.textContent.trim();
    const judges=[...p.getElementsByTagName('JudgementPart')];
    for(const j of judges){
      const jn=j.getElementsByTagName('judgeName')[0]?.textContent?.trim();
      const rawVal=(j.getElementsByTagName('metrics')[0]?.textContent||'').trim();
      const val=rawVal===''? undefined: Number(rawVal);
      const unit=j.getElementsByTagName('unit')[0]?.textContent?.trim();
      if(!jn) continue;
      if(val===undefined || Number.isNaN(val)) continue;
      if(!phaseMap[phase]) phaseMap[phase]={};
      phaseMap[phase][jn]={value:val,unit};
    }
  }
  return phaseMap;
}

// 閾値CSVパース -> { id: {phase, judge, valueType, judgeType, min, max, unit} }
function parseThresholdCsv(text){
  const rows=parseCsv(text).filter(r=>r.some(c=>c&&c.trim().length));
  // 掃除: 最初の空行などをスキップし、ヘッダ行を検出
  const headerIdx=rows.findIndex(r=>r[0]==='閾値対応番号');
  const dataRows=headerIdx>=0?rows.slice(headerIdx+1):rows;
  const map={};
  for(const r of dataRows){
    // CSVは [ID, phase, judge, 値, 判定タイプ, 閾値上限, 閾値下限, 単位]
    const [id,phase,judge,valueType,judgeType,maxCol,minCol,unit]=r;
    if(!id||!phase||!judge) continue;
    // 数値へ変換し、下限<=上限 になるよう正規化
    const nMax = (maxCol!==undefined && maxCol!=='' && maxCol!=='-' ? Number(maxCol) : undefined);
    const nMin = (minCol!==undefined && minCol!=='' && minCol!=='-' ? Number(minCol) : undefined);
    const hasBoth = (typeof nMax==='number' && !Number.isNaN(nMax)) && (typeof nMin==='number' && !Number.isNaN(nMin));
    const minVal = hasBoth ? Math.min(nMin, nMax) : (typeof nMin==='number' && !Number.isNaN(nMin) ? nMin : undefined);
    const maxVal = hasBoth ? Math.max(nMin, nMax) : (typeof nMax==='number' && !Number.isNaN(nMax) ? nMax : undefined);
    map[id.trim()]=({
      phase:phase.trim(),
      judge:judge.trim(),
      valueType:(valueType||'').trim(),
      judgeType:(judgeType||'').trim(),
      min: minVal,
      max: maxVal,
      unit: (unit||'').trim()
    });
  }
  return map;
}

// 対応表CSV: 行ごとに { part, pattern, thresholdIds[] }
function parseMappingCsv(text){
  const rows=parseCsv(text);
  const header=rows[0]||[];
  const partIdx=header.indexOf('部位');
  const patternIdx=header.indexOf('パターン番号');
  const thresholdIdx=header.indexOf('閾値対応番号');
  if(partIdx<0||patternIdx<0||thresholdIdx<0) throw new Error('対応表CSVのヘッダを確認してください');
  return rows.slice(1).filter(r=>r.length>0&&r[partIdx]).map(r=>({
    part:r[partIdx].trim(),
    pattern:Number(r[patternIdx]),
    thresholdIds:r[thresholdIdx].split(',').map(s=>s.trim()).filter(Boolean)
  }));
}

// AIアドバイスCSV: 1行目ヘッダ [前傾角度,体重移動,トップ・振り幅の評価,フォロー・振り幅の評価,AIコメント]
function parseAdviceCsv(text){
  const rows=parseCsv(text);
  const header=rows[0]||[];
  const idxs={
    forwardTilt: header.indexOf('前傾角度'),
    weightShift: header.indexOf('体重移動'),
    topEval: header.indexOf('トップ・振り幅の評価'),
    followEval: header.indexOf('フォロー・振り幅の評価'),
    comment: header.indexOf('AIコメント')
  };
  if(Object.values(idxs).some(i=>i<0)) throw new Error('AIアドバイス結果CSVのヘッダを確認してください');
  const table=new Map();
  for(const r of rows.slice(1)){
    if(!r.length) continue;
    const key=[r[idxs.forwardTilt],r[idxs.weightShift],r[idxs.topEval],r[idxs.followEval]].join('|');
    table.set(key,(r[idxs.comment]||'').trim());
  }
  return table;
}

function computeRelativeValue(threshold, jdg){
  // 相対値: 同一judgenameの phase 値と address 値の差（phase - address）
  const baseReading=jdg['address']?.[threshold.judge];
  const currentReading=jdg[threshold.phase]?.[threshold.judge];
  const base=baseReading?.value;
  const current=currentReading?.value;
  const baseUnit=baseReading?.unit;
  const curUnit=currentReading?.unit;
  if(base===undefined||current===undefined){
    return {value:undefined, unit:curUnit, unitMismatch:false, missing:true, formula:`${threshold.phase} - address`, formulaVerbose:''};
  }
  // 単位が両方あり、かつ不一致ならミスマッチ
  const unitMismatch = !!(baseUnit && curUnit && baseUnit!==curUnit);
  // 仕様: phase - address に統一
  const diff = current - base;
  const u = curUnit || baseUnit || '';
  const fmt = (n)=> (typeof n==='number' && !Number.isNaN(n) ? n.toFixed(2) : String(n));
  const formulaVerbose = `${threshold.phase}(${threshold.judge})=${fmt(current)}${u} − address(${threshold.judge})=${fmt(base)}${u} = ${fmt(diff)}${u}`;
  return {value: diff, unit: u, unitMismatch, missing:false, formula:`${threshold.phase} - address`, formulaVerbose};
}

function computeAbsoluteValue(threshold, jdg){
  const reading=jdg[threshold.phase]?.[threshold.judge];
  const value=reading?.value; const unit=reading?.unit;
  const fmt = (n)=> (typeof n==='number' && !Number.isNaN(n) ? n.toFixed(2) : String(n));
  const formulaVerbose = value===undefined? '' : `${threshold.phase}(${threshold.judge})=${fmt(value)}${unit||''}`;
  return {value, unit, unitMismatch:false, missing: value===undefined, formula:'', formulaVerbose};
}

function judgeAgainstThreshold(th, value){
  const min=th.min, max=th.max, type=th.judgeType;
  if(value===undefined||value===null||Number.isNaN(value)) return {ok:false,reason:'値なし'};
  if(type==='IN_RANGE'){
    if(min===undefined||max===undefined) return {ok:false,reason:'閾値未設定'};
    return {ok: value>=min && value<=max, reason:`${min}〜${max}`};
  }else if(type==='OUT_RANGE'){
    if(min===undefined||max===undefined) return {ok:false,reason:'閾値未設定'};
    return {ok: value<min || value>max, reason:`${min}〜${max}の外`};
  }
  return {ok:false,reason:'判定タイプ未対応'};
}

function buildPatternFromMapping(mappingRows, thresholdMap, jdg){
  // 4軸: 前傾角度 / 体重移動 / トップ評価 / フォロー評価 を mapping から抽出
  const result={ '前傾角度':0, '体重移動':0, 'トップ・振り幅の評価':0, 'フォロー・振り幅の評価':0 };
  const details=[]; const warnings=[]; const unitMismatches=[];

  // 部位ごとに候補パターンを評価
  const byPart=new Map();
  for(const row of mappingRows){
    if(!byPart.has(row.part)) byPart.set(row.part, []);
    byPart.get(row.part).push(row);
  }

  for(const [part, rows] of byPart.entries()){
    // パターン番号でまとめる
    const byPattern=new Map();
    for(const r of rows){
      if(!byPattern.has(r.pattern)) byPattern.set(r.pattern, new Set());
      r.thresholdIds.forEach(id=>byPattern.get(r.pattern).add(id));
    }

    let bestPattern=0; let bestScore=-1; let bestOk=0; let bestTotal=0;

    for(const [pattern, idSet] of byPattern.entries()){
      let ok=0, total=0;
      for(const id of idSet){
        const th=thresholdMap[id];
        if(!th){ warnings.push(`閾値ID ${id} が見つかりません`); continue; }
        // 値取得
        let valueObj;
        if(th.valueType==='相対値'){
          valueObj=computeRelativeValue(th,jdg);
        }else{
          valueObj=computeAbsoluteValue(th,jdg);
        }
        // 相対値で基準/対象の単位不一致
        if(valueObj.unitMismatch){
          unitMismatches.push(`${part}(${id}): 相対値の単位不一致（address と ${th.phase}）`);
          continue;
        }
        // 単位不一致は警告のみでスキップ
        if(th.unit && valueObj?.unit && th.unit!==valueObj.unit){
          unitMismatches.push(`${part}(${id}): 単位不一致 ${valueObj.unit} != ${th.unit}`);
          continue;
        }
        // 閾値が未設定(数値でない)はスキップ
        if(th.judgeType && (th.min===undefined || th.max===undefined)){
          details.push({part,id,phase:th.phase,judge:th.judge,value:valueObj.value,unit:valueObj.unit,judgeType:th.judgeType,range:'閾値未設定',ok:false,skipped:true});
          continue;
        }
        // 値なしはスキップ
        if(valueObj.value===undefined || Number.isNaN(valueObj.value)){
          details.push({part,id,phase:th.phase,judge:th.judge,value:undefined,unit:valueObj.unit,judgeType:th.judgeType,range:'値なし',ok:false,skipped:true,formula:valueObj.formulaVerbose});
          continue;
        }
        const judged=judgeAgainstThreshold(th, valueObj.value);
        total++;
        if(judged.ok) ok++;
        details.push({part,id,phase:th.phase,judge:th.judge,value:valueObj.value,unit:valueObj.unit,judgeType:th.judgeType,range:judged.reason,ok:judged.ok,formula:valueObj.formulaVerbose});
      }
      // スコア: ok率優先、同率ならok数、さらに同点ならパターン番号小を優先
      const score = total>0 ? ok/total : -1;
      if(score>bestScore || (score===bestScore && (ok>bestOk || (ok===bestOk && pattern<bestPattern)))){
        bestScore=score; bestPattern=pattern; bestOk=ok; bestTotal=total;
      }
    }

    // 評価可能項目が全く無い場合は0にし、警告
    if(bestScore<0){
      warnings.push(`${part}: 評価可能な閾値がありません（単位不一致や未設定の可能性）`);
      bestPattern=0;
    }
    result[part]=bestPattern;
  }

  return {pattern4: [result['前傾角度'],result['体重移動'],result['トップ・振り幅の評価'],result['フォロー・振り幅の評価']], details, warnings, unitMismatches};
}

function lookupAdvice(adviceTable, pattern4){
  const key=pattern4.join('|');
  return adviceTable.get(key) || '該当するコメントが見つかりません';
}

function renderResults(state){
  const warnEl=document.getElementById('warnings');
  const sumEl=document.getElementById('summary');
  const detEl=document.getElementById('details');

  const allWarnings=[...state.warnings];
  for(const u of state.unitMismatches||[]) allWarnings.push('単位警告: '+u);

  if(allWarnings.length){
    warnEl.classList.remove('hidden');
    warnEl.innerHTML = `<strong>警告</strong><ul>${allWarnings.map(w=>`<li>${w}</li>`).join('')}</ul>`;
  }else{ warnEl.classList.add('hidden'); warnEl.innerHTML=''; }

  sumEl.classList.remove('hidden');
  sumEl.innerHTML = `
    <div><strong>判定パターン</strong>: [${state.pattern4.join(', ')}]</div>
    <div><strong>AIコメント</strong>: ${state.advice}</div>
  `;

  detEl.classList.remove('hidden');
  const rows=state.details.map(d=>`<tr>
    <td>${d.part}</td><td>${d.id}</td><td>${d.phase}</td><td>${d.judge}</td>
    <td>${d.value??''}</td><td>${d.unit??''}</td><td>${d.formula||''}</td><td>${d.judgeType}</td><td>${d.range}</td><td>${d.ok?'OK':'NG'}</td>
  </tr>`).join('');
  detEl.innerHTML = `
    <h3>詳細</h3>
    <table>
      <thead>
        <tr><th>部位</th><th>関連ID</th><th>phase</th><th>judge</th><th>値</th><th>単位</th><th>計算式</th><th>タイプ</th><th>閾値</th><th>判定</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

document.getElementById('runBtn').addEventListener('click', async ()=>{
  const mappingFile=document.getElementById('mappingCsv').files[0];
  const adviceFile=document.getElementById('adviceCsv').files[0];
  const thresholdFile=document.getElementById('thresholdCsv').files[0];
  const jdgFile=document.getElementById('jdgFile').files[0];
  if(!mappingFile||!adviceFile||!thresholdFile||!jdgFile){
    alert('4ファイルをすべて選択してください');
    return;
  }
  try{
    const [mappingText, adviceText, thresholdText, jdgMap]=await Promise.all([
      mappingFile.text(), adviceFile.text(), thresholdFile.text(), parseJdg(jdgFile)
    ]);
    const mappingRows=parseMappingCsv(mappingText);
    const adviceTable=parseAdviceCsv(adviceText);
    const thresholdMap=parseThresholdCsv(thresholdText);

    // 今回はテストドリル: 対応表の4部位をそのまま使用
    const interested=['前傾角度','体重移動','トップ・振り幅の評価','フォロー・振り幅の評価'];
    const filtered=mappingRows.filter(r=>interested.includes(r.part));
    const {pattern4, details, warnings, unitMismatches}=buildPatternFromMapping(filtered, thresholdMap, jdgMap);
    const advice=lookupAdvice(adviceTable, pattern4);
    renderResults({pattern4, details, warnings, unitMismatches, advice});
  }catch(err){
    console.error(err);
    const warnEl=document.getElementById('warnings');
    warnEl.classList.remove('hidden');
    warnEl.textContent='エラー: '+(err?.message||String(err));
  }
});


