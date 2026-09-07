const {chromium}=require('/Users/macmini2024/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const fs=require('fs');
const OUT='/Users/macmini2024/Documents/CARPETA RENE/CRM/auditoria-etapa2/evidencia';
const pw='/Users/macmini2024/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const {PrismaService}=require('/Users/macmini2024/Documents/CARPETA RENE/CRM/backend-crm-montalvo/dist/prisma/prisma.service.js');
exports.main=async()=>{
 const db=new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_audit');
 const browser=await chromium.launch({executablePath:pw,headless:true});
 const context=await browser.newContext({storageState:'/tmp/crm-etapa2-storage.json',viewport:{width:1440,height:900},serviceWorkers:'block'});
 let delay=0,holdHistory=false,holdPage=false,failDetail=false,failSend=false,socketRoute;
 await context.route('**/*',async r=>{
  const u=new URL(r.request().url());
  if(!['localhost','127.0.0.1','fonts.gstatic.com'].includes(u.hostname))return r.abort();
  if(u.port==='3001'){
   if(failDetail&&u.pathname==='/conversaciones/audit-chat-3')return r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({message:'Fallo de red simulado para auditoría'})});
   if(failSend&&u.pathname.endsWith('/mensajes')&&r.request().method()==='POST'){await new Promise(a=>setTimeout(a,1000));return r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({message:'Envío rechazado en prueba'})});}
   if(holdHistory&&u.pathname.includes('mensajes-anteriores'))await new Promise(a=>setTimeout(a,900));
   else if(holdPage&&u.searchParams.get('pagina')==='2')await new Promise(a=>setTimeout(a,900));
   else if(delay)await new Promise(a=>setTimeout(a,delay));
  }
  await r.continue();
 });
 await context.routeWebSocket('**/socket.io/**',ws=>{ws.connectToServer();socketRoute=ws;});
 const page=await context.newPage();page.setDefaultTimeout(6000);
 let records=[],errors=[];const results=process.argv[3]==='rest'?JSON.parse(fs.readFileSync(OUT+'/inbox-pruebas.json')):[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().includes(':3001/'))records.push({method:r.request().method(),url:new URL(r.url()).pathname+new URL(r.url()).search,status:r.status(),bytes:(await r.body().catch(()=>Buffer.alloc(0))).length});});
 const save=(name,data)=>{const item={name,...data,requests:records,errors};results.push(item);fs.writeFileSync(OUT+'/inbox-pruebas.json',JSON.stringify(results,null,2));console.log(JSON.stringify(item));records=[];errors=[];};
 const shot=name=>page.screenshot({path:OUT+'/'+name+'.png'});
 const open=async id=>{await page.locator('.chat-item').filter({hasText:'Paciente Ficticio '+String(id).padStart(5,'0')}).click();await page.locator('[data-mensaje-id="audit-msg-'+id+'-180"]').waitFor();};
 const emit=id=>socketRoute.send('42/realtime,'+JSON.stringify(['conversacion:actividad',{conversacionId:'audit-chat-'+id}]));
 try{
  await page.goto('http://localhost:4200/conversaciones');await page.locator('.chat-item').first().waitFor();await page.waitForTimeout(600);records=[];
  await open(1);await page.waitForTimeout(300);await shot('chat-1440');save('abrir-chat',{messages:await page.locator('[data-mensaje-id]').count()});
  if(process.argv[3]!=='rest'){
  delay=190;
  for(let i=0;i<6;i++){
   const id=i%2===0?2:1;const start=performance.now();
   await page.locator('.chat-item').filter({hasText:'Paciente Ficticio '+String(id).padStart(5,'0')}).click();
   const immediate=await page.locator('app-conversacion-thread').innerText();
   await page.locator('[data-mensaje-id="audit-msg-'+id+'-180"]').waitFor();
   save('cambio-chat-'+i,{id,usefulMs:performance.now()-start,immediate:immediate.slice(0,180)});
   await page.waitForTimeout(240);
  }
  delay=0;await page.waitForTimeout(350);records=[];
  // Una confirmación de lectura cambia Mensaje, sin cambiar Conversacion.updatedAt.
  const msg='audit-msg-1-179';
  await db.mensaje.update({where:{id:msg},data:{estadoEnvio:'LEIDO'}});emit(1);await page.waitForTimeout(450);
  save('equal-estado-mensaje',{dbState:(await db.mensaje.findUnique({where:{id:msg}})).estadoEnvio,domMessage:await page.locator('[data-mensaje-id="'+msg+'"]').innerHTML()});
  await db.mensaje.update({where:{id:msg},data:{estadoEnvio:'ENVIADO'}});
  }
  // Confirmación de edición de la ficha con la misma versión de conversación.
  await page.getByTitle('Editar ficha del cliente',{exact:true}).click();
  await page.locator('input[placeholder="Nombre completo"]').fill('Paciente Ficticio 00001 EDITADO');
  await page.getByRole('button',{name:'Guardar cambios',exact:true}).click();await page.waitForTimeout(600);
  save('equal-edicion-ficha',{dbName:(await db.cliente.findUnique({where:{id:'audit-cli-1'}})).nombre,threadName:await page.locator('.chat-header').innerText(),listName:await page.locator('.chat-item').first().innerText()});
  await db.cliente.update({where:{id:'audit-cli-1'},data:{nombre:'Paciente Ficticio 00001'}});
  // La búsqueda visible no consulta el historial que todavía no se cargó.
  await page.getByRole('button',{name:'Buscar en esta conversación',exact:true}).click();
  await page.getByPlaceholder('Buscar en el chat…').fill('PALABRA-HISTORICA');await page.waitForTimeout(250);
  save('busqueda-historica',{matchesDom:await page.locator('.chat-search-count').innerText(),matchesDb:await db.mensaje.count({where:{conversacionId:'audit-chat-1',contenido:{contains:'PALABRA-HISTORICA'}}})});
  await page.getByRole('button',{name:'Cerrar búsqueda',exact:true}).click();
  // Historial cargado, seguido de aviso realtime.
  await page.locator('.chat-messages').evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});await page.waitForTimeout(400);
  const historyBefore=await page.locator('[data-mensaje-id]').count();emit(1);await page.waitForTimeout(400);
  save('historial-refetch',{before:historyBefore,after:await page.locator('[data-mensaje-id]').count()});
  // Ráfaga de dos conversaciones distintas dentro de la ventana de debounce.
  emit(1);await page.waitForTimeout(20);emit(2);await page.waitForTimeout(400);save('rafaga-dos-chats',{});
  // Respuesta de historial A que llega después de seleccionar B.
  holdHistory=true;await page.locator('.chat-messages').evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});await page.waitForTimeout(50);
  await open(2);await page.waitForTimeout(1100);holdHistory=false;
  save('carrera-historial',{url:page.url(),header:await page.locator('.chat-header').innerText(),firstMessage:await page.locator('[data-mensaje-id]').first().getAttribute('data-mensaje-id')});await shot('carrera-historial');
  // Cargar página 2 de Todas y cambiar a Sin responder antes de recibirla.
  await page.goto('http://localhost:4200/conversaciones');await page.locator('.chat-item').first().waitFor();await page.waitForTimeout(300);records=[];holdPage=true;
  await page.getByRole('button',{name:/Cargar más/}).click();await page.waitForTimeout(50);
  await page.locator('.tabs-inbox button').filter({hasText:'Sin responder'}).click();await page.waitForTimeout(1100);holdPage=false;
  const displayed=await page.locator('.chat-item p').allTextContents();
  save('carrera-paginacion',{totalRows:await page.locator('.chat-item').count(),oddRows:displayed.filter(t=>Number(t.match(/\d+/)?.[0])%2===1).slice(0,5)});
  // Error de detalle.
  await page.goto('http://localhost:4200/conversaciones');await page.locator('.chat-item').first().waitFor();await page.waitForTimeout(250);records=[];failDetail=true;
  await page.locator('.chat-item').filter({hasText:'Paciente Ficticio 00003'}).click();await page.waitForTimeout(500);await shot('error-detalle');
  save('error-detalle',{text:(await page.locator('app-conversacion-thread').innerText()).slice(0,600),url:page.url()});failDetail=false;
 }finally{await db.$disconnect();await browser.close();}
};
