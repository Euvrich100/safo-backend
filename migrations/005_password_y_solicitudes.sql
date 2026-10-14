-- Contraseña para entrar sin depender de SMS (hasta que SafO envíe SMS reales)
-- y un índice para expirar rápido las solicitudes sin respuesta.
-- Seguro de correr más de una vez (usa IF NOT EXISTS).

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_hash        TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_cambiada_en TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_viajes_solicitados
  ON viajes (solicitado_en) WHERE estado = 'solicitado';
