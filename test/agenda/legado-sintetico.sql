-- Exclusivamente MySQL descartable. Ningún dato ni credencial de producción.
CREATE DATABASE clinica CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE clinica;
SET NAMES utf8mb4;
CREATE TABLE medicos (medico_pk INT PRIMARY KEY, codigo VARCHAR(50), nombre VARCHAR(200), sigla VARCHAR(5), especialidad VARCHAR(200), estado VARCHAR(10), horario_html TEXT, precio_con DECIMAL(10,2), orden INT, login VARCHAR(50), password VARCHAR(50), telefono VARCHAR(50));
CREATE TABLE horarios (id_hora INT AUTO_INCREMENT PRIMARY KEY, medico_pk INT, cod_med VARCHAR(20), dia VARCHAR(20), hora TIME, estado VARCHAR(10));
CREATE TABLE agenda_med (agendam_pk INT AUTO_INCREMENT PRIMARY KEY, cod_med VARCHAR(20), fecha DATE, hora TIME, estado VARCHAR(10), paciente VARCHAR(200));
CREATE TABLE para_agendar (para_age INT PRIMARY KEY, medico_pk INT, fecha DATE, hora TIME, estado VARCHAR(10), ci_age VARCHAR(100), comprobante MEDIUMBLOB);
-- La misma regla auditada: todos los estados de agenda_med ocupan, para_agendar
-- no participa. Las fechas son relativas para que la prueba no caduque.
CREATE VIEW vista_horas_libres AS
WITH RECURSIVE fechas AS (SELECT CURRENT_DATE() AS fecha, 0 AS n UNION ALL SELECT fecha + INTERVAL 1 DAY, n + 1 FROM fechas WHERE n < 29)
SELECT f.fecha, h.cod_med, h.hora AS hora_disponible, h.dia, h.estado, h.medico_pk
FROM fechas f JOIN horarios h ON h.dia = ELT(DAYOFWEEK(f.fecha), 'Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado')
LEFT JOIN agenda_med a ON a.cod_med = h.cod_med AND a.fecha = f.fecha AND a.hora = h.hora
WHERE a.agendam_pk IS NULL GROUP BY f.fecha, h.cod_med, h.hora, h.dia, h.estado, h.medico_pk;
INSERT INTO medicos VALUES
(1,'A','Profesional sintético A','Dra.','Especialidad sintética','ACTIVO','<b>Semanal</b>',400.25,1,'privado','secreto-sintetico','telefono-privado'),
(2,'B','Profesional sintético B','Dr.','Especialidad sintética','ACTIVO','<b>Semanal</b>',NULL,2,'privado','secreto-sintetico','telefono-privado'),
(3,'C','Profesional a solicitud','Dr.','Otra especialidad','ACTIVO',NULL,0,3,'privado','secreto-sintetico','telefono-privado'),
(4,'D','Profesional inactivo','Dr.','Oculta','INACTIVO','<b>Semanal</b>',500,4,'privado','secreto-sintetico','telefono-privado');
SET @dia=ELT(DAYOFWEEK(CURRENT_DATE()+INTERVAL 1 DAY),'Domingo','Lunes','Martes','Miercoles','Jueves','Viernes','Sabado');
INSERT INTO horarios (medico_pk,cod_med,dia,hora,estado) VALUES (1,'A',@dia,'09:00','ACTIVO'),(1,'A',@dia,'10:00','ACTIVO'),(1,'A',@dia,'11:00','ACTIVO'),(1,'A',@dia,'12:00','INACTIVO'),(2,'B',@dia,'09:00','ACTIVO');
INSERT INTO agenda_med (cod_med,fecha,hora,estado,paciente) VALUES ('A',CURRENT_DATE()+INTERVAL 1 DAY,'09:00','CREADO','Paciente sintético'),('A',CURRENT_DATE()+INTERVAL 1 DAY,'10:00','BORRADO','Paciente sintético'),('B',CURRENT_DATE()+INTERVAL 1 DAY,'09:00','CREADO','Paciente sintético');
INSERT INTO para_agendar VALUES (1,1,CURRENT_DATE()+INTERVAL 1 DAY,'11:00','PENDIENTE','ci-sintetico',NULL);
CREATE USER 'crm_agenda_lectura'@'%' IDENTIFIED BY 'solo-pruebas-sinteticas-no-produccion-2026' REQUIRE SSL WITH MAX_USER_CONNECTIONS 4;
GRANT SELECT (medico_pk,nombre,sigla,especialidad,estado,horario_html,precio_con,orden) ON clinica.medicos TO 'crm_agenda_lectura'@'%';
GRANT SELECT (medico_pk,dia,hora,estado) ON clinica.horarios TO 'crm_agenda_lectura'@'%';
GRANT SELECT ON clinica.vista_horas_libres TO 'crm_agenda_lectura'@'%';
