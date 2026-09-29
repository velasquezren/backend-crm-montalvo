-- Ver una línea y que te avise son cosas distintas: una agente puede cubrir
-- Recepción sin que le suene cada mensaje del pool. Por defecto `true`, así que
-- nadie deja de recibir lo que recibía hasta que un admin lo decida.
ALTER TABLE "AccesoLineaWhatsapp" ADD COLUMN "notificar" BOOLEAN NOT NULL DEFAULT true;
