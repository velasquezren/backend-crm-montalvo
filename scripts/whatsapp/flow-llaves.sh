#!/bin/bash
# Llave del endpoint del Flow «Reservar una cita» (WhatsApp Flows, data_api 3.0).
#
# Se ejecuta EN el servidor del CRM, como root. Genera un par RSA-2048: la
# PRIVADA queda en /etc/crm-flows/privada.pem (solo root y crmapp la leen; nunca
# sale del servidor ni se imprime) y la PÚBLICA se registra en el número de
# WhatsApp con la Graph API, usando el token que ya está en el .env del CRM.
#
# Uso:  bash flow-llaves.sh <phone_number_id> [VARIABLE_DEL_TOKEN] [--rotar]
#       (por defecto WHATSAPP_TOKEN)
#
# UNA llave del servidor sirve a todos los números: si ya existe, solo se
# registra su parte pública en el número pedido. `--rotar` genera otra, y
# entonces hay que volver a registrarla en TODOS los números que usan Flows
# (si no, los Flows de los demás números dejan de abrir).
set -euo pipefail
NUMERO="${1:?Falta el phone_number_id}"
VARIABLE="${2:-WHATSAPP_TOKEN}"
ROTAR="${3:-}"
[[ "$NUMERO" =~ ^[0-9]+$ ]] || { echo "phone_number_id inválido"; exit 1; }
ENV=/opt/crm-backend/.env
TOKEN=$(grep "^${VARIABLE}=" "$ENV" | cut -d= -f2- | tr -d '"')
[ -n "$TOKEN" ] || { echo "No está $VARIABLE en $ENV"; exit 1; }
GRAPH=https://graph.facebook.com/v25.0

DIR=/etc/crm-flows
install -d -m 750 -o root -g crmapp "$DIR"
umask 027
NUEVA=false
if [ ! -s "$DIR/privada.pem" ] || [ "$ROTAR" = "--rotar" ]; then
  NUEVA=true
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$DIR/privada.pem.nueva" 2>/dev/null
  openssl pkey -in "$DIR/privada.pem.nueva" -pubout -out "$DIR/publica.pem.nueva"
  chown root:crmapp "$DIR/privada.pem.nueva" "$DIR/publica.pem.nueva"; chmod 640 "$DIR/privada.pem.nueva" "$DIR/publica.pem.nueva"
  PUBLICA="$DIR/publica.pem.nueva"
else
  PUBLICA="$DIR/publica.pem"
  echo "Se reutiliza la llave existente del servidor."
fi

echo "Registrando la llave pública en el número $NUMERO…"
RESPUESTA=$(curl -sS -X POST "$GRAPH/$NUMERO/whatsapp_business_encryption" \
  -H "Authorization: Bearer $TOKEN" --data-urlencode "business_public_key@$PUBLICA")
if ! echo "$RESPUESTA" | grep -q '"success":true'; then
  echo "Meta no aceptó la llave: $RESPUESTA"; rm -f "$DIR/privada.pem.nueva" "$DIR/publica.pem.nueva"; exit 1
fi
if [ "$NUEVA" = true ]; then
  mv "$DIR/privada.pem.nueva" "$DIR/privada.pem"; mv "$DIR/publica.pem.nueva" "$DIR/publica.pem"
  [ "$ROTAR" = "--rotar" ] && echo "AVISO: llave rotada. Vuelve a registrarla en los demás números con Flows."
fi

ESTADO=$(curl -sS "$GRAPH/$NUMERO/whatsapp_business_encryption" -H "Authorization: Bearer $TOKEN")
echo "Estado en Meta: $ESTADO" | sed 's/"business_public_key":"[^"]*"/"business_public_key":"(omitida)"/'

sed -i '/^WHATSAPP_FLOWS_LLAVE_ARCHIVO=/d' "$ENV"
echo "WHATSAPP_FLOWS_LLAVE_ARCHIVO=$DIR/privada.pem" >> "$ENV"
unset TOKEN
echo "Listo: llave registrada y WHATSAPP_FLOWS_LLAVE_ARCHIVO en el .env. Reinicia el CRM para que la lea."
