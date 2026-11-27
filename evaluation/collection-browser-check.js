// Real Chromium DOM checks, isolated from the installed extension and model API.
// NODE_PATH may point to the bundled Playwright installation. No user profile is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '..', 'document-context.js'), 'utf8');
const retrieval = fs.readFileSync(path.join(__dirname, '..', 'document-retrieval.js'), 'utf8');
const discourse = fs.readFileSync(path.join(__dirname, '..', 'discourse-context.js'), 'utf8');

async function collect(page, html, term, occurrence = 0, legacy = false) {
  await page.setContent(html);
  // Reproduce only the old root-selection behavior on the identical DOM.
  const code = legacy ? source.replace('if (content && content.querySelector?.(BLOCK_SELECTOR)) return content;', '') : source;
  await page.addScriptTag({content:code});
  await page.addScriptTag({content:discourse});
  await page.addScriptTag({content:retrieval});
  return page.evaluate(({term, occurrence}) => {
    // Select in the article, not a navigation/breadcrumb occurrence of the word.
    const selectionScope = document.querySelector('.article-content, article, main, [role="main"]') || document.body;
    const walker = document.createTreeWalker(selectionScope, NodeFilter.SHOW_TEXT);
    const matches = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.parentElement.closest('script,style,nav')) continue;
      let from = 0, at;
      while ((at = n.textContent.indexOf(term, from)) >= 0) {
        matches.push({n, at}); from = at + term.length;
      }
    }
    const hit = matches[occurrence];
    if (!hit) throw Error('Missing selected occurrence: ' + term);
    const range = document.createRange();
    range.setStart(hit.n, hit.at); range.setEnd(hit.n, hit.at + term.length);
    const result = YuliuDocumentContext.collect(range, term);
    const retrieved = YuliuDocumentRetrieval.retrieve(result.snapshot);
    const baseline = YuliuDocumentRetrieval.retrieve(result.snapshot,{headingAware:false});
    return {extraction:result.snapshot.extraction, selection:result.snapshot.selection,
      blocks:result.snapshot.blocks, candidates:retrieved.candidates, baseline:baseline.candidates};
  }, {term, occurrence});
}

