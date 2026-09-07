const fs=require('fs');
const {PrismaService}=require('/Users/macmini2024/Documents/CARPETA RENE/CRM/backend-crm-montalvo/dist/prisma/prisma.service.js');
exports.main=async()=>{
 const db=new PrismaService('postgresql://crm_app@127.0.0.1:5433/crm_audit');
 try{
 for(let i=1;i<=8;i++)await db.vendedoraComision.upsert({where:{codigo:'AUD0'+i},create:{id:'audit-vend-'+i,codigo:'AUD0'+i,nombre:'Vendedora Ficticia '+i,configurada:true,sueldoBase:2500},update:{}});
 if(await db.ventaImportada.count()===0)await db.ventaImportada.createMany({data:Array.from({length:2400},(_,j)=>{const i=j+1;return {id:'audit-import-'+i,periodoId:'audit-periodo',fecha:new Date(),detalle:'Consulta ficticia '+i,pac:'AUD'+i,paciente:'Paciente Ficticio '+String(i).padStart(5,'0'),vendedoraId:'audit-vend-'+(1+j%8),vendedoraPk:'AUD0'+(1+j%8),vendedoraNombre:'Vendedora Ficticia '+(1+j%8),precio:100,ingresoNeto:87,canal:'EMPRESA',unidadNegocio:'VARIOS',clasif:'CONSULTA',tipo:'C',tc:6.96,modulo:'CONSULTA'}})});
 await db.periodoComision.update({where:{id:'audit-periodo'},data:{filasTotales:2400,filasValidas:2400}});
 for(let i=91;i<=150;i++)await db.actividad.upsert({where:{id:'audit-act-'+i},create:{id:'audit-act-'+i,titulo:'Seguimiento ficticio '+i,clienteId:'audit-cli-'+i,agenteId:'audit-admin',fechaProgramada:new Date()},update:{}});
 for(let i=9;i<=60;i++)await db.recursoMemoriaAgente.upsert({where:{id:'audit-mem-'+i},create:{id:'audit-mem-'+i,usuarioId:'audit-admin',titulo:'Recurso ficticio '+i,contenido:'Texto exclusivamente sintético',tipo:'TEXTO',categoria:'GENERAL'},update:{}});
 const counts={clientes:await db.cliente.count(),leads:await db.lead.count(),conversaciones:await db.conversacion.count(),mensajes:await db.mensaje.count(),actividades:await db.actividad.count(),ventasImportadas:await db.ventaImportada.count(),recursosMemoria:await db.recursoMemoriaAgente.count()};
 fs.writeFileSync('/Users/macmini2024/Documents/CARPETA RENE/CRM/auditoria-etapa2/evidencia/fixture.json',JSON.stringify(counts,null,2));console.log(counts);
 }finally{await db.$disconnect();}
};
