-- Exclusivamente MySQL descartable. Ningún dato ni credencial de producción.
CREATE DATABASE clinica CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE clinica;
SET NAMES utf8mb4;
CREATE TABLE medicos (medico_pk INT PRIMARY KEY, codigo VARCHAR(50), nombre VARCHAR(200), sigla VARCHAR(5), especialidad VARCHAR(200), estado VARCHAR(10), horario_html TEXT, precio_con DECIMAL(10,2), orden INT, login VARCHAR(50), password VARCHAR(50), telefono VARCHAR(50), banco INT);
CREATE TABLE horarios (id_hora INT AUTO_INCREMENT PRIMARY KEY, medico_pk INT, cod_med VARCHAR(20), dia VARCHAR(20), hora TIME, estado VARCHAR(10));
CREATE TABLE agenda_med (agendam_pk INT AUTO_INCREMENT PRIMARY KEY, cod_med VARCHAR(20), fecha DATE, hora TIME, estado VARCHAR(10), paciente VARCHAR(200));
-- Columnas, tipos y nulabilidad de producción (ibd2sdi, 6/10/2026). Sin auto_increment, como allí.
CREATE TABLE para_agendar (para_age INT NOT NULL PRIMARY KEY, medico_pk INT, fecha DATE, hora TIME, nombre_age VARCHAR(200), telefono_age VARCHAR(100), ci_age VARCHAR(100), obs VARCHAR(500), estado VARCHAR(10), nom_med VARCHAR(200), uno INT, fecha_registro DATE, hora_registro TIME, nit VARCHAR(20), razon_social VARCHAR(100), precio_con DECIMAL(10,2), banco INT, comprobante MEDIUMBLOB, sucursal VARCHAR(50));
CREATE TABLE pagos_qr (qr_pk INT NOT NULL PRIMARY KEY, banco VARCHAR(150), Qr VARCHAR(200), fecha_vence DATE);
-- La misma regla auditada: todos los estados de agenda_med ocupan, para_agendar
-- no participa. Las fechas son relativas para que la prueba no caduque.
CREATE VIEW vista_horas_libres AS
WITH RECURSIVE fechas AS (SELECT CURRENT_DATE() AS fecha, 0 AS n UNION ALL SELECT fecha + INTERVAL 1 DAY, n + 1 FROM fechas WHERE n < 29)
SELECT f.fecha, h.cod_med, h.hora AS hora_disponible, h.dia, h.estado, h.medico_pk
FROM fechas f JOIN horarios h ON h.dia = ELT(DAYOFWEEK(f.fecha), 'Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado')
LEFT JOIN agenda_med a ON a.cod_med = h.cod_med AND a.fecha = f.fecha AND a.hora = h.hora
WHERE a.agendam_pk IS NULL GROUP BY f.fecha, h.cod_med, h.hora, h.dia, h.estado, h.medico_pk;
INSERT INTO medicos VALUES
(1,'A','Profesional sintético A','Dra.','Especialidad sintética','ACTIVO','<b>Semanal</b>',400.25,1,'privado','secreto-sintetico','telefono-privado',7),
(2,'B','Profesional sintético B','Dr.','Especialidad sintética','ACTIVO','<b>Semanal</b>',NULL,2,'privado','secreto-sintetico','telefono-privado',8),
(3,'C','Profesional a solicitud','Dr.','Otra especialidad','ACTIVO',NULL,0,3,'privado','secreto-sintetico','telefono-privado',NULL),
(4,'D','Profesional inactivo','Dr.','Oculta','INACTIVO','<b>Semanal</b>',500,4,'privado','secreto-sintetico','telefono-privado',NULL);
INSERT INTO pagos_qr VALUES (7,'Banco sintético','QR sintetico.png',CURRENT_DATE() + INTERVAL 30 DAY),(8,'Banco vencido','QR vencido.png',CURRENT_DATE() - INTERVAL 1 DAY);
SET @dia=ELT(DAYOFWEEK(CURRENT_DATE()+INTERVAL 1 DAY),'Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado');
INSERT INTO horarios (medico_pk,cod_med,dia,hora,estado) VALUES (1,'A',@dia,'09:00','ACTIVO'),(1,'A',@dia,'10:00','ACTIVO'),(1,'A',@dia,'11:00','ACTIVO'),(1,'A',@dia,'12:00','INACTIVO'),(1,'A',@dia,'13:00','ACTIVO'),(1,'A',@dia,'14:00','ACTIVO'),(1,'A',@dia,'15:00','ACTIVO'),(2,'B',@dia,'09:00','ACTIVO');
INSERT INTO agenda_med (cod_med,fecha,hora,estado,paciente) VALUES ('A',CURRENT_DATE()+INTERVAL 1 DAY,'09:00','CREADO','Paciente sintético'),('A',CURRENT_DATE()+INTERVAL 1 DAY,'10:00','BORRADO','Paciente sintético'),('B',CURRENT_DATE()+INTERVAL 1 DAY,'09:00','CREADO','Paciente sintético');
-- 13:00 tiene una reserva web PENDIENTE (ocupa); 11:00 una ATENDIDO histórica (no ocupa:
-- lo que se atendió ya pasó por agenda_med). 14:00 y 15:00 quedan para las pruebas de reserva.
INSERT INTO para_agendar (para_age,medico_pk,fecha,hora,nombre_age,ci_age,estado,uno) VALUES
(1,1,CURRENT_DATE()+INTERVAL 1 DAY,'13:00','Paciente sintético','ci-sintetico','PENDIENTE',1),
(5,1,CURRENT_DATE()+INTERVAL 1 DAY,'11:00','Paciente sintético','ci-sintetico','ATENDIDO',1);
CREATE USER 'crm_agenda_lectura'@'%' IDENTIFIED BY 'solo-pruebas-sinteticas-no-produccion-2026' REQUIRE SSL WITH MAX_USER_CONNECTIONS 4;
GRANT SELECT (medico_pk,nombre,sigla,especialidad,estado,horario_html,precio_con,orden) ON clinica.medicos TO 'crm_agenda_lectura'@'%';
GRANT SELECT (medico_pk,dia,hora,estado) ON clinica.horarios TO 'crm_agenda_lectura'@'%';
GRANT SELECT ON clinica.vista_horas_libres TO 'crm_agenda_lectura'@'%';
GRANT SELECT (medico_pk,fecha,hora,estado) ON clinica.para_agendar TO 'crm_agenda_lectura'@'%';
GRANT SELECT (qr_pk,Qr,fecha_vence) ON clinica.pagos_qr TO 'crm_agenda_lectura'@'%';
-- Usuario de reservas: lo mínimo para el INSERT y el UPDATE de ScriptCase.
CREATE USER 'crm_agenda_reserva'@'%' IDENTIFIED BY 'solo-pruebas-sinteticas-reserva-no-produccion-2026' REQUIRE SSL WITH MAX_USER_CONNECTIONS 3;
GRANT SELECT (medico_pk,nombre,estado,precio_con,banco) ON clinica.medicos TO 'crm_agenda_reserva'@'%';
GRANT SELECT ON clinica.vista_horas_libres TO 'crm_agenda_reserva'@'%';
GRANT SELECT (para_age,medico_pk,fecha,hora,estado,nombre_age,ci_age) ON clinica.para_agendar TO 'crm_agenda_reserva'@'%';
GRANT INSERT (para_age,medico_pk,fecha,hora,nombre_age,telefono_age,ci_age,obs,estado,nom_med,uno,fecha_registro,hora_registro,nit,razon_social,precio_con,banco) ON clinica.para_agendar TO 'crm_agenda_reserva'@'%';
GRANT UPDATE (comprobante,nit,razon_social,estado) ON clinica.para_agendar TO 'crm_agenda_reserva'@'%';
