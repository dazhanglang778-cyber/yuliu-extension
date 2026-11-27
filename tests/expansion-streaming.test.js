const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Parser=require('../parser');
const source=fs.readFileSync(require.resolve('../content.js'),'utf8');
function fn(name){const match=new RegExp('  (?:async )?function '+name+'\\(').exec(source);assert.ok(match,name);
  const start=match.index,next=/\n  (?:async )?function /.exec(source.slice(start+match[0].length));
  return source.slice(start,next?start+match[0].length+next.index:undefined);}
function harness(){
  const nodes=new Map(), calls=[],events=[];let messageHandler,disconnectHandler,sent,clock=100;
  function node(){return {hidden:false,disabled:false,textContent:'',dataset:{},classList:{add(){},remove(){},toggle(){}},scrollTo(){}};}
  const shadow={querySelector:s=>{if(!nodes.has(s))nodes.set(s,node());return nodes.get(s);},querySelectorAll:()=>[]};
  const port={onMessage:{addListener:f=>messageHandler=f},onDisconnect:{addListener:f=>disconnectHandler=f},
    postMessage:m=>{sent=m;},disconnect:()=>disconnectHandler?.()};
  const ctx={document:{getElementById:()=>({shadowRoot:shadow})},HOST_ID:'host',Parser,parseInitial:Parser.parseInitial,
    primaryBusy:false,expansionBusy:false,expansionRunId:0,expandedAnswers:{general:'',example:''},
    expansionPorts:new Set(),activeSources:[],activeSenseIdentity:null,normalAnswer:'这里指什么：测试概念。',activeDiagnosticSessionId:'s',
    requestTimings:new Map(),requestStreams:new Map(),performance:{now:()=>clock},
    chrome:{runtime:{connect:()=>port}},setTextWithCitationLinks:(el,text)=>el.textContent=text,
    setStreamText:(el,text)=>el.textContent=text,sendDiagnosticEvent:(...e)=>events.push(e),
    requestExpansionWithCheck:async(field)=>{calls.push(field);return {text:field+'解释'};}};
  vm.createContext(ctx);
  for(const name of ['startExpansion','requestExpansionModule','expansionStatus','disconnectExpansionPorts','setModuleStatus','setModuleError','refreshActionButtons','noteVisibleStream']) vm.runInContext(fn(name),ctx);
  return {ctx,nodes,calls,events,shadow,emit:(type,extra={})=>messageHandler({type,requestId:sent.requestId,...extra}),time:t=>clock=t};
}
test('展开只请求通用定义，例子需要显式点击；重试通用定义废弃旧例子',async()=>{
  const h=harness();await h.ctx.startExpansion({text:'术语'});
  assert.deepEqual(h.calls,['general']);assert.equal(h.ctx.expandedAnswers.example,'');
  const button=h.shadow.querySelector("[data-retry='example']");assert.equal(button.hidden,false);assert.equal(button.textContent,'举个例子');
  await h.ctx.startExpansion({text:'术语'},'example');assert.deepEqual(h.calls,['general','example']);
  assert.equal(h.ctx.expandedAnswers.general,'general解释');assert.equal(h.ctx.expandedAnswers.example,'example解释');
  await h.ctx.startExpansion({text:'术语'},'general');assert.equal(h.ctx.expandedAnswers.example,'');
  assert.deepEqual(h.calls,['general','example','general']);
});
test('通用定义未就绪、请求进行中时不能提前或重复生成例子',async()=>{
  const h=harness();await h.ctx.startExpansion({text:'词'},'example');assert.equal(h.calls.length,0);
  let release;h.ctx.requestExpansionWithCheck=()=>new Promise(r=>release=r);
  const pending=h.ctx.startExpansion({text:'词'},'general');
  assert.equal(h.ctx.expansionBusy,true);
  await h.ctx.startExpansion({text:'词'},'general');
  release({text:'定义'});await pending;assert.equal(h.ctx.expansionBusy,false);
});
test('通用定义在DONE前显示增量，完成后先标记检查中，不伪装已通过',async()=>{
  const h=harness();h.ctx.expansionRunId=1;
  let done=false;const pending=h.ctx.requestExpansionModule('general',{text:'词'},1,0).then(r=>{done=true;return r;});
  h.emit('DELTA',{delta:'通用'});assert.equal(h.events.length,0);
  h.time(300);h.emit('DELTA',{delta:'定义：词的第一部分'});await Promise.resolve();
  assert.equal(done,false);assert.equal(h.shadow.querySelector("[data-field='general']").textContent,'词的第一部分');
  assert.match(h.shadow.querySelector("[data-state='general']").textContent,/预览尚未完成/);
  h.time(450);h.emit('DELTA',{delta:'和第二部分。'});
  assert.equal(h.shadow.querySelector("[data-field='general']").textContent,'词的第一部分和第二部分。');
  h.emit('DONE');const result=await pending;assert.equal(result.text,'词的第一部分和第二部分。');
  assert.match(h.shadow.querySelector("[data-state='general']").textContent,/正在检查/);
  assert.equal(h.events.filter(e=>e[0]==='first_text_displayed').length,1);
  assert.equal(h.events.find(e=>e[0]==='first_text_displayed')[1].firstVisibleMs,200);
});
test('流式错误不能当成功缓存；失败状态明确且可单独重试',async()=>{
  const h=harness();h.ctx.expansionRunId=1;
  const pending=h.ctx.requestExpansionModule('general',{text:'词'},1,0);
  h.emit('DELTA',{delta:'通用定义：未完成的草稿'});h.emit('ERROR',{message:'网络中断'});
  await assert.rejects(pending,/网络中断/);assert.equal(h.ctx.expandedAnswers.general,'');
  h.ctx.requestExpansionWithCheck=async()=>{throw Error('网络中断');};
  await h.ctx.startExpansion({text:'词'});
  assert.match(h.shadow.querySelector("[data-state='general']").textContent,/未完成/);
  assert.equal(h.shadow.querySelector("[data-retry='general']").hidden,false);
});
test('过期请求的增量不覆盖新卡片',()=>{
  const h=harness();h.ctx.expansionRunId=1;
  void h.ctx.requestExpansionModule('general',{text:'旧词'},1,0);
  h.ctx.expansionRunId=2;h.emit('DELTA',{delta:'通用定义：旧答案'});
  assert.equal(h.shadow.querySelector("[data-field='general']").textContent,'');
});
