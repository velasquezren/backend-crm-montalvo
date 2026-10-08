// GENERADO por `npm run flows:generar` desde docs/whatsapp-interacciones/flows/manifest.json.
// No se edita a mano: `npm run check:flows` (parte del build) falla si no coincide.
import type { FlowPublicado } from './interacciones-integracion';

export const FLOWS_PUBLICADOS: readonly FlowPublicado[] = [
  {
    "id": "1603800134806928",
    "wabaId": "1699047341353103",
    "version": "solicitud-cita.v1",
    "pantalla": "MOTIVO",
    "respuestas": {
      "especialidad": [
        "GINECOLOGIA",
        "MATERNIDAD",
        "REPRODUCCION_ASISTIDA",
        "OTRA",
        "ORIENTACION"
      ],
      "cuando": [
        "LO_ANTES_POSIBLE",
        "PROXIMA_SEMANA",
        "MAS_ADELANTE"
      ],
      "horario": [
        "MANANA",
        "TARDE",
        "INDISTINTO"
      ]
    },
    "titulos": {
      "especialidad": {
        "GINECOLOGIA": "Ginecología",
        "MATERNIDAD": "Maternidad",
        "REPRODUCCION_ASISTIDA": "Reproducción asistida",
        "OTRA": "Otra especialidad",
        "ORIENTACION": "No sé, necesito orientación"
      },
      "cuando": {
        "LO_ANTES_POSIBLE": "Lo antes posible",
        "PROXIMA_SEMANA": "La próxima semana",
        "MAS_ADELANTE": "Más adelante"
      },
      "horario": {
        "MANANA": "Por la mañana",
        "TARDE": "Por la tarde",
        "INDISTINTO": "Cualquier horario"
      }
    },
    "proposito": "SOLICITUD_CITA",
    "etiquetas": {
      "especialidad": "Especialidad",
      "cuando": "Cuándo",
      "horario": "Horario"
    }
  },
  {
    "id": "983104870865405",
    "wabaId": "1699047341353103",
    "version": "reserva-cita.v1",
    "pantalla": "ESPECIALIDAD",
    "respuestas": {},
    "titulos": {},
    "campos": {
      "reserva": {
        "tipo": "texto",
        "max": 12
      },
      "resumen": {
        "tipo": "texto",
        "max": 200
      }
    },
    "proposito": "RESERVA_CITA",
    "endpoint": true,
    "etiquetas": {}
  }
];
