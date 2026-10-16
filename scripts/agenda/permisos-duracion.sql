-- Después de duracion-consulta.sql; cuentas reales restringidas al VPS del CRM.
GRANT SELECT (minutos_consulta) ON clinica.medicos TO 'crm_agenda_lectura'@'107.175.132.15';
GRANT SELECT (minutos_consulta) ON clinica.medicos TO 'crm_agenda_reserva'@'107.175.132.15';
GRANT SELECT (minutos_consulta) ON clinica.medicos TO 'crm_agenda_admin'@'107.175.132.15';
GRANT UPDATE (minutos_consulta) ON clinica.medicos TO 'crm_agenda_admin'@'107.175.132.15';
