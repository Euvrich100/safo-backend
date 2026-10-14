-- Documentos y datos adicionales del conductor (registro profesional).
-- Seguro de correr más de una vez.

ALTER TABLE conductores ADD COLUMN IF NOT EXISTS dni_foto_frontal_url TEXT;
ALTER TABLE conductores ADD COLUMN IF NOT EXISTS dni_foto_trasera_url TEXT;
ALTER TABLE conductores ADD COLUMN IF NOT EXISTS perfil_foto_url      TEXT;
ALTER TABLE conductores ADD COLUMN IF NOT EXISTS licencia_categoria   VARCHAR(10);
ALTER TABLE conductores ADD COLUMN IF NOT EXISTS fecha_nacimiento     DATE;
ALTER TABLE conductores ADD COLUMN IF NOT EXISTS direccion            TEXT;

-- Una sola suscripción por conductor y mes. Antes nada lo impedía, así que
-- aprobar dos veces a un conductor creaba suscripciones duplicadas
-- (el "ON CONFLICT DO NOTHING" del código no tenía restricción que lo activara).
DELETE FROM suscripciones a
USING suscripciones b
WHERE a.conductor_id = b.conductor_id
  AND a.periodo_mes  = b.periodo_mes
  AND (a.estado <> 'pagado' AND b.estado = 'pagado'
       OR (a.estado = b.estado AND a.ctid > b.ctid));

CREATE UNIQUE INDEX IF NOT EXISTS uq_suscripciones_conductor_mes
  ON suscripciones(conductor_id, periodo_mes);
