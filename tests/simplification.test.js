const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Parser=require('../parser');
const source=fs.readFileSync(require.resolve('../content.js'),'utf8');
function fn(name){const start=source.indexOf('  function '+name+'(');const end=source.indexOf('\n  function ',start+1);return source.slice(start,end);}
function harness(){
  const nodes=new Map();const node=()=>({hidden:true,textContent:'',classList:{add(){},remove(){},toggle(){}},scrollTo(){}});
  const shadow={querySelector:s=>{if(!nodes.has(s))nodes.set(s,node());return nodes.get(s);}};
  const calls=[],renders=[],events=[];
  const ctx={Parser,document:{getElementById:()=>({shadowRoot:shadow})},HOST_ID:'test',
    normalAnswer:'原解释保持不变',initialAnswer:'',simpleAnswer:'',activeRequestId:'r',
    parseInitial:Parser.parseInitial,setAnswerMode(){},setBusy(){},hideLoading(){},showLoading(){},noteVisibleStream(){},
    requestExplanation:(...x)=>calls.push(x),renderSimple:(_s,text,done)=>renders.push({text,done}),
    renderInitial(){},sendDiagnosticEvent:(...x)=>events.push(x),showError:(_s,text)=>events.push(['error',text]),
    answerNamesSelection:()=>true};
  vm.createContext(ctx);vm.runInContext(fn('closedExpansionLabel')+'\n'+fn('showSimpler')+'\n'+fn('receiveStream'),ctx);
  return {ctx,calls,renders,events,nodes};
}

test('简化输入保留完整含义、条件和不确定性，不发送证据全文或随意抽取单条主张',()=>{
  const original=JSON.stringify({schema_version:'2.0',view_kind:'contextual',selected_text:'部署',
    meaning_here:{text:'这两个服务可以分别部署，但仍须共用同一权限目录。'},
    author_intent:{text:'说明分开部署有边界。'},resolution:{status:'inferred'},notice_code:'limited_context',
    claims:[{text:'不要只取这一条'}],page_evidence:[{quote:'不应发送的整段原文'}]});
  const compact=JSON.parse(Parser.simplificationSource(original));
  assert.match(compact.meaning,/但仍须共用/);assert.equal(compact.certainty,'inferred');
  assert.equal(compact.notice,'limited_context');assert.doesNotMatch(JSON.stringify(compact),/不要只取|不应发送/);
  assert.equal(compact.intent,undefined);
  assert.doesNotMatch(JSON.stringify(compact),/说明分开部署有边界/);
});
test('结构化答案第一次点击发起改写，不再复用 contextual_mapping 原文',()=>{
  const h=harness();h.ctx.normalAnswer=JSON.stringify({schema_version:'2.0',view_kind:'contextual',
    meaning_here:{text:'原来的长解释'},claims:[{claim_type:'contextual_mapping',text:'长段原文'}]});
  h.ctx.showSimpler({text:'JSON'});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0][0],'simplify');assert.equal(h.ctx.simpleAnswer,'');
});
test('自然短句不误拦；不合一句话目标的输出也不机械截断、丢条件或自动追加调用',()=>{
  for(const output of ['只能推测。','这里的 JSON 告诉前端用哪些现成组件、填什么内容。',
    '两项服务可以分别部署。仍须共用权限目录。', '这'.repeat(85)+'仍须保留权限限制。']){
    const h=harness();h.ctx.initialAnswer=output;
    h.ctx.receiveStream({type:'DONE',requestId:'r'},'simplify',{text:'JSON'},0);
    assert.equal(h.calls.length,0);assert.equal(h.ctx.simpleAnswer,output);
    assert.equal(h.ctx.normalAnswer,'原解释保持不变');assert.ok(h.events.some(e=>e[0]==='answer_displayed'));
  }
});

test('概念词义提示和文内实体身份分开传递，但不发送作者意图',()=>{
  for(const [term,type,meaning] of [
    ['Memory','concept','这里指Agent保存任务信息的记忆，不是计算机物理内存。'],
    ['说话人5','person','从发言看，可能代表研究院一方，姓名未知。'],
    ['晨星','project','这是文内的升级项目代号，而非天体。']]){
    const raw=JSON.stringify({schema_version:'2.0',target_type:type,selected_text:term,
      meaning_here:{text:meaning},author_intent:{text:'作者意图不应进入简短定义'},resolution:{status:'inferred',selected_sense_id:'s'},
      candidate_senses:[{sense_id:'s',label:meaning,referent_type:type}]});
    const result=JSON.parse(Parser.simplificationSource(raw));
    assert.equal(result.target_type,type);assert.equal(result.meaning,meaning);
    assert.equal(result.resolved_sense.label,meaning);assert.equal(result.certainty,'inferred');
    assert.doesNotMatch(JSON.stringify(result),/作者意图/);
  }
});

