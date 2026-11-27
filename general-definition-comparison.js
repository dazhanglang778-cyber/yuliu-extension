/* Extension page only. Model output is text, never HTML. */
'use strict';
const KEY='yuliuGeneralSearchComparisonV1', REVIEWS='yuliuGeneralSearchReviewsV1';
const $=id=>document.getElementById(id);
let reports=[],reviews={},inFlight=false;
const drafts={};
function node(tag,text,parent){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(parent)parent.append(n);return n;}
function url(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
function link(parent,href,text){const a=node('a',text,parent);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;}
function answer(parent,row){
  const text=row.content || '',citations=row.search?.citations || [];let pos=0;
  const p=node('div',undefined,parent);p.className='answer';
  for(const c of [...citations].sort((a,b)=>a.start-b.start)){
    if(!url(c.url)||!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<pos||c.end<=c.start||c.end>text.length)continue;
    p.append(document.createTextNode(text.slice(pos,c.start)));
    link(p,url(c.url),text.slice(c.start,c.end)||c.title);pos=c.end;
  }
  p.append(document.createTextNode(text.slice(pos)));
  if(citations.length){
    const list=node('ul',undefined,parent);
    for(const c of citations)if(url(c.url))link(node('li',undefined,list),url(c.url),c.title||c.url);
  }
}
function render(){
  $('results').replaceChildren();$('export').disabled=!reports.length;
  for(const r of [...reports].reverse()){
    const art=node('article',undefined,$('results'));
    node('h2',`${r.case.term} · ${r.order} · ${new Date(r.startedAt).toLocaleString()}`,art);
    node('p','公开输入：'+r.case.context,art);
    node('p','人工检查重点（不发送给模型）：'+r.case.check,art);
    node('p',`固定模型：${r.model}；${r.status==='completed'?'本例已结束（不代表通过）':`尚未结束，当前 ${r.activeArm||'准备'} 组；若页面或扩展重启后一直不更新，导出已有记录，不要视作已完成。`}`,art);
    const cols=node('div',undefined,art);cols.className='columns';
    for(const arm of ['A','B']){
      const box=node('section',undefined,cols);box.className='arm';node('h3',arm==='A'?'A · 直接生成':'B · 搜索辅助',box);
      const row=r.rows.find(x=>x.arm===arm);
      if(!row){node('p','尚未返回。',box);continue;}
      if(row.status==='error')node('p',row.error,box).className='error';else answer(box,row);
      node('p',`请求耗时 ${(row.elapsedMs/1000).toFixed(2)} 秒；首段文本到达后台 ${row.firstTextMs===null?'—':(row.firstTextMs/1000).toFixed(2)+' 秒'}。这是后台模型时间，不是本页首次显示时间。`,box).className='meta';
      node('p',`实际模型：${row.actualModel||'未返回'}；输入 Token ${row.usage?.input_tokens??'未返回'}，输出 Token ${row.usage?.output_tokens??'未返回'}；工具调用 ${row.search?.calls?.length??0} 次（非美元费用）。`,box).className='meta';
      if(arm==='B')node('p',({calls_and_citations:'已返回搜索调用与引用；引用存在不代表内容正确。',calls_without_citations:'有搜索调用，但没有可用引用，请人工检查。',no_completed_call:'未确认有完成的搜索调用，不能算作搜索成功。'})[row.searchEvidence]||'搜索未完成。',box);
      const details=node('details',undefined,box);node('summary','查看实际输入、工具调用、来源及用量',details);
      node('pre',JSON.stringify({messages:row.messages,search:row.search,usage:row.usage,parameters:row.parameters},null,2),details);
      const consulted=new Map((row.search?.calls||[]).flatMap(c=>c.sources||[]).filter(s=>url(s.url)).map(s=>[s.url,s]));
      if(consulted.size){const d=node('details',undefined,box);node('summary','检索参考来源（不等于答案逐条采用）',d);for(const s of consulted.values())link(node('p',undefined,d),url(s.url),s.title||s.url);}
    }
    const label=node('label','你的判断：哪边增加了正确知识？有没有错义、个案冒充定义或来源不支持？',art);
    const input=node('textarea',undefined,label);input.value=drafts[r.id]??reviews[r.id]??'';
    input.addEventListener('input',()=>{drafts[r.id]=input.value;});
    const save=node('button','保存人工评价',art);save.addEventListener('click',async()=>{reviews[r.id]=input.value;await chrome.storage.local.set({[REVIEWS]:reviews});save.textContent='已保存';});
  }
}
async function load(){const s=await chrome.storage.local.get([KEY,REVIEWS]);reports=Array.isArray(s[KEY])?s[KEY]:[];reviews=s[REVIEWS]||{};render();}
for(const c of YuliuGeneralComparison.cases){const o=node('option',c.term,$('case'));o.value=c.id;}
$('case').value='ids';
$('run').addEventListener('click',async()=>{
  if(inFlight)return;inFlight=true;$('run').disabled=true;$('status').textContent='正在运行，请勿重复点击。每组最多 90 秒，可切换去做其他事。';
  try{const r=await chrome.runtime.sendMessage({type:'GENERAL_SEARCH_COMPARE',caseId:$('case').value,order:$('order').value});$('status').textContent=r?.ok?'本例结束。请比较具体回答并填写评价，可导出报告。':r?.error||'没有收到后台确认。';}
  catch{$('status').textContent='后台连接中断。请查看已保存结果；不会自动重试。';}
  finally{inFlight=false;$('run').disabled=false;await load();}
});
$('export').addEventListener('click',()=>{
  const blob=new Blob([JSON.stringify({schema:'general-search-comparison-export-v1',exportedAt:Date.now(),reports,reviews},null,2)],{type:'application/json'});
  const u=URL.createObjectURL(blob),a=node('a');a.href=u;a.download='语流-general-search-comparison-v1-实测.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
});
globalThis.chrome?.storage?.onChanged?.addListener((changes,area)=>{if(area==='local'&&changes[KEY])void load();});
async function init(){
  if(!globalThis.chrome?.runtime?.id){$('status').textContent='请从语流扩展的诊断后台打开，不要直接打开本地 HTML。';return;}
  const s=await chrome.storage.local.get('openaiModel');$('model').textContent='当前模型：'+(s.openaiModel||'gpt-6-astra')+'（每例开始时固定；不会自动换模型）';
  await load();$('run').disabled=false;
}
void init();
