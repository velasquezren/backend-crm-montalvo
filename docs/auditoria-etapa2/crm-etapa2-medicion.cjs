const {chromium}=require('/Users/macmini2024/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('fs');
const OUT='/Users/macmini2024/Documents/CARPETA RENE/CRM/auditoria-etapa2/evidencia';
const pw='/Users/macmini2024/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
exports.main=async()=>{
 const browser=await chromium.launch({executablePath:pw,headless:true});
 const context=await browser.newContext({storageState:'/tmp/crm-etapa2-storage.json',viewport:{width:1440,height:900},serviceWorkers:'block'});
 await context.route('**/*',r=>['localhost','127.0.0.1','fonts.gstatic.com','fonts.googleapis.com'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 await context.addInitScript(()=>{
  window.audit={longtasks:[],shifts:[],lcp:[],mutations:0};
  for(const [type,key] of [['longtask','longtasks'],['layout-shift','shifts'],['largest-contentful-paint','lcp']])try{new PerformanceObserver(l=>window.audit[key].push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration,value:e.value,size:e.size,hadRecentInput:e.hadRecentInput})))).observe({type,buffered:true});}catch{}
  document.addEventListener('DOMContentLoaded',()=>new MutationObserver(m=>window.audit.mutations+=m.length).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true}));
 });
 const page=await context.newPage();const cdp=await context.newCDPSession(page);
 await cdp.send('Performance.enable'); await cdp.send('Network.enable');
 let records=[],errors=[]; const net=new Map();let frames=[];
 cdp.on('Network.requestWillBeSent',e=>net.set(e.requestId,{url:e.request.url,method:e.request.method,start:e.timestamp,type:e.type}));
 cdp.on('Network.responseReceived',e=>{const n=net.get(e.requestId);if(n)Object.assign(n,{status:e.response.status,ttfbMs:(e.timestamp-n.start)*1000,cache:e.response.fromDiskCache||e.response.fromServiceWorker});});
 cdp.on('Network.loadingFinished',e=>{const n=net.get(e.requestId);if(n){Object.assign(n,{durationMs:(e.timestamp-n.start)*1000,wireBytes:e.encodedDataLength});records.push(n);}});
 page.on('pageerror',e=>errors.push(e.message));
 page.on('websocket',ws=>ws.on('framereceived',e=>{if(String(e.payload).includes('conversacion:actividad'))frames.push({time:Date.now(),data:String(e.payload)});}));
 const results=[];
 const specs=[['conversaciones','.chat-item'],['dashboard','.kpi-card'],['clientes','tbody tr'],['leads','app-lead-card,tbody tr'],['ventas','tbody tr'],['actividades','tbody tr'],['finanzas','app-planilla-comisiones,app-selector-periodo-empty'],['usuarios','tbody tr'],['perfil','app-perfil'],['servicios','app-servicios']];
 for(const [route,selector] of specs){
  const start=performance.now();records=[];errors=[];frames=[];
  await page.goto('http://localhost:4200/'+route,{waitUntil:'domcontentloaded'});
  let useful;
  try{await page.locator(selector).first().waitFor({state:'visible',timeout:8000});useful=performance.now()-start;}catch{useful=null;}
  await page.waitForTimeout(900);
  const body=(await page.locator('body').innerText());
  const metrics=await cdp.send('Performance.getMetrics');
  const dom=await page.evaluate(()=>({nodes:document.querySelectorAll('*').length,rows:document.querySelectorAll('tbody tr').length,inputs:[...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,type:e.type,placeholder:e.getAttribute('placeholder'),label:e.labels?.[0]?.textContent?.trim(),ariaLabel:e.getAttribute('aria-label'),invalid:e.getAttribute('aria-invalid'),describedby:e.getAttribute('aria-describedby')})),audit:window.audit,resources:performance.getEntriesByType('resource').map(e=>({name:e.name,encoded:e.encodedBodySize,decoded:e.decodedBodySize,duration:e.duration}))}));
  const shots=[];
  for(const width of [1440,1024,390]){
   await page.setViewportSize({width,height:width===390?844:900});await page.waitForTimeout(180);
   await page.screenshot({path:OUT+'/'+route+'-'+width+'.png',fullPage:false});
   shots.push(await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflowElements:[...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+2||r.left< -2)&&getComputedStyle(e).position!=='fixed'}).slice(0,12).map(e=>({tag:e.tagName,class:e.className,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right}))})));
  }
  await page.setViewportSize({width:1440,height:900});
  const result={route,usefulMs:useful,requests:records.filter(r=>r.url.includes(':3001/')),assets:records.filter(r=>r.type==='Script'||r.type==='Stylesheet'),errors,frames,metrics:metrics.metrics,dom,shots,text:body};
  results.push(result);fs.writeFileSync(OUT+'/pantallas.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify({route,usefulMs:useful,requests:result.requests.map(r=>({method:r.method,path:new URL(r.url).pathname+new URL(r.url).search,status:r.status,durationMs:r.durationMs,wireBytes:r.wireBytes})),nodes:dom.nodes,rows:dom.rows,errors,js:result.assets.length}));
 }
 await browser.close();
};