test('一句话任务不再要求压缩整段、绑定当前用途、允许两句或展开故事',()=>{
  const code=fs.readFileSync(require.resolve('../background.js'),'utf8');
  const start=code.indexOf('function buildMessages('),end=code.indexOf('\nfunction ',start+1);
  const ctx={englishOpeningRule:()=>'',sanitizeEvidenceTitle:x=>x,sanitizeEvidenceText:x=>x};
  vm.createContext(ctx);vm.runInContext(code.slice(start,end),ctx);
  const messages=ctx.buildMessages({mode:'simplify',selection:'概念',existing:'词义线索'},[]);
  const rules=messages[0].content;
  assert.match(rules,/只输出一个完整句子/);assert.match(rules,/必要时用一个准确、熟悉的类比/);
  assert.match(rules,/不要另外举例/);assert.match(rules,/不强行给出通用定义/);
  assert.doesNotMatch(rules,/可以写两句|应把核心意义与当前用途连起来|优先改写 meaning/);
  assert.match(messages[1].content,/不是待压缩的文章摘要/);
});
test('流式增量显示，完成后再次切换复用缓存不新增调用',()=>{
  const h=harness();h.ctx.receiveStream({type:'DELTA',requestId:'r',delta:'一句话解释：这里的 JSON 是界面说明单。'},'simplify',{text:'JSON'},0);
  assert.equal(h.renders[0].done,false);
  h.ctx.receiveStream({type:'DONE',requestId:'r'},'simplify',{text:'JSON'},0);
  h.ctx.showSimpler({text:'JSON'});
  h.ctx.showSimpler({text:'JSON'});
  h.ctx.showSimpler({text:'JSON'});
  assert.equal(h.calls.length,0);assert.equal(h.ctx.normalAnswer,'原解释保持不变');
});
test('空结果不伪装简明版，不触发第二次模型调用',()=>{
  const h=harness();h.ctx.initialAnswer='一句话解释：';
  h.ctx.receiveStream({type:'DONE',requestId:'r'},'simplify',{text:'词'},0);
  assert.equal(h.calls.length,0);assert.equal(h.ctx.simpleAnswer,'');assert.ok(h.events.some(e=>e[0]==='error'));
});
test('首屏预览不写入定稿，忽略旧请求，断线时撤掉未核验草稿',()=>{
  const h=harness(), field=h.ctx.document.getElementById().shadowRoot.querySelector("[data-field='meaning']");
  field.dataset={};field.classList.remove=()=>{};
  h.ctx.setStreamText=(el,text)=>el.textContent=text;
  let badge='';
  h.ctx.setAnswerMode=(_s,text)=>badge=text;
  vm.runInContext(fn('showError'),h.ctx);
  const send=(id,text)=>h.ctx.receiveStream({type:'MEANING_PREVIEW',requestId:id,text},'initial',{});
  send('old','旧文');assert.equal(field.textContent,'');
  send('r','部分正文');assert.equal(field.textContent,'部分正文');assert.match(badge,/未核验/);
  assert.equal(h.ctx.initialAnswer,'');
  h.ctx.showError(h.ctx.document.getElementById().shadowRoot,'连接中断',false);
  assert.equal(field.textContent,'');assert.equal(badge,'');
  send('r','草稿');h.ctx.renderInitial=(_s,raw)=>field.textContent=JSON.parse(raw).meaning_here.text;
  h.ctx.receiveStream({type:'GROUNDED_RESULT',requestId:'r',result:{meaning_here:{text:'最终正文'}}},'initial',{});
  assert.equal(field.textContent,'最终正文');assert.equal(field.dataset.preview,undefined);assert.equal(badge,'');
});
test('简明流式标签不泄露，短的有效答案不再按8字门槛清空',()=>{
  assert.equal(Parser.parseSimple('一句话解'),'');
  assert.equal(Parser.parseSimple('不能确定。'),'不能确定。');
});

test('简化提示保留限制与推测，不要求口头禅和词典翻译模板',()=>{
  const background=fs.readFileSync(require.resolve('../background.js'),'utf8');
  assert.ok(background.includes('request.mode === "simplify" || !isTemporary(error)'), '简化失败不切换模型或自动追加请求');
  const start=background.indexOf('function buildMessages('),end=background.indexOf('\nfunction ',start+1);
  const ctx={englishOpeningRule:()=>'',sanitizeEvidenceTitle:x=>x,sanitizeEvidenceText:x=>x};
  vm.createContext(ctx);vm.runInContext(background.slice(start,end),ctx);
  for(const existing of ['只能推测此人属于研究院一方，姓名未知。','只限非跨部门事件。','两项服务分开部署，但仍须共用目录。']){
    const messages=ctx.buildMessages({mode:'simplify',selection:'对象',existing,context:'全文不发送'},[]);
    const serialized=JSON.stringify(messages);
    assert.ok(serialized.includes(existing));assert.doesNotMatch(serialized,/全文不发送/);
    assert.match(serialized,/保留否定、适用范围、必须条件和推测语气/);
    assert.doesNotMatch(serialized,/成品必须出现|统一使用中文双引号/);
  }
});
