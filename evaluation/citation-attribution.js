(function attach(root,factory){
  const node=typeof module!=="undefined"&&module.exports;
  const api=factory(node?require("../contextual-reasoning.js"):root.YuliuContextualReasoning,
    node?require("./review-ablation.js"):root.YuliuReviewAblation,
    node?require("../contextual-lightweight.js"):root.YuliuContextualLightweight);
  if(node)module.exports=api;
  root.YuliuCitationAttribution=api;
})(globalThis,function(R,A,L){
  const VERSION="citation-attribution-v1",CASE_IDS=A.CASE_IDS,MODELS=A.MODELS;
  const VARIANTS=["original","reverse","renumber"];
  // Only the attribution paragraph changes; generation policy and JSON schema stay identical.
  const originalAttribution=L.PROMPT.split("\n").find(line=>line.startsWith("在文内结论"));
  if(!originalAttribution)throw new Error("ATTRIBUTION_PROMPT_ANCHOR_MISSING");
  const PROMPT=L.PROMPT.replace(originalAttribution,
    "来源编号和片段排列只用于定位，不表示支持力度；不要默认引用第一条或e1。按解释中实际表达的信息对应来源：若不同分句依赖不同片段，分别在对应分句末标实际编号；若同一结论须联合多段才能成立，标齐必要来源。只提到选中词的片段，未必支持它的身份、对象、条件或关系。单段足够时只引用该段，不为凑数量增加引用。常识和未知不伪装成原文结论。references为正文实际用到的每个编号摘取最短但完整支持相关信息的连续原文，不省略、不改写；不输出额外核验字段或解释过程。");
  function transform(evidence,variant){
    if(!VARIANTS.includes(variant))throw new Error("INVALID_ATTRIBUTION_VARIANT");
    if(evidence.length!==2||new Set(evidence.map(e=>e.evidence_id)).size!==2)
      throw new Error("ATTRIBUTION_REQUIRES_TWO_DISTINCT_SOURCES");
    const copy=evidence.map(e=>({...e}));
    if(variant==="reverse")copy.reverse();
    if(variant==="renumber")copy.forEach((e,i)=>{e.evidence_id=evidence[1-i].evidence_id;});
    return copy;
  }
  async function runCase(request,options){
    if(!MODELS.includes(options.model)||!["L1-L2","L2-L1"].includes(options.order))
      throw new Error("INVALID_ATTRIBUTION_OPTIONS");
    const original=R.evidenceFor(request),evidence=transform(original,options.variant);
    const occurrence=R.occurrenceFor(request,evidence);
    if(!occurrence)throw new Error("INVALID_SELECTED_OCCURRENCE");
    const history=[],arms={},started=Date.now();
    for(const arm of options.order.split("-")){
      const began=Date.now(),messages=L.messages(request,evidence);
      if(arm==="L2")messages[0]={role:"system",content:PROMPT};
      const entry={stage:arm+"_attribution",requested_model:options.model,messages,
        max_tokens:2100,status:"running",raw:"",reported_model:null};
      history.push(entry);
      try{
        const res=await options.complete({messages,maxTokens:2100,fixedModel:options.model,includeMetadata:true});
        if(typeof res?.content!=="string"||!res.content.trim())throw new Error("EMPTY_MODEL_RESPONSE");
        entry.raw=res.content;entry.reported_model=res.reported_model||null;entry.parameters=res.parameters;
        entry.status="completed";
      }catch(e){entry.status="failed";entry.error=String(e.message||"MODEL_REQUEST_FAILED");}
      entry.elapsed_ms=Date.now()-began;
      if(entry.status==="failed"){
        arms[arm]={text:"",citations:[],status:"failed",error:entry.error,elapsed_ms:entry.elapsed_ms};continue;
      }
      const parsed=L.parse(entry.raw,evidence);
      arms[arm]={...parsed,raw:entry.raw,status:parsed.error?"protocol_error":"completed",
        elapsed_ms:entry.elapsed_ms,rating:"unrated",
        citation_kind:"仅检查编号和连续原文定位；不是语义正确性评分，引用警告不删除释义。",
        cited_blocks:[...new Set(parsed.citations.map(e=>e.block_id))],
        inline_ids:[...new Set([...parsed.text.matchAll(/\[(e\d+)\]/g)].map(m=>m[1]))]};
    }
    return {experiment_version:VERSION,ruleset:L.VERSION,model:options.model,order:options.order,
      variant:options.variant,arms,history,selected_occurrence:occurrence,
      input:JSON.parse(L.messages(request,evidence)[1].content),
      evidence_mapping:evidence.map((e,i)=>({position:i+1,id:e.evidence_id,block_id:e.block_id,
        original_id:original.find(x=>x.block_id===e.block_id&&x.source_start===e.source_start)?.evidence_id})),
      actual_http_calls:history.length,elapsed_ms:Date.now()-started,human_review_required:true,
      fixed_model_confirmed:history.every(h=>h.status==="completed"&&h.reported_model===options.model),
      caveat:"既有虚构开发样本；原文、选区、模型、格式与预算不变。分别扰动顺序和编号，L2仅更换归因指令；每组两次生成，无核验或重试。不能据此保证泛化。"};
  }
  return {VERSION,CASE_IDS,MODELS,VARIANTS,PROMPT,transform,runCase};
});

