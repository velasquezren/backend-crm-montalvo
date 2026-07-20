-- CreateEnum
CREATE TYPE "Rol" AS ENUM ('ADMIN', 'AGENTE');

-- CreateEnum
CREATE TYPE "CategoriaCliente" AS ENUM ('PROSPECTO', 'BRONZE', 'SILVER', 'GOLD');

-- CreateEnum
CREATE TYPE "OrigenLead" AS ENUM ('FACEBOOK_LEAD_AD', 'FACEBOOK_COMENTARIO', 'FACEBOOK_MENSAJE', 'INSTAGRAM_LEAD_AD', 'INSTAGRAM_COMENTARIO', 'INSTAGRAM_MENSAJE', 'WHATSAPP_DIRECTO', 'PRESENCIAL', 'IMPORTACION');

-- CreateEnum
CREATE TYPE "EstadoVenta" AS ENUM ('GANADA', 'EN_PROCESO', 'PERDIDA');

-- CreateEnum
CREATE TYPE "EstadoComision" AS ENUM ('PENDIENTE', 'PAGADA');

-- CreateEnum
CREATE TYPE "DireccionMensaje" AS ENUM ('ENTRANTE', 'SALIENTE');

-- CreateTable
CREATE TABLE "Usuario" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "rol" "Rol" NOT NULL DEFAULT 'AGENTE',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cliente" (
    "id" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT NOT NULL,
    "email" TEXT,
    "categoria" "CategoriaCliente" NOT NULL DEFAULT 'PROSPECTO',
    "agenteId" TEXT,
    "datosExtra" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Interes" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "categoriaProducto" TEXT,
    "origen" "OrigenLead" NOT NULL,
    "agenteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Interes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "origen" "OrigenLead" NOT NULL,
    "metaLeadId" TEXT,
    "agenteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversacion" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "agenteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mensaje" (
    "id" TEXT NOT NULL,
    "conversacionId" TEXT NOT NULL,
    "direccion" "DireccionMensaje" NOT NULL,
    "contenido" TEXT NOT NULL,
    "whatsappMsgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mensaje_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Venta" (
    "id" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "agenteId" TEXT NOT NULL,
    "producto" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "estado" "EstadoVenta" NOT NULL DEFAULT 'GANADA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Venta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comision" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "agenteId" TEXT NOT NULL,
    "monto" DECIMAL(12,2) NOT NULL,
    "estado" "EstadoComision" NOT NULL DEFAULT 'PENDIENTE',
    "pagadaEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entidad" TEXT NOT NULL,
    "entidadId" TEXT NOT NULL,
    "accion" TEXT NOT NULL,
    "usuarioId" TEXT,
    "cambios" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_email_key" ON "Usuario"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Cliente_telefono_key" ON "Cliente"("telefono");

-- CreateIndex
CREATE INDEX "Cliente_categoria_idx" ON "Cliente"("categoria");

-- CreateIndex
CREATE INDEX "Cliente_nombre_idx" ON "Cliente"("nombre");

-- CreateIndex
CREATE INDEX "Interes_clienteId_idx" ON "Interes"("clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_metaLeadId_key" ON "Lead"("metaLeadId");

-- CreateIndex
CREATE INDEX "Lead_clienteId_idx" ON "Lead"("clienteId");

-- CreateIndex
CREATE INDEX "Conversacion_clienteId_idx" ON "Conversacion"("clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "Mensaje_whatsappMsgId_key" ON "Mensaje"("whatsappMsgId");

-- CreateIndex
CREATE INDEX "Mensaje_conversacionId_idx" ON "Mensaje"("conversacionId");

-- CreateIndex
CREATE INDEX "Venta_clienteId_idx" ON "Venta"("clienteId");

-- CreateIndex
CREATE INDEX "Venta_agenteId_idx" ON "Venta"("agenteId");

-- CreateIndex
CREATE UNIQUE INDEX "Comision_ventaId_key" ON "Comision"("ventaId");

-- CreateIndex
CREATE INDEX "Comision_agenteId_idx" ON "Comision"("agenteId");

-- CreateIndex
CREATE INDEX "AuditLog_entidad_entidadId_idx" ON "AuditLog"("entidad", "entidadId");

-- AddForeignKey
ALTER TABLE "Cliente" ADD CONSTRAINT "Cliente_agenteId_fkey" FOREIGN KEY ("agenteId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interes" ADD CONSTRAINT "Interes_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Interes" ADD CONSTRAINT "Interes_agenteId_fkey" FOREIGN KEY ("agenteId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_agenteId_fkey" FOREIGN KEY ("agenteId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversacion" ADD CONSTRAINT "Conversacion_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversacion" ADD CONSTRAINT "Conversacion_agenteId_fkey" FOREIGN KEY ("agenteId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mensaje" ADD CONSTRAINT "Mensaje_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "Conversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Cliente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Venta" ADD CONSTRAINT "Venta_agenteId_fkey" FOREIGN KEY ("agenteId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comision" ADD CONSTRAINT "Comision_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "Venta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comision" ADD CONSTRAINT "Comision_agenteId_fkey" FOREIGN KEY ("agenteId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
