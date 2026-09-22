-- Rol ASISTENTE: la persona que asiste al médico y entrega los resultados al
-- paciente por WhatsApp. Opera igual que RECEPCION —atiende los chats de sus
-- líneas, sin alcance comercial— pero es una cuenta distinta y auditable.
ALTER TYPE "Rol" ADD VALUE IF NOT EXISTS 'ASISTENTE';
