const IDS = ["transfer-window-time", "transfer-window-ui", "transfer-person-roster", "transfer-condition"];
const ATTRIBUTION = document.body?.dataset?.experiment === "attribution";
const LIGHT = ATTRIBUTION || document.body?.dataset?.experiment === "lightweight";
const VARIANT_LABELS = {original:"原顺序与编号",reverse:"只换顺序（编号跟着来源）",renumber:"只换编号（顺序不变）"};
const JOBS = IDS.flatMap(id=>ATTRIBUTION ? Object.keys(VARIANT_LABELS).map(variant=>({id,variant})) : [{id}]);
const PREFIX = ATTRIBUTION ? "ATTRIBUTION" : LIGHT ? "LIGHTWEIGHT" : "REVIEW_ABLATION";
const STARTUP = ATTRIBUTION ? "attribution-startup-v1" : LIGHT ? "lightweight-startup-v2" : "ablation-startup-v2";
const ARMS = ATTRIBUTION ? [["L1","L1 · 原轻量候选"],["L2","L2 · 仅调整引用指令"]]
  : LIGHT ? [["A","A · 原直接解释"],["L","L · 轻量候选（非正式版）"]]
  : [["A","A · 直接解释"],["B","B · 结构化生成"],["C","C · 同稿加核验"]];
