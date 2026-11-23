# 9. Endurecimiento de la máquina: qué quedó y qué no

> Parte de la skill `crm-backend-arquitectura`: lee antes su [índice](../SKILL.md).

El 2026-09-02 se optimizó la máquina **anterior** (AlmaLinux, un núcleo,
`107.172.193.34`), que dejó de usarse en la migración del 17/09. El detalle de
aquella sesión —`/etc/httpd/…`, `firewalld`, MySQL, `webmin` y `vsftpd` en la
misma máquina— está en el [historial de septiembre](../../../../docs/historial/estado-2026-09.md)
y **no describe este servidor**. Lo que vale hoy, comprobado el 2026-10-27:

| Qué | En la máquina actual |
|---|---|
| SSH solo por llave y `fail2ban` | Sí (§6) |
| Respaldos diarios locales y externo | Sí (§4) |
| Pool de Prisma en 10 | Sí, `PrismaService` (§4, Prisma 7) |
| Apache `MaxRequestWorkers 150` | Sí |
| Firewall | `ufw`; no hay MySQL, `webmin` ni `vsftpd` en este servidor |
| Tope al journal de systemd | **No**: sin `journald.conf.d`, ocupaba 557 MB el 27/10 |

Una lección de aquella sesión que sigue valiendo: **correr `ANALYZE` después de
cualquier importación masiva**. `Lead` y `Cliente` llegaron a tener estadísticas
viejas porque una tabla cargada de golpe y luego casi quieta no cruza nunca el
umbral de `autoanalyze` (50 filas + 10 %), y el planificador elegía a ciegas.
