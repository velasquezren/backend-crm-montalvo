const {chromium}=require('/Users/macmini2024/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('fs');
const OUT='/Users/macmini2024/Documents/CARPETA RENE/CRM/auditoria-etapa2/evidencia';
const pw='/Users/macmini2024/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
exports.main=async()=>{
 const browser=await chromium.launch({executablePath:pw,headless:true});const all=[];
 const context=await browser.newContext({storageState:'/tmp/crm-etapa2-storage.json',viewport:{width:1440,height:900},serviceWorkers:'block'});
 await context.route('**/*',r=>['localhost','127.0.0.1','fonts.gstatic.com'].includes(new URL(r.request().url()).hostname)?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(6000);const cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');
 let records=[];const errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',e=>{if(e.type()==='error')errors.push(e.text())});page.on('framenavigated',f=>{if(f===page.mainFrame())console.log('NAV',f.url())});page.on('response',async r=>{if(r.url().includes(':3001/'))records.push({method:r.request().method(),path:new URL(r.url()).pathname+new URL(r.url()).search,status:r.status(),bytes:(await r.body().catch(()=>Buffer.alloc(0))).length});});
 const metric=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x=>[x.name,x.value]));
 const settle=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
 const measure=async(name,action,ready)=>{await page.waitForTimeout(220);records=[];const before=await metric();const t=performance.now();await action();await ready();await settle();const usefulMs=performance.now()-t;await page.waitForTimeout(180);const after=await metric();const result={name,usefulMs,requests:records,dom:await page.evaluate(()=>document.querySelectorAll('*').length),layoutCount:after.LayoutCount-before.LayoutCount,recalcStyleCount:after.RecalcStyleCount-before.RecalcStyleCount,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,taskMs:(after.TaskDuration-before.TaskDuration)*1000};all.push(result);fs.writeFileSync(OUT+'/benchmarks.json',JSON.stringify(all,null,2));console.log(JSON.stringify(result));};
 try{
 for(const [route,label] of [['conversaciones','A-inbox-frio'],['dashboard','F-dashboard-frio'],['finanzas','G-selector-comisiones-frio']])for(let i=0;i<3;i++)await measure(label,()=>page.goto('http://localhost:4200/'+route,{waitUntil:'domcontentloaded'}),()=>route==='conversaciones'?page.locator('.chat-item').first().waitFor():route==='dashboard'?page.getByText('Ventas Cerradas (Periodo)',{exact:true}).waitFor():page.locator('app-planilla-comisiones tbody tr').first().waitFor());
 for(let i=0;i<3;i++){
  await page.goto('http://localhost:4200/finanzas');await page.locator('app-planilla-comisiones tbody tr').first().waitFor();
  await measure('G-abrir-periodo',()=>page.locator('app-planilla-comisiones tbody tr').first().click(),()=>page.locator('app-planilla-comisiones tbody tr').filter({hasText:'Consulta ficticia'}).first().waitFor());
 }
 await page.goto('http://localhost:4200/clientes');await page.locator('tbody tr').first().waitFor();
 for(const n of [15991,15992,15993]){
  await measure('C-buscar-paciente',()=>page.locator('input[placeholder^="Buscar por nombre"]').fill('AUD'+n),()=>page.locator('tbody tr').filter({hasText:'Paciente Ficticio '+n}).waitFor());
  await measure('D-abrir-ficha',()=>page.locator('tbody tr').first().click(),()=>page.locator('[role=dialog]').waitFor());await page.keyboard.press('Escape');
 }
 await page.goto('http://localhost:4200/conversaciones');await page.locator('.chat-item').first().waitFor();
 for(const [tab,text] of [['SIN_RESPONDER','Sin responder'],['MIS_CHATS','Mis chats'],['','Todas']]){
  let response;
  await measure('E-filtro-inbox',async()=>{response=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/conversaciones'&&(u.searchParams.get('tab')||'')===tab;});await page.locator('.tabs-inbox button').filter({hasText:text}).click();},async()=>{await response;await page.locator('.chat-item').first().waitFor();});
 }
 await measure('ruta-inbox-dashboard',()=>page.locator('a[href="/dashboard"]').first().click(),()=>page.getByText('Ventas Cerradas (Periodo)',{exact:true}).waitFor());
 await cdp.send('HeapProfiler.collectGarbage');all.push({name:'heap-post-GC',metrics:await metric()});fs.writeFileSync(OUT+'/benchmarks.json',JSON.stringify(all,null,2));
 }catch(e){fs.writeFileSync(OUT+"/benchmark-fallo.json",JSON.stringify({error:String(e),errors,url:page.url(),body:await page.locator("body").innerText(),requests:records},null,2));throw e;}finally{await browser.close();}
};
