(function attach(root,factory){
  const node=typeof module!=="undefined"&&module.exports;
  const api=factory(node?require("../contextual-reasoning.js"):root.YuliuContextualReasoning,
    node?require("./review-ablation.js"):root.YuliuReviewAblation,
    node?require("../contextual-lightweight.js"):root.YuliuContextualLightweight);
  if(node)module.exports=api;
  root.YuliuLightweightComparison=api;
})(globalThis,function(R,A,L){
  const VERSION="lightweight-comparison-v2",CASE_IDS=A.CASE_IDS,MODELS=A.MODELS;
  async function runCase(request,options){
    if(!MODELS.includes(options.model)||!["A-L","L-A"].includes(options.order))throw new Error("INVALID_COMPARISON_OPTIONS");
    const evidence=R.evidenceFor(request);
    if(!R.occurrenceFor(request,evidence))throw new Error("INVALID_SELECTED_OCCURRENCE");
    const history=[],arms={},started=Date.now();
    for(const arm of options.order.split("-")){
      const began=Date.now(),entry={stage:arm==="A"?"A_direct":"L_lightweight",requested_model:options.model,
        messages:arm==="A"?A.simpleMessages(request,evidence):L.candidateMessages(request,evidence),
        max_tokens:2100,status:"running",raw:"",reported_model:null};
      history.push(entry);
      try{
        const res=await options.complete({messages:entry.messages,maxTokens:2100,fixedModel:options.model,includeMetadata:true});
        if(typeof res?.content!=="string"||!res.content.trim())throw new Error("EMPTY_MODEL_RESPONSE");
        entry.raw=res.content;entry.reported_model=res.reported_model||null;entry.parameters=res.parameters;
        entry.status="completed";
      }catch(e){entry.status="failed";entry.error=String(e.message||"MODEL_REQUEST_FAILED");}
      entry.elapsed_ms=Date.now()-began;
      if(entry.status==="failed"){
        arms[arm]={text:"",citations:[],status:"failed",error:entry.error,elapsed_ms:entry.elapsed_ms};continue;
      }
      if(arm==="A"){
        const ids=[...new Set([...entry.raw.matchAll(/\[(e\d+)\]/g)].map(m=>m[1]))];
        arms.A={text:entry.raw,citations:ids.map(id=>evidence.find(e=>e.evidence_id===id)||{evidence_id:id,quote:"未提供此编号"}),
          citation_kind:"原A标注的候选片段；未校验语义支持",status:"completed",error:"",elapsed_ms:entry.elapsed_ms,rating:"unrated"};
      }else{
        const parsed=L.parseCandidate(entry.raw,evidence);
        arms.L={...parsed,raw:entry.raw,status:parsed.error?"protocol_error":"completed",
          elapsed_ms:entry.elapsed_ms,rating:"unrated",
          citation_kind:"只检查来源编号和连续引文定位；未进行模型核验，不保证语义支持。引用错误不删除释义。"};
      }
    }
    return {experiment_version:VERSION,ruleset:L.CANDIDATE_VERSION,model:options.model,order:options.order,arms,history,
      input:R.inputFor(request,evidence),selected_occurrence:R.occurrenceFor(request,evidence),
      actual_http_calls:history.length,elapsed_ms:Date.now()-started,human_review_required:true,
      fixed_model_confirmed:history.every(h=>h.status==="completed"&&h.reported_model===options.model),
      caveat:"A基线提示未改；L为轻量候选，均单次调用，无核验、重试或模型切换。A/L同时改变指令和格式，不是格式单变量实验。"};
  }
  return {VERSION,CASE_IDS,MODELS,runCase};
});
