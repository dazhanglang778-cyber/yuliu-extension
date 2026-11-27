// Headless UI smoke with fake extension storage and responses. Never calls a model.
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.YULIU_TEST_BROWSER ? {executablePath:process.env.YULIU_TEST_BROWSER} : {})});
  try {
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route(/^https?:/,()=>{throw Error('Offline smoke must not access network');});
    await page.addInitScript(()=>{
      const data={},listeners=[];window.testRequests=0;
      window.chrome={runtime:{id:'test',sendMessage:async m=>{
        window.testRequests++;
        const row={arm:'A',status:'returned',content:'通用定义：检测系统。\n\n机制：分析事件。',elapsedMs:1200,firstTextMs:100,actualModel:'fixed',usage:{input_tokens:10,output_tokens:20},search:{calls:[],citations:[]}};
        const b={...row,arm:'B',content:'定义[1]',searchEvidence:'calls_and_citations',search:{calls:[{status:'completed',sources:[{url:'https://example.org/',title:'测试来源'}]}],citations:[{start:2,end:5,url:'https://example.org/',title:'测试引用'}]}};
        const key='yuliuGeneralSearchComparisonV1';data[key]=[{id:'test-run',case:{term:'入侵检测系统',context:'公开语境',check:'检测与阻断的区别'},model:'fixed',startedAt:Date.now(),status:'completed',order:m.order,rows:[row,b]}];
        listeners.forEach(f=>f({[key]:{newValue:data[key]}},'local'));return {ok:true};
      }},storage:{local:{get:async k=>Object.fromEntries((Array.isArray(k)?k:[k]).map(x=>[x,x==='openaiModel'?'fixed':data[x]])),set:async x=>Object.assign(data,x)},onChanged:{addListener:f=>listeners.push(f)}}};
    });
    await page.goto(pathToFileURL(path.join(__dirname,'..','general-definition-comparison.html')).href);
    await page.waitForFunction(()=>!document.getElementById('run').disabled);
    assert.equal(await page.evaluate(()=>window.testRequests),0);
    await page.locator('#run').click();await page.waitForFunction(()=>document.getElementById('status').textContent.startsWith('本例结束'));
    assert.equal(await page.evaluate(()=>window.testRequests),1);
    assert.equal(await page.locator('.arm').count(),2);
    assert.equal(await page.locator('.answer a').getAttribute('href'),'https://example.org/');
    assert.ok((await page.locator('.answer').first().textContent()).includes('\n\n'));
    await page.locator('textarea').fill('B 增加了正确知识，但还要核查来源。');
    await page.getByRole('button',{name:'保存人工评价'}).click();await page.getByRole('button',{name:'已保存'}).waitFor();
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#export').click()]);
    const stream=await download.createReadStream();let raw='';for await(const chunk of stream)raw+=chunk;
    const exported=JSON.parse(raw);assert.equal(exported.reports.length,1);assert.match(exported.reviews['test-run'],/正确知识/);
    assert.doesNotMatch(raw,/apiKey|Authorization/);assert.deepEqual(errors,[]);
    console.log('UI smoke passed: no automatic request, click, both answers, inline citations, paragraphs, review save, JSON export; fake responses only.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
