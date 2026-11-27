const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../content.js'),'utf8'),Parser=require('../parser');
function fn(name){const start=source.indexOf('  function '+name+'(');return source.slice(start,source.indexOf('\n  function ',start+1));}
function card(){
  const nodes=new Map(),shadow={querySelector(s){if(!nodes.has(s))nodes.set(s,{classList:{remove(){}},removeAttribute(){},scrollIntoView(){},setAttribute(){},scrollTo(){}});return nodes.get(s);}};
  const env={parseInitial:Parser.parseInitial,activeDiagnosticItem:{},renderEvidencePanel(){},setStreamText:(el,text)=>el.textContent=text,
    document:{getElementById:()=>({shadowRoot:shadow})},HOST_ID:'card',normalAnswer:'',initialAnswer:'',simpleAnswer:'简明结果',
    setBusy(){},setAnswerMode(){},renderSimple(){},expandedAnswers:{general:'已有定义'},paintSelection(){},requestAnimationFrame:f=>f()};
  vm.createContext(env);vm.runInContext(['closedExpansionLabel','renderInitial','toggleExpanded','showSimpler'].map(fn).join('\n'),env);
  shadow.querySelector('.simple-answer').hidden=true;shadow.querySelector('.expanded').hidden=true;
  return {env,shadow,node:s=>shadow.querySelector(s)};
}
function reply(meaning,intent,person=false){return JSON.stringify({schema_version:'2.0',view_kind:'contextual',
  target_type:person?'person':'term',can_expand_general:!person,meaning_here:{text:meaning},author_intent:intent?{text:intent}:null});}
test('可选意图不显示空标题；等待、初步结果和最终结果独立保留首层关系',()=>{
  const {env,shadow,node}=card();env.activeDiagnosticItem.documentContext={conversation:true};
  const meaning='这里是说模块甲与模块乙可以分开接入。',intent='这句短答回应了前面关于能否换用其他模块的提问。';
  for(const done of [false,true]){
    for(const i of [null,intent,null]){
      env.renderInitial(shadow,reply(meaning,i),done);
      assert.equal(node("[data-field='meaning']").textContent,meaning);assert.equal(node("[data-section='intent']").hidden,!i);
      if(i)assert.equal(node("[data-field='intent']").textContent,intent);
      assert.equal(node('[data-label="intent"]').textContent,'这段话的作用');
    }
  }
});
test('普通概念展开和收起回到展开讲讲；人物切换简明版仍只查看依据',()=>{
  for(const person of [false,true]){
    const {env,shadow,node}=card();env.normalAnswer=reply(person?'发言者可能代表交付组。':'组件从业务主链路之外接入。',null,person);
    env.renderInitial(shadow,env.normalAnswer,true);const label=person?'查看依据':'展开讲讲';
    assert.equal(node('.expand').textContent,label);
    env.showSimpler({});assert.equal(node('.expand').textContent,label);
    env.showSimpler({});assert.equal(node('.expand').textContent,label);
    env.toggleExpanded({});
    if(!person){assert.equal(node('.expand').textContent,'收起');env.toggleExpanded({});}
    assert.equal(node('.expanded').hidden,true);assert.equal(node('.expand').textContent,label);
  }
});
