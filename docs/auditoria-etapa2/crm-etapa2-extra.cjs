const {chromium}=require('/Users/macmini2024/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('fs');
const OUT='/Users/macmini2024/Documents/CARPETA RENE/CRM/auditoria-etapa2/evidencia';
const pw='/Users/macmini2024/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
exports.main=async()=>{
 const browser=await chromium.launch({executablePath:pw,headless:true});const results=process.argv[3]==='rest'?JSON.parse(fs.readFileSync(OUT+'/extras.json')):[];
 const context=await browser.newContext({storageState:'/tmp/crm-etapa2-storage.json',viewport:{width:1440,height:900},serviceWorkers:'block'});
 let failSend=false,records=[],errors=[];
 await context.route('**/*',async r=>{const u=new URL(r.request().url());if(!['localhost','127.0.0.1','fonts.gstatic.com'].includes(u.hostname))return r.abort();if(failSend&&u.pathname.endsWith('/mensajes')&&r.request().method()==='POST'){await new Promise(a=>setTimeout(a,1000));return r.fulfill({status:503,contentType:'application/json',body:'{"message":"Envío rechazado en auditoría"}'});}return r.continue();});
 const page=await context.newPage();page.setDefaultTimeout(6000);
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().includes(':3001/'))records.push({method:r.request().method(),path:new URL(r.url()).pathname+new URL(r.url()).search,status:r.status(),bytes:(await r.body().catch(()=>Buffer.alloc(0))).length});});
 const save=(name,data)=>{const x={name,...data,requests:records,errors};results.push(x);fs.writeFileSync(OUT+'/extras.json',JSON.stringify(results,null,2));console.log(JSON.stringify(x));records=[];errors=[];};
 try{
 let t;
 if(process.argv[3]!=='rest'){
 await page.goto('http://localhost:4200/clientes');await page.locator('tbody tr').first().waitFor();await page.waitForTimeout(350);records=[];
 t=performance.now();await page.locator('input[placeholder^="Buscar por nombre"]').fill('AUD15999');await page.locator('tbody tr').filter({hasText:'Paciente Ficticio 15999'}).waitFor();save('buscar-paciente',{usefulMs:performance.now()-t});
 t=performance.now();await page.locator('tbody tr').first().click();await page.locator('[role=dialog]').waitFor();save('abrir-ficha-cliente',{usefulMs:performance.now()-t,dialogText:(await page.locator('[role=dialog]').innerText()).slice(0,500)});
 let focusOutside=0;for(let i=0;i<24;i++){await page.keyboard.press('Tab');if(!await page.evaluate(()=>!!document.activeElement.closest('[role=dialog]')))focusOutside++;}
 await page.screenshot({path:OUT+'/ficha-cliente-1440.png'});await page.keyboard.press('Escape');save('focus-drawer',{focusOutside,closed:await page.locator('[role=dialog]').count()===0});
 await page.locator('input[placeholder^="Buscar por nombre"]').fill('AUD1');await page.waitForTimeout(500);await page.locator('tbody tr').first().click();await page.locator('[role=dialog]').waitFor();
 const buttons=await page.locator('[role=dialog] button').evaluateAll(es=>es.map(e=>({label:e.getAttribute('aria-label'),title:e.title,text:e.textContent.trim()})));
 save('ficha-acciones',{buttons});
 const wa=page.locator('[role=dialog] button').filter({has:page.locator('app-icon[name="message-circle"]')});
 if(await wa.count()){await wa.click();await page.waitForTimeout(450);save('cliente-a-inbox',{url:page.url(),thread:(await page.locator('app-conversacion-thread').innerText()).slice(0,400)});}else await page.keyboard.press('Escape');
 await page.goto('http://localhost:4200/conversaciones?id=audit-chat-1');await page.locator('[data-mensaje-id="audit-msg-1-180"]').waitFor();await page.waitForTimeout(300);records=[];
 await page.getByTitle('Personalizar mis respuestas rápidas').click();await page.locator('.cdk-overlay-pane').waitFor();
 const modalRoles=await page.locator('.cdk-overlay-pane').evaluate(e=>({dialogs:e.querySelectorAll('[role=dialog]').length,traps:e.querySelectorAll('.cdk-focus-trap-anchor').length,headings:[...e.querySelectorAll('h1,h2,h3')].map(e=>e.textContent)}));
 let escaped=0;for(let i=0;i<18;i++){await page.keyboard.press('Tab');if(!await page.evaluate(()=>!!document.activeElement.closest('.cdk-overlay-pane')))escaped++;}
 await page.screenshot({path:OUT+'/plantillas-1440.png'});save('focus-modal-plantillas',{...modalRoles,focusOutside:escaped});await page.keyboard.press('Escape');
 failSend=true;await page.locator('app-conversacion-composer textarea').fill('BORRADOR EXCLUSIVAMENTE FICTICIO');
 await page.locator('app-conversacion-composer textarea').press('Enter');await page.waitForTimeout(80);
 const optimistic=await page.locator('[data-mensaje-id^="temp-"]').innerHTML();
 await page.locator('.chat-item').filter({hasText:'Paciente Ficticio 00002'}).click();await page.locator('[data-mensaje-id="audit-msg-2-180"]').waitFor();await page.waitForTimeout(1200);
 save('rollback-chat-equivocado',{url:page.url(),header:await page.locator('.chat-header').innerText(),draft:await page.locator('app-conversacion-composer textarea').inputValue(),optimisticSent:optimistic.includes('title="Enviado"')});failSend=false;
 }
 await page.goto('http://localhost:4200/finanzas');await page.locator('app-planilla-comisiones tbody tr').first().waitFor();await page.waitForTimeout(250);records=[];
 t=performance.now();await page.locator('app-planilla-comisiones tbody tr').first().click();await page.waitForTimeout(700);
 save('abrir-comisiones-periodo',{elapsedMs:performance.now()-t,text:(await page.locator('app-planilla-comisiones').innerText()).slice(0,2500)});await page.screenshot({path:OUT+'/comisiones-periodo-1440.png'});
 // Configuración es una pestaña del módulo financiero.
 const config=page.getByRole('button',{name:/Configuración/});if(await config.count()){await config.first().click();await page.waitForTimeout(400);await page.screenshot({path:OUT+'/configuracion-1440.png'});save('configuracion',{text:(await page.locator('app-planilla-comisiones').innerText()).slice(0,1700)});}
 await page.goto('http://localhost:4200/perfil?tab=memoria');await page.waitForTimeout(650);await page.screenshot({path:OUT+'/memoria-1440.png'});save('memoria',{text:(await page.locator('body').innerText()).slice(-2000)});
 // Móvil desde un arranque móvil, separado del ensayo de resize escritorio→móvil.
 await page.setViewportSize({width:390,height:844});
 for(const route of ['auth/login','dashboard','conversaciones','clientes','leads','ventas','actividades','finanzas','usuarios','perfil?tab=memoria']){
  await page.goto('http://localhost:4200/'+route);await page.waitForTimeout(500);
  await page.screenshot({path:OUT+'/mobile-'+route.replaceAll('/','-').replace('?tab=','-')+'.png'});
  save('mobile-'+route,{width:390,text:(await page.locator('body').innerText()).slice(0,120),overflow:await page.evaluate(()=>document.documentElement.scrollWidth)});
 }
 }finally{await browser.close();}
};
