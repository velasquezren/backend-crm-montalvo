#!/bin/bash
# Llave del endpoint del Flow «Reservar una cita» (WhatsApp Flows, data_api 3.0).
#
# Se ejecuta EN el servidor del CRM, como root. Genera un par RSA-2048: la
# PRIVADA queda en /etc/crm-flows/privada.pem (solo root y crmapp la leen; nunca
# sale del servidor ni se imprime) y la PÚBLICA se registra en el número de
# WhatsApp con la Graph API, usando el token que ya está en el .env del CRM.
#
# Uso:  bash flow-llaves.sh <phone_number_id> [VARIABLE_DEL_TOKEN]
#       (por defecto WHATSAPP_TOKEN, el de la línea de prueba)
#
# Rotar la llave = volver a ejecutarlo: Meta usa la última registrada.
set -euo pipefail
NUMERO="${1:?Falta el phone_number_id}"
VARIABLE="${2:-WHATSAPP_TOKEN}"
[[ "$NUMERO" =~ ^[0-9]+$ ]] || { echo "phone_number_id inválido"; exit 1; }
ENV=/opt/crm-backend/.env
TOKEN=$(grep "^${VARIABLE}=" "$ENV" | cut -d= -f2- | tr -d '"')
[ -n "$TOKEN" ] || { echo "No está $VARIABLE en $ENV"; exit 1; }
GRAPH=https://graph.facebook.com/v25.0

DIR=/etc/crm-flows
install -d -m 750 -o root -g crmapp "$DIR"
umask 027
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$DIR/privada.pem.nueva" 2>/dev/null
openssl pkey -in "$DIR/privada.pem.nueva" -pubout -out "$DIR/publica.pem"
chown root:crmapp "$DIR/privada.pem.nueva" "$DIR/publica.pem"
chmod 640 "$DIR/privada.pem.nueva" "$DIR/publica.pem"

echo "Registrando la llave pública en el número $NUMERO…"
RESPUESTA=$(curl -sS -X POST "$GRAPH/$NUMERO/whatsapp_business_encryption" \
  -H "Authorization: Bearer $TOKEN" --data-urlencode "business_public_key@$DIR/publica.pem")
echo "$RESPUESTA" | grep -q '"success":true' || { echo "Meta no aceptó la llave: $RESPUESTA"; rm -f "$DIR/privada.pem.nueva"; exit 1; }
mv "$DIR/privada.pem.nueva" "$DIR/privada.pem"

ESTADO=$(curl -sS "$GRAPH/$NUMERO/whatsapp_business_encryption" -H "Authorization: Bearer $TOKEN")
echo "Estado en Meta: $ESTADO" | sed 's/"business_public_key":"[^"]*"/"business_public_key":"(omitida)"/'

sed -i '/^WHATSAPP_FLOWS_LLAVE_ARCHIVO=/d' "$ENV"
echo "WHATSAPP_FLOWS_LLAVE_ARCHIVO=$DIR/privada.pem" >> "$ENV"
unset TOKEN
echo "Listo: llave registrada y WHATSAPP_FLOWS_LLAVE_ARCHIVO en el .env. Reinicia el CRM para que la lea."