(async () => {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  try {
    const page = await browser.newPage();
    // Static DOM only: never execute downloaded page scripts or load remote assets.
    await page.route('**/*', route => route.abort());
    const fixtures = [
      {name:'article metadata excluded without dropping prose',html:'<main><p>API连接软件。</p><div class="translation-banner"><p>此页翻译提示</p></div><section class="article-footer"><p>更新时间</p></section><p>正文讨论翻译和更新时间。</p></main>',term:'API',keep:['正文讨论翻译'],drop:['此页翻译提示'],scope:'semantic_root'},
      {name:'div article body, cross-section retention', html:'<nav><p>导航</p></nav><div class="article-content"><h2>概念</h2><p>Memory 用于管理上下文。</p><h2>方法</h2><p>保鲜会重新放入关键指令。</p><p>讨论广告、评论与推荐算法是正文。</p></div><div><p>RAG新客享30天免费额度</p></div>', term:'Memory', keep:['保鲜会重新','讨论广告'], drop:['新客享','导航'], scope:'article_content'},
      {name:'semantic article and named noise ancestors', html:'<article><h1>标题</h1><p>RAG先检索再生成。</p><div class="promo-panel"><div><p>广告优惠</p></div></div><div class="related-items"><p>推荐阅读</p></div><p>跨段定义保留。</p></article>', term:'RAG', keep:['跨段定义'], drop:['广告优惠','推荐阅读'], scope:'semantic_root'},
      {name:'unknown layout conservative fallback', html:'<div><p>开头定义Memory。</p></div><div><p>结尾解释保鲜。</p></div><div class="sidebar"><p>促销</p></div>', term:'保鲜', keep:['开头定义Memory'], drop:['促销'], scope:'body_fallback'},
      {name:'selected content inside noise remains usable', html:'<article><p>正文</p><div class="comments"><p>评论里的代号甲</p><p>其他评论</p></div></article>', term:'代号甲', keep:['评论里的代号甲'], drop:['其他评论'], scope:'semantic_root'},
      {name:'table and code stay in article', html:'<main><div class="entry-content"><p>上下文里的Memory。</p><table><tr><td>历史判断须长期保鲜</td></tr></table><pre>preserve critical instructions</pre></div><aside><p>外部推荐</p></aside></main>', term:'Memory', keep:['历史判断','preserve critical'], drop:['外部推荐'], scope:'article_content'},
      {name:'long article retains distant definition', html:'<div class="post-body"><p>代号甲的定义在开头。</p>'+Array.from({length:1000},(_,i)=>`<p>第${i}段普通内容。</p>`).join('')+'<p>结尾使用代号甲。</p></div>', term:'代号甲', occurrence:1, keep:['定义在开头','结尾使用'], drop:[], scope:'article_content'},
    ];
    for (const f of fixtures) {
      const r = await collect(page, f.html, f.term, f.occurrence || 0);
      const joined = r.blocks.map(b=>b.text).join('\n');
      for (const s of f.keep) assert.ok(joined.includes(s), `${f.name}: lost ${s}`);
      for (const s of f.drop) assert.ok(!joined.includes(s), `${f.name}: kept ${s}`);
      assert.equal(r.extraction.scope_strategy, f.scope);
      assert.ok(r.selection.start_offset >= 0);
      console.log('PASS ' + f.name);
    }
    // Recollect after DOM mutation (no cached snapshot).
    let r = await collect(page, '<main><p>Memory的定义。</p></main>', 'Memory');
    await page.evaluate(()=>document.querySelector('main').insertAdjacentHTML('beforeend','<p>后来加载的保鲜解释。</p>'));
    r = await page.evaluate(()=>{
      const n=document.querySelector('p').firstChild, range=document.createRange();
      range.setStart(n,0);range.setEnd(n,6);
      return YuliuDocumentContext.collect(range,'Memory').snapshot;
    });
    assert.ok(r.blocks.some(b=>b.text.includes('后来加载')));
    console.log('PASS dynamic recollection (not virtual-scroll completeness)');
    if (process.argv.includes('--cross-site')) {
      const checks = [];
      for (const target of [
        {url:'https://developer.mozilla.org/zh-CN/docs/Glossary/API',term:'API'},
        {url:'https://zh.javascript.info/closure',term:'词法环境'},
      ]) {
        const live = await browser.newPage();
        try {
          await live.goto(target.url,{waitUntil:'domcontentloaded',timeout:30000});
          const html=(await live.content()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
          const r=await collect(page,html,target.term);
          assert.ok(r.selection.start_offset>=0);
          assert.ok(r.blocks.length>2);
          const check={...target,extraction:r.extraction,selected:r.selection,
            candidates:r.candidates.map(c=>({quote:c.quote,headings:c.heading_path})),
            scope_review_required:r.extraction.scope_uncertain};
          checks.push(check);
          console.log(JSON.stringify({url:target.url,extraction:r.extraction,selected:r.selection}));
        } catch(e) {checks.push({...target,error:String(e)});console.error(target.url,String(e));}
        finally {await live.close();}
      }
      fs.writeFileSync(path.join(__dirname,'..','diagnostic-data','cross-site-scope-2026-10-30.json'),JSON.stringify(checks,null,2));
    }
    if (process.argv.includes('--stdin') || process.argv.includes('--live')) {
      let downloaded;
      if (process.argv.includes('--live')) {
        const live = await browser.newPage();
        await live.goto('https://developer.aliyun.com/article/1684800',{waitUntil:'domcontentloaded',timeout:30000});
        await live.waitForFunction(()=>document.querySelector('.article-content')?.innerText.includes('Memory'),{},{timeout:30000});
        downloaded = await live.content();
        await live.close();
      } else downloaded = fs.readFileSync(0,'utf8');
      const html = downloaded.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
      const report = {date:'2026-10-30', method:'isolated Chromium rendered public page DOM; no model or installed extension calls', cases:[]};
      for (const term of ['RAG', 'Memory', '保鲜', 'API']) {
        const before = await collect(page, html, term, 0, true);
        const r = await collect(page, html, term);
        assert.equal(r.extraction.scope_strategy,'article_content');
        assert.ok(!r.blocks.some(b=>b.text.includes('RAG新客享30天免费额度')));
        assert.ok(r.blocks.some(b=>b.text.includes('先从知识库检索')));
        assert.ok(r.blocks.some(b=>b.text.includes('保鲜')));
        const result = {live_html_check:term, before_scope:before.extraction.scope_strategy,
          before_blocks:before.blocks.length, after_blocks:r.blocks.length,
          before_promo:before.blocks.filter(b=>b.text.includes('RAG新客享30天免费额度')).length,
          after_promo:r.blocks.filter(b=>b.text.includes('RAG新客享30天免费额度')).length,
          extraction:r.extraction,selected:r.selection,
          ranking_before:r.baseline.map(c=>({quote:c.quote,label:c.signals.structural_label})),
          heading_count_before:r.baseline.filter(c=>c.signals.structural_label).length,
          heading_count_after:r.candidates.filter(c=>c.signals.structural_label).length,
          candidates:r.candidates.map(c=>({id:c.evidence_id,quote:c.quote,reasons:c.reasons}))};
        report.cases.push(result);
        console.log(JSON.stringify({...result,ranking_before:undefined,candidates:result.candidates.map(c=>c.quote)}));
      }
      fs.writeFileSync(path.join(__dirname,'..','diagnostic-data','heading-ranking-2026-10-30.json'),JSON.stringify(report,null,2));
    }
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
