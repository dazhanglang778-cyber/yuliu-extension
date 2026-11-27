const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../document-retrieval.js');
function snapshot(items, anchor = 0) {
  return {selection:{normalized_text:'余温',anchor_block_id:'b'+anchor},blocks:items.map((text,i)=>({block_id:'b'+i,text,order:i,type:'paragraph',heading_path:[]}))};
}
test('generic labels lose priority while their explanatory body is recalled',()=>{
  const s=snapshot(['余温在此使用。','本段背景。','继续说明。',
    ...Array.from({length:12},(_,i)=>`${i+1}. 余温流程`), '关键指令被重新放入当前上下文。','它避免长对话遗漏先前约束。']);
  const before=R.retrieve(s,{headingAware:false}).candidates;
  const after=R.retrieve(s).candidates;
  assert.ok(!before.some(c=>c.text.includes('关键指令')));
  assert.ok(after.some(c=>c.text.includes('关键指令')));
  assert.ok(after.some(c=>c.block_id==='b0'));
  assert.ok(after.filter(c=>c.signals.structural_label).length < before.filter(c=>c.signals.structural_label).length);
});
test('selected heading stays and short factual definitions are not downgraded',()=>{
  for(const text of ['余温：有效期限','余温是有效期限','余温必须保留','余温表示剩余有效期']) {
    assert.equal(R.isStructuralLabel({type:'heading',text},'余温'),false,text);
  }
  const s=snapshot(['1. 余温策略','这里重新放入关键指令。','3. 无关主题','无关内容。']);
  assert.ok(R.retrieve(s).candidates.some(c=>c.block_id==='b0' && c.signals.anchor));
  assert.equal(R.retrieve(s).candidates.find(c=>c.block_id==='b3').signals.heading_body,false);
});
test('local antecedents survive distant title repetitions',()=>{
  const s=snapshot(['问：两个模块能分别部署吗？','余温','答：可以，但仍共用目录。',...Array.from({length:15},(_,i)=>`${i+1}. 余温流程`)],1);
  const ids=R.retrieve(s).candidates.map(c=>c.block_id);
  assert.ok(ids.includes('b0') && ids.includes('b1') && ids.includes('b2'));
});
