# 6. Credenciales y acceso — deliberadamente NO están en este archivo

> Parte de la skill `crm-backend-arquitectura`: lee antes su [índice](../SKILL.md).

Este archivo vive en el repo (`.claude/skills/`) y probablemente termina en
GitHub. Nunca pongas acá contraseñas, tokens o claves reales — quedan en el
historial de git para siempre, aunque se borren después.

Lo que sí conviene dejar anotado (sin el secreto):

- **Acceso al servidor** (comprobado con `sshd -T` el 2026-10-27): **solo por
  llave**. `/etc/ssh/sshd_config.d/99-crm-hardening.conf`, puesto en la
  migración del 17/09, fija `PasswordAuthentication no`, `PermitRootLogin
  prohibit-password` y `KbdInteractiveAuthentication no`. `root` tiene tres
  llaves autorizadas: dos ED25519 del dueño y una restringida con
  `from="23.95.128.187"` (el servidor de la agenda). **`crmapp` no tiene
  llave**: todo despliegue entra como `root` y baja de privilegios con
  `sudo -u crmapp` comando a comando. `Permission denied (publickey)` desde la
  máquina del dueño casi siempre es el agente SSH vacío tras reiniciar
  (`ssh-add` de su llave), no un cambio en el servidor.

  `fail2ban` está activo con la jail `sshd` (más de 1.100 IPs baneadas hasta
  el 27/10). Contexto de por qué: en la máquina anterior (AlmaLinux, hasta el
  17/09) se midieron el 2026-09-02 **2,2 millones de intentos de contraseña
  desde 10.818 IPs en menos de una semana**; esa máquina ya no existe y sus
  rutas (`/var/log/secure`, `50-redhat.conf`, EPEL) no aplican a esta.
- **Credenciales de la base** (`crm_app` / password real): están en
  `/opt/crm-backend/.env` en el servidor, y en `.env` local (gitignorado, no
  confundir con `.env.example` que sí está en git y no lleva secretos).
- **`WHATSAPP_TOKEN` / `META_APP_SECRET` / `VAPID_*`**: mismo criterio, viven
  solo en `.env`. `.env.example` documenta cuáles son obligatorias y por qué
  (ver los comentarios ahí — `check:skills` obliga a que `META_APP_SECRET` esté
  documentada si hay webhooks).
- **Los tres repositorios de GitHub son públicos** (comprobado el 27/10:
  backend, frontend y Resultados). Por eso `git pull` funciona en el servidor
  sin llave. Consecuencia: nada de este archivo ni de `docs/` puede llevar
  secretos, y el código y la topología (IP, rutas, puertos) son visibles para
  cualquiera. Volverlos privados exige dar al servidor una llave de despliegue
  de solo lectura antes del siguiente `git pull`.