const ARM_IDS = ARMS.map(([id])=>id);
const VERSION = ATTRIBUTION ? "citation-attribution-v1" : LIGHT ? "lightweight-comparison-v2" : "review-ablation-v1";
const GROUP_LABEL = LIGHT ? "两组均正常返回 " : "三组均正常返回 ";
const POINTER = ATTRIBUTION ? "yuliuCitationAttributionLatest" : LIGHT ? "yuliuLightweightComparisonV2Latest" : "yuliuReviewAblationLatest";
const $ = (id) => document.getElementById(id);
let dataset, report, running = false, stopped = false;
function node(tag, text) { const e = document.createElement(tag); if (text != null) e.textContent = text; return e; }
function detail(parent, title, text) { const d = node("details"); d.append(node("summary", title), node("pre", text)); parent.append(d); }
function sec(parent, title, text) { parent.append(node("h4",title), node("p", text)); }
function warningLabel(value) {
  const [code,id] = value.split(":");
  const labels = {INVALID_INTENT_FORMAT:"表达作用格式异常，原始输出保留供查看",
    MISSING_REFERENCES_FORMAT:"未提供规范的引用列表",NO_DOCUMENT_CITATIONS:"未附文内引用；可能是常识或未知说明，不能视为原文已证实",
    UNKNOWN_SOURCE:"来源编号不存在",MISSING_OR_DUPLICATE_REFERENCE:"引用片段缺失或同一编号重复",
    EMPTY_QUOTE:"引用片段为空",QUOTE_NOT_FOUND:"引用内容无法在所给原文中精确找到",
    AMBIGUOUS_QUOTE:"同一句出现多次，不能唯一定位",UNUSED_REFERENCE:"提供了正文未使用的引用",
    AMBIGUOUS_REPAIR:"引文有多个匹配位置，未自动纠号",REPAIR_CONFLICT:"纠号会合并不同来源标记，未自动修改"};
  return (labels[code]||code)+(id?"（"+id+"）":"");
}
let saveQueue = Promise.resolve();
function counts() {
  const rows = report?.rows || [];
  return {attempted_cases:rows.length, completed_cases:rows.filter(r =>
    !r.error && ARM_IDS.every(id => r.result?.arms?.[id]?.status === "completed")).length,
    recorded_http_calls:rows.reduce((n,r)=>n+(r.result?.actual_http_calls||0),0)};
}
function save() {
  Object.assign(report, counts());
  const snapshot = JSON.parse(JSON.stringify(report));
  saveQueue = saveQueue.catch(() => {}).then(() => chrome.storage.local.set({[snapshot.storage_key]:snapshot, [POINTER]:snapshot.storage_key}));
  return saveQueue;
}
function summary() {
  $("summary").replaceChildren();
  if (!report) { $("summary").append(node("p","尚无实测结果，不预设获胜方案。")); return; }
  const totals = counts();
  $("summary").append(node("p", "运行记录：" + report.generated_at + "；" + report.model + "；" + GROUP_LABEL
    + totals.completed_cases + "/" + report.planned + " 组；已尝试 " + totals.attempted_cases
    + " 组；已记录请求 " + totals.recorded_http_calls + " 次。正常返回不等于答案正确。"));
  if (report.startup_error) $("summary").append(node("p", "启动检查失败，未发出模型请求：" + report.startup_error));
  for (const id of ARM_IDS) {
    const all = report.rows.map(r=>r.result?.arms[id]).filter(Boolean);
    const completed = all.filter(a=>a.status === "completed");
    const correct = all.filter(a=>a.rating === "correct").length;
    const rated = all.filter(a=>a.rating && a.rating !== "unrated").length;
    const average = completed.length ? (completed.reduce((n,a)=>n+a.elapsed_ms,0)/completed.length/1000).toFixed(2) : "—";
    $("summary").append(node("p", id + "：正常返回 " + completed.length + "/" + all.length + "，仅正常返回平均耗时 " + average
      + " 秒；人工已评 " + rated + "，其中正确 " + correct + "。正常返回不等于正确。"));
  }
  const unconfirmed = report.rows.filter(r=>r.result && !r.result.fixed_model_confirmed).length;
  if (unconfirmed) $("summary").append(node("p", "注意：" + unconfirmed + " 组未获得所有请求的同模型确认（可能失败或服务未报告型号），不要混入已确认组作胜负结论。"));
}
function render(row) {
  const item = dataset.cases.find(c=>c.id===row.id);
  const card = node("article"); card.className = "context-case";
  card.append(node("h2","第"+row.round+"轮 · "+item.selection+" · "+item.id));
  if(ATTRIBUTION) sec(card,"证据扰动条件",VARIANT_LABELS[row.variant]||row.variant);
  sec(card,"选中位置","[p"+item.anchor+"] "+item.blocks[item.anchor]);
  detail(card,"完整测试原文",item.blocks.map((t,i)=>"[p"+i+"] "+t).join("\n\n"));
  detail(card,"人工参考与判定边界（不发给模型）",item.expected);
  if (row.error) { sec(card,"未完成",row.error); $("cases").append(card); return; }
  sec(card,"控制变量",row.result.model+"；顺序 "+row.result.order+"；模型报告确认："+row.result.fixed_model_confirmed);
  if(ATTRIBUTION){
    sec(card,"本组实际输入排列（不是原文先后）",(row.result.evidence_mapping||[])
      .map(e=>"第"+e.position+"条：["+e.id+"] → "+e.block_id+"（原编号 "+e.original_id+"）").join("；"));
    detail(card,"实际送入模型的选区与证据",JSON.stringify(row.result.input,null,2));
  }
  const grid = node("div"); grid.className="ablation-grid";
  for (const [id,title] of ARMS) {
    const a = row.result.arms[id], col=node("section"); col.className="ablation-arm";
    col.append(node("h3",title),node("p","状态："+a.status+"；方案耗时 "+(a.elapsed_ms/1000).toFixed(2)+" 秒"));
    if(id==="C" && a.review_elapsed_ms != null) col.append(node("p","其中核验新增 "+(a.review_elapsed_ms/1000).toFixed(2)+" 秒"));
    sec(col,"实际回答",a.text || "未产生可展示答案；下方保留原始输出（如有）");
    if(a.error) sec(col,"异常",a.error);
    if(a.warnings?.length) sec(col,"引用或格式提醒（不等于释义错误）",a.warnings.map(warningLabel).join("\n"));
    if(a.corrections?.length){
      sec(col,"程序纠正了来源编号（未判定语义支持）",a.corrections.map(c=>
        c.from+" → "+c.to+"；"+c.block_id+"；原文："+c.quote).join("\n"));
      detail(col,"纠号前的模型回答",a.original_text);
    }
    sec(col,"依据性质",a.citation_kind || "无");
    sec(col,"正文编号对应的引用（未独立核验语义支持）",(a.citations||[]).map(e=>"["+e.evidence_id+"/"+(e.block_id||"?")+"] "+e.quote).join("\n\n") || "无");
    // Derive a presentation from saved raw output without rewriting historical report fields.
    let sources=a;
    if(id==="L"&&a.raw&&globalThis.YuliuContextualLightweight){
      const evidence=row.result.input?.evidence;
      if(Array.isArray(evidence)){
        sources=globalThis.YuliuContextualLightweight.parseCandidate(a.raw,evidence);
        sec(col,"来源展示说明","以下按当前解析规则回放原始输出，不调用模型、不改写旧报告。引文能定位不代表与答案相关或足以支持答案。");
      }
    }
    if(sources.related_sources?.length)sec(col,"模型列出的原文（未绑定具体句子，相关性与支持程度待核对）",
      sources.related_sources.map(e=>"["+e.evidence_id+"/"+e.block_id+"] "+e.quote).join("\n\n"));
    if(sources.unrecognized_markers?.length)sec(col,"未识别的正文标记",
      sources.unrecognized_markers.join("、")+"：是段落编号，未自动当作证据引用或改写正文。");
    if(sources.unresolved_references?.length)detail(col,"未能定位或绑定的来源（不作为有效依据展示）",
      JSON.stringify(sources.unresolved_references,null,2));
    const label=node("label","人工判断答案："), select=node("select");
    for(const [v,t] of [["unrated","尚未评审"],["correct","正确且有用"],["partial","部分正确／需要修正"],["wrong","错误／没有有效回答"]]){
      const o=node("option",t);o.value=v;select.append(o);
    }
    select.value=a.rating||"unrated";
    select.addEventListener("change",async()=>{a.rating=select.value;summary();try{await save();}catch(e){$("progress").textContent="保存失败，请导出："+e.message;}});
    label.append(select); col.append(label);
    const evidenceLabel=node("label"," 引用支持程度："), evidenceSelect=node("select");
    for(const [v,t] of [["unrated","尚未评审"],["supported","充分支持"],["partial","部分支持"],["unsupported","不支持／缺失"],["not_needed","常识或未知，无需引用"]]){
      const o=node("option",t);o.value=v;evidenceSelect.append(o);
    }
    evidenceSelect.value=a.evidence_rating||"unrated";
    evidenceSelect.addEventListener("change",async()=>{a.evidence_rating=evidenceSelect.value;try{await save();}catch(e){$("progress").textContent="保存失败，请导出："+e.message;}});
    evidenceLabel.append(evidenceSelect);col.append(evidenceLabel);
    if(a.changes) detail(col,"核验逐项改了什么",a.changes.map(c=>c.id+"\n之前："+c.before+"\n之后："+(c.after||"已删除")
      +"\n原引用："+c.before_refs.join(",")+" → 新引用："+c.after_refs.join(",")+"\n核验理由："+c.reason).join("\n\n"));
    const stages={A:"A_direct",B:"B_generation",C:"C_review",L:"L_lightweight",L1:"L1_attribution",L2:"L2_attribution"};
    const calls=row.result.history.filter(h=>h.stage===stages[id]);
    detail(col,"原始模型输出、指令与耗时",JSON.stringify(calls,null,2));grid.append(col);
  }
  card.append(grid);$("cases").append(card);
}
async function init(){
  if(!globalThis.chrome?.runtime?.id || !chrome.storage?.local) {
    throw new Error("请在 Chrome 的语流扩展内部打开：语流设置 → 诊断后台 → 对应实验入口。普通 file:// 预览不能调用扩展密钥。");
  }
  dataset=await(await fetch(chrome.runtime.getURL("evaluation/fixtures/contextual-transfer-v1.json"))).json();
  if(IDS.some(id=>!dataset.cases.some(c=>c.id===id))) throw new Error("案例缺失");
  const pointer=await chrome.storage.local.get(POINTER);
  if(pointer[POINTER]) report=(await chrome.storage.local.get(pointer[POINTER]))[pointer[POINTER]];
  if(report?.experiment_version!==VERSION) report=null;
  $("run").disabled=false;$("export").disabled=!report;
  if(report){for(const row of report.rows) render(row);}
  summary();$("progress").textContent=report?"已加载上次对照结果；不会自动发请求。":"准备就绪。请先重新加载扩展，随后开始。";
}
$("run").addEventListener("click",async()=>{
  if(running || !dataset)return;
  running=true;stopped=false;
  for(const id of ["run","model","rounds"])$(id).disabled=true;
  $("stop").disabled=false;$("cases").replaceChildren();
  const rounds=Number($("rounds").value), model=$("model").value;
  report={experiment_version:VERSION,mode:"live-model",generated_at:new Date().toISOString(),
    storage_key:(ATTRIBUTION?"yuliuCitationAttribution-":LIGHT?"yuliuLightweightComparison-":"yuliuReviewAblation-")+crypto.randomUUID(),model,rounds,planned:rounds*JOBS.length,rows:[],
    design:{shared_draft_B_C:!LIGHT,arms:ARM_IDS,retries:0,timeout_ms:15000,temperature:0,max_tokens:2100,
      expectation_sent_to_model:false,case_source:"已见虚构开发集",quality_judge:"manual",
      variants:ATTRIBUTION?Object.keys(VARIANT_LABELS):undefined,
      limitation:ATTRIBUTION?"4个已见案例，分别扰动证据顺序和编号；L2仅改归因指令。原文、选区、格式和预算不变。每组两次单次生成，非独立泛化验收"
        :LIGHT?"原A与轻量候选均单次调用，指令和格式同时变化；已见小样本，非独立泛化验收"
        :"小样本组件消融，非全生产流程；A/B同时改变指令和格式；非独立泛化验收"}};
  try{
    await save();
    $("progress").textContent="正在检查后台脚本、案例和密钥配置；此步骤不调用模型。";
    let ready;
    try { ready = await chrome.runtime.sendMessage({type:PREFIX+"_PREFLIGHT"}); }
    catch (_) { ready = {ok:false, error:"无法连接实验后台。请重新加载语流扩展，再重新打开测试页。"}; }
    if (!ready?.ok || ready.startup_version !== STARTUP) {
      report.startup_error = ready?.error || "后台仍是旧版或未响应，请重新加载语流扩展，再重新打开测试页。";
      throw new Error(report.startup_error);
    }
    report.startup_version = ready.startup_version;
    for(let round=1;round<=rounds;round++){
      for(let i=0;i<JOBS.length;i++){
        if(stopped)break;
        const {id,variant}=JOBS[i],order=ATTRIBUTION?((round+i)%2?"L1-L2":"L2-L1")
          :LIGHT?((round+i)%2?"A-L":"L-A"):((round+i)%2?"A-BC":"BC-A");
        $("progress").textContent="正在运行 "+(report.rows.length+1)+"/"+report.planned+"："+id+"，第"+round+"轮。每例最多"+(LIGHT?2:3)+"次请求。";
        if(ATTRIBUTION)$("progress").textContent+=" 条件："+VARIANT_LABELS[variant];
        let response;
        try{response=await chrome.runtime.sendMessage({type:PREFIX+"_CASE",caseId:id,model,order,variant});}
        catch(e){response={ok:false,error:e.message};}
        const row={id,round,order,variant,source:dataset.cases.find(c=>c.id===id),result:response?.result||null,
          error:response?.ok?"":response?.error||"没有收到实验响应；请确认已重新加载扩展"};
        report.rows.push(row);render(row);summary();await save();$("export").disabled=false;
        if(!response?.ok){stopped=true;break;}
      }
      if(stopped)break;
    }
    report.stopped=stopped;report.finished_at=new Date().toISOString();await save();
    $("progress").textContent=(stopped?"已停止":"运行结束")+"："+GROUP_LABEL+counts().completed_cases+"/"+report.planned
      +"；已尝试 "+report.rows.length+" 组。请检查失败记录和实际答案，正常返回不代表正确。";
  }catch(e){
    $("progress").textContent=(report.startup_error?"启动失败，完成 0/"+report.planned+"：":"实验未完成：")
      +e.message+"；诊断记录可导出。";
    report.finished_at=new Date().toISOString();
    try { await save(); } catch (_) { $("progress").textContent+=" 本地保存失败，请直接导出。"; }
  }
  finally{summary();running=false;for(const id of ["run","model","rounds"])$(id).disabled=false;$("stop").disabled=true;$("export").disabled=!report;}
});
$("stop").addEventListener("click",()=>{stopped=true;$("progress").textContent="停止已请求：完成当前案例后结束，不再开始下一例。";});
$("export").addEventListener("click",()=>{
  if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:"application/json"}));
  const a=node("a");a.href=url;a.download=ATTRIBUTION?"语流-citation-attribution-v1-实测.json":LIGHT?"语流-lightweight-comparison-v2-实测.json":"语流-review-ablation-v1-三组实测.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
});
init().catch(e=>{$("progress").textContent=e.message;});
