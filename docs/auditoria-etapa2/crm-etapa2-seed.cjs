const root='/Users/macmini2024/Documents/CARPETA RENE/CRM/backend-crm-montalvo';
const {PrismaService}=require(root+'/dist/prisma/prisma.service.js');
const bcrypt=require(root+'/node_modules/bcryptjs');
const db=new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_audit');
async function main(){
 const passwordHash=await bcrypt.hash('AuditoriaLocal2026!',10);
 for(const [id,nombre,rol,codigo] of [['audit-admin','Administración de prueba','SUPER_ADMIN','AUD01'],['audit-agente','Agente de prueba','AGENTE','AUD02'],['audit-agente-b','Agente B de prueba','AGENTE','AUD03']])
  await db.usuario.create({data:{id,nombre,rol,codigo,email:id+'@example.test',passwordHash}});
 await db.$executeRawUnsafe(`INSERT INTO "Cliente" (id,nombre,telefono,pac,categoria,"agenteId","fechaNacimiento",sexo,"datosExtra","createdAt","updatedAt") SELECT 'audit-cli-'||i,'Paciente Ficticio '||lpad(i::text,5,'0'),'000'||lpad(i::text,8,'0'),'AUD'||i, (ARRAY['PROSPECTO','BRONZE','SILVER','GOLD'])[1+i%4]::"CategoriaCliente",CASE WHEN i%3=0 THEN 'audit-agente' ELSE 'audit-admin' END,'1990-01-01'::date,CASE WHEN i%2=0 THEN 'F' ELSE 'M' END,jsonb_build_object('notas','Datos exclusivamente sintéticos','notaFijada','Nota de auditoría ficticia'),now()-i*interval '1 minute',now()-i*interval '1 minute' FROM generate_series(1,16000) i`);
 await db.$executeRawUnsafe(`INSERT INTO "Lead" (id,"clienteId",origen,estado,"agenteId","createdAt") SELECT 'audit-lead-'||i,'audit-cli-'||i,(ARRAY['PRESENCIAL','WHATSAPP_DIRECTO','FACEBOOK_LEAD_AD'])[1+i%3]::"OrigenLead",(ARRAY['NUEVO','CONTACTADO','CONVERTIDO','PERDIDO'])[1+i%4]::"EstadoLead",CASE WHEN i%3=0 THEN 'audit-agente' ELSE 'audit-admin' END,now()-i*interval '1 minute' FROM generate_series(1,15600) i`);
 await db.$executeRawUnsafe(`INSERT INTO "Conversacion" (id,"clienteId","agenteId","esperandoRespuesta","createdAt","updatedAt") SELECT 'audit-chat-'||i,'audit-cli-'||i,CASE WHEN i%3=0 THEN 'audit-agente' WHEN i%3=1 THEN 'audit-admin' ELSE NULL END,i%2=0,now()-interval '3 days',now()-i*interval '1 minute' FROM generate_series(1,600) i`);
 await db.$executeRawUnsafe(`INSERT INTO "Mensaje" (id,"conversacionId",direccion,contenido,"estadoEnvio","createdAt") SELECT 'audit-msg-'||c||'-'||m,'audit-chat-'||c,CASE WHEN m%2=0 THEN 'ENTRANTE' ELSE 'SALIENTE' END::"DireccionMensaje",'Mensaje ficticio '||m||' del paciente '||c||CASE WHEN m=5 THEN ' PALABRA-HISTORICA' ELSE '. Consulta de prueba sobre disponibilidad y seguimiento.' END,CASE WHEN m%2=0 THEN NULL ELSE 'ENVIADO'::"EstadoMensaje" END,now()-interval '4 hours'+m*interval '1 second' FROM generate_series(1,600) c CROSS JOIN LATERAL generate_series(1,CASE WHEN c<=2 THEN 180 ELSE 6 END) m`);
 await db.$executeRawUnsafe(`INSERT INTO "Actividad" (id,titulo,"clienteId","agenteId","fechaProgramada","updatedAt") SELECT 'audit-act-'||i,'Seguimiento ficticio '||i,'audit-cli-'||i,'audit-admin',now()+((i%15)-7)*interval '1 day',now() FROM generate_series(1,90) i`);
 await db.$executeRawUnsafe(`INSERT INTO "Venta" (id,"clienteId","agenteId",producto,monto,estado,"createdAt") SELECT 'audit-venta-'||i,'audit-cli-'||i,'audit-admin','Servicio ficticio '||i,100+i,(ARRAY['GANADA','EN_PROCESO','PERDIDA'])[1+i%3]::"EstadoVenta",now()-i*interval '1 hour' FROM generate_series(1,80) i`);
 for(let i=1;i<=8;i++){
  await db.plantillaAgente.create({data:{id:'audit-tpl-'+i,usuarioId:'audit-admin',titulo:'Respuesta ficticia '+i,atajo:'/prueba'+i,contenido:'Texto ficticio de respuesta '+i}});
  await db.recursoMemoriaAgente.create({data:{id:'audit-mem-'+i,usuarioId:'audit-admin',titulo:'Recurso ficticio '+i,contenido:'Información de prueba '+i,tipo:'TEXTO',categoria:'RESPUESTA_RAPIDA',atajo:'/memoria'+i}});
 }
 await db.periodoComision.create({data:{id:'audit-periodo',anio:2026,mes:9,tipoCambio:6.96,estado:'BORRADOR',archivoNombre:'Auditoria-sintetica.xlsx'}});
 console.log(JSON.stringify({clientes:await db.cliente.count(),leads:await db.lead.count(),conversaciones:await db.conversacion.count(),mensajes:await db.mensaje.count(),actividades:await db.actividad.count(),ventas:await db.venta.count()}));
}
main().finally(()=>db.$disconnect());
