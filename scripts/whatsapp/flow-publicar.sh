#!/bin/bash
# Crea en Meta el Flow «Reservar una cita» (borrador) con su endpoint, muestra
# los errores oficiales de validación y, solo con --publicar, lo publica.
# Publicar exige que el endpoint responda al «ping» de Meta: el backend con
# AgendaFlowController desplegado y la llave registrada (flow-llaves.sh).
#
# Se ejecuta EN el servidor del CRM:
#   bash flow-publicar.sh <waba_id> <archivo.json>                  → borrador + errores
#   bash flow-publicar.sh <waba_id> <archivo.json> --publicar <id>  → publica ese borrador
# Variable del token: FLOW_TOKEN_VARIABLE (por defecto WHATSAPP_TOKEN).
set -euo pipefail
WABA="${1:?Falta el waba_id}"; JSON="${2:?Falta el JSON del Flow}"
[[ "$WABA" =~ ^[0-9]+$ ]] || { echo "waba_id inválido"; exit 1; }
VARIABLE="${FLOW_TOKEN_VARIABLE:-WHATSAPP_TOKEN}"
TOKEN=$(grep "^${VARIABLE}=" /opt/crm-backend/.env | cut -d= -f2- | tr -d '"')
[ -n "$TOKEN" ] || { echo "No está $VARIABLE en el .env"; exit 1; }
GRAPH=https://graph.facebook.com/v25.0
ENDPOINT=https://crm.107.175.132.15.nip.io/whatsapp/flows/agenda

if [ "${3:-}" = "--publicar" ]; then
  FLOW="${4:?Falta el id del borrador}"
  [[ "$FLOW" =~ ^[0-9]+$ ]] || { echo "id inválido"; exit 1; }
  curl -sS -X POST "$GRAPH/$FLOW/publish" -H "Authorization: Bearer $TOKEN"; echo
  curl -sS "$GRAPH/$FLOW?fields=status,validation_errors,health_status" -H "Authorization: Bearer $TOKEN"; echo
  exit 0
fi

curl -sS -X POST "$GRAPH/$WABA/flows" -H "Authorization: Bearer $TOKEN" \
  -F name=montalvo_reserva_cita_v1 -F 'categories=["APPOINTMENT_BOOKING"]' \
  -F "endpoint_uri=$ENDPOINT" -F "flow_json=<$JSON"; echo
echo "Si salió un id y validation_errors vacío: revisa la vista previa en WhatsApp Manager y publica con --publicar <id>."
