// Offline layout check: scripts removed, all network requests blocked.
// Usage: node ui-polish-check.mjs <absolute playwright module directory>
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || 'playwright');
const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
const css = ['styles.css', 'ui-polish.css', 'typography.css'].map(name => readFileSync(new URL(name, import.meta.url), 'utf8')).join('\n');
const output = new URL('../../artifacts/ui-polish-offline/', import.meta.url);
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const results = [];
try {
  const page = await browser.newPage();
  let requests = 0;
  await page.route('**/*', route => { requests++; return route.abort(); });
  await page.setContent(html);
  await page.addStyleTag({ content: css });
  const comparisonModule = 'data:text/javascript;base64,' + Buffer.from(readFileSync(new URL('./work-comparison.js', import.meta.url), 'utf8')).toString('base64');
  await page.evaluate(async url => {
    const { mountWorkComparison } = await import(url);
    window.comparisonStore = new Map();
    window.failComparisonSave = false;
    window.comparisonController = mountWorkComparison(document.querySelector('#work-comparison'), {
      storage: {getItem:key=>window.comparisonStore.get(key),setItem:(key,value)=>{if(window.failComparisonSave) throw Error('quota');window.comparisonStore.set(key,value);}},
      onExport:value=>{window.comparisonExport=value;},
    });
    window.comparisonController.setContext({direction:'离线测试 A',scope:'direction',purpose:'topic'});
    document.querySelector('#work-comparison').open = true;
  }, comparisonModule);
  // Exercise real input events; this is the isolated local controller, not the live app.
  await page.evaluate(() => {
    document.querySelectorAll('[data-view-panel]').forEach(el=>el.classList.toggle('active',el.dataset.viewPanel==='collection'));
  });
  for (const [name,value] of Object.entries({'current.title':'新作品','baseline.title':'基准','current.hours':'24','baseline.hours':'24','current.likes':'120','baseline.likes':'100','current.collects':'10','baseline.collects':'20','current.shares':'0','baseline.shares':'0'})) await page.locator(`[name="${name}"]`).fill(value);
  await page.locator('[name="comparable"]').check();
  assert.match(await page.locator('[data-comparison-output]').innerText(), /↑ \+20/);
  assert.match(await page.locator('[data-comparison-output]').innerText(), /↓ −10/);
  await page.evaluate(()=>window.comparisonController.setContext({direction:'离线测试 B',scope:'direction',purpose:'topic'}));
  assert.equal(await page.locator('[name="current.title"]').inputValue(),'');
  await page.evaluate(()=>window.comparisonController.setContext({direction:'离线测试 A',scope:'direction',purpose:'topic'}));
  assert.equal(await page.locator('[name="current.title"]').inputValue(),'新作品');
  await page.evaluate(()=>{window.failComparisonSave=true;});
  await page.locator('[name="current.title"]').fill('未落盘但仍保留的作品');
  assert.match(await page.locator('[data-comparison-status]').innerText(),/保存失败/);
  await page.locator('[data-comparison-export]').click();
  assert.equal(await page.evaluate(()=>window.comparisonExport.draft.current.title),'未落盘但仍保留的作品');
  assert.equal(await page.evaluate(()=>window.comparisonExport.source),'USER_ENTERED_NOT_PLATFORM_VERIFIED');
  await page.evaluate(() => {
    document.querySelector('#research-evidence-summary').textContent = '离线布局样本 · 2 条参考 · 三项齐全 1 条';
    document.querySelector('#research-question').textContent = '比较标题承诺与受众问题，选择一个你能用真实经验回答的问题。';
    document.querySelector('#research-experiment').textContent = '下一篇只验证一个问题，记录观察时长与真实互动。';
    document.querySelector('#research-examples').innerHTML = '<article class="research-example"><span class="rank-number">1</span><div><strong>离线布局测试：这是参考作品的长标题，不是真实推荐</strong><p>赞 1,234 · 藏 321 · 转 缺失</p><small>待补证：转发</small></div><button class="secondary" type="button">查看证据</button></article>';
    document.querySelector('#market-all-topics').innerHTML = `<div class="market-topic-header"><span>排名</span><span>选题方向</span><span>热度</span><span>变化</span><span>最近更新</span><span>查看</span></div><button class="market-topic-row top-three"><span class="market-rank top">1</span><span class="market-topic-main"><strong>离线排版测试：长标题与数据列对齐</strong><small>这是测试样本，不是真实榜单</small></span><span class="market-topic-score">12,345</span><span class="market-trend down">↓ −2</span><span class="market-topic-updated">9月26日 12:30</span><span class="market-chevron">→</span></button>`;
  });
  const appSource = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const referenceHandler = appSource.match(/el\("research-examples"\)\.addEventListener\("click", event => \{([\s\S]*?)\n\}\);/)[1];
  const referenceModule = 'data:text/javascript;base64,' + Buffer.from(readFileSync(new URL('./research-reference.js', import.meta.url), 'utf8')).toString('base64');
  await page.evaluate(async ({url,body}) => {
    const {referenceExcerpt} = await import(url);
    const article = document.querySelector('.research-example');
    const actions = document.createElement('div'); actions.className='research-example-actions';
    actions.append(article.querySelector('button'));
    const button=document.createElement('button');button.type='button';button.className='secondary';button.dataset.referenceIndex='0';button.textContent='记为参考';actions.append(button);article.append(actions);
    const handler=new Function('event','researchExamples','referenceExcerpt','el',body);
    document.querySelector('#research-examples').addEventListener('click',event=>handler(event,[{noteId:'offline-fixture',title:'离线参考，不是真实推荐',likes:1234,collects:321,shares:null}],referenceExcerpt,id=>document.getElementById(id)));
  }, {url:referenceModule,body:referenceHandler});
  await page.locator('#research-review').fill('原有离线测试想法');
  await page.locator('[data-reference-index]').click();
  const appendedReview = await page.locator('#research-review').inputValue();
  assert.ok(appendedReview.startsWith('原有离线测试想法\n\n参考作品：'));
  assert.match(appendedReview,/转发 未采到/);
  await page.locator('[data-reference-index]').click();
  assert.equal(await page.locator('#research-review').inputValue(),appendedReview);
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ['overview', 'collection', 'database', 'history', 'models']) {
      await page.evaluate(view => {
        document.querySelectorAll('[data-view-panel]').forEach(el => el.classList.toggle('active', el.dataset.viewPanel === view));
        const card = document.getElementById('collection-live-card');
        document.getElementById(view === 'collection' ? 'collection-control-host' : 'market-control-host').append(card);
        card.hidden = false;
      }, view);
      const layout = await page.evaluate(() => {
        const main = document.querySelector('main');
        const active = document.querySelector('.view.active');
        return { mainOverflow: main.scrollWidth - main.clientWidth, viewOverflow: active.scrollWidth - active.clientWidth };
      });
      assert.ok(layout.mainOverflow <= 1 && layout.viewOverflow <= 1, `${view} at ${width}: ${JSON.stringify(layout)}`);
      if (view === 'collection') {
        const checkboxWidth = await page.locator('[name="comparable"]').evaluate(node=>node.getBoundingClientRect().width);
        assert.ok(checkboxWidth <= 24, 'comparison checkbox must not inherit full input width');
      }
      if (view === 'overview' && width > 760) {
        const delta = await page.evaluate(() => [...document.querySelector('.market-topic-header').children].map((cell, i) => Math.abs(cell.getBoundingClientRect().x - document.querySelector('.market-topic-row').children[i].getBoundingClientRect().x)));
        assert.ok(delta.every(value => value <= 1), `column drift: ${delta}`);
      }
      results.push({ width, view, ...layout });
      if (view === 'collection' && width === 1440) await page.locator('.research-workspace').screenshot({path:fileURLToPath(new URL('research-reference-1440.png',output))});
      if (width === 1440 || (width === 390 && ['overview', 'collection'].includes(view))) await page.screenshot({ path: fileURLToPath(new URL(`${view}-${width}.png`, output)), fullPage: true });
    }
  }
  const typeAudit = await page.evaluate(() => {
    const signature = (node, nativeControl = false) => {
      const s = getComputedStyle(node);
      // Native select widgets report a platform-owned line-height of normal.
      return [s.fontFamily, s.fontSize, s.fontWeight, s.fontStyle, nativeControl ? 'native' : s.lineHeight, s.color].join('|');
    };
    return {
      sectionTitles: [...new Set([...document.querySelectorAll('main h2')].map(node => signature(node)))],
      descriptions: [...new Set([...document.querySelectorAll('.panel-heading p, .section-intro p')].map(node => signature(node)))],
      inputs: [...new Set([...document.querySelectorAll('main input:not([type="checkbox"]):not([type="file"]), main textarea, main select')].map(node => signature(node, true)))],
    };
  });
  for (const [role, signatures] of Object.entries(typeAudit)) assert.equal(signatures.length, 1, `${role} type inconsistency: ${signatures.join('\n')}`);
  assert.equal(requests, 0, 'offline fixture must not request remote or local APIs');
  writeFileSync(new URL('results.json', output), JSON.stringify({ scope: 'scriptless offline layout; not live functional acceptance', requests, typeAudit, results }, null, 2));
  console.log(`PASS: ${results.length} viewport/page combinations; aligned topic columns; 0 requests`);
} finally { await browser.close(); }
