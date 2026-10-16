-- Tipos de vehículo y servicios: Taxi (taxi, carro, bajaj) y Moto (moto lineal).
-- Solo AGREGA columnas y ajustes: los conductores y viajes existentes quedan como «taxi».
-- Seguro de correr más de una vez.

-- ── Tipo de vehículo del conductor ────────────────────────────────────────
ALTER TABLE conductores ADD COLUMN IF NOT EXISTS tipo_vehiculo VARCHAR(20) NOT NULL DEFAULT 'taxi';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conductores_tipo_vehiculo_chk') THEN
    ALTER TABLE conductores ADD CONSTRAINT conductores_tipo_vehiculo_chk
      CHECK (tipo_vehiculo IN ('taxi', 'carro', 'bajaj', 'moto_lineal'));
  END IF;
END $$;

-- ── Servicio que pidió el pasajero en cada viaje (taxi o moto) ────────────
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS servicio VARCHAR(10) NOT NULL DEFAULT 'taxi';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'viajes_servicio_chk') THEN
    ALTER TABLE viajes ADD CONSTRAINT viajes_servicio_chk CHECK (servicio IN ('taxi', 'moto'));
  END IF;
END $$;

-- Para buscar rápido los conductores libres de cada tipo
CREATE INDEX IF NOT EXISTS idx_conductores_tipo_disponible
  ON conductores (tipo_vehiculo) WHERE disponible = TRUE;

-- ── Tarifa de la moto (el taxi sigue con tarifa_base, tarifa_km, ...) ─────
INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('moto_tarifa_base',          '2.00',  'Moto: monto fijo de arranque del viaje (S/)'),
  ('moto_tarifa_km',            '0.50',  'Moto: precio por kilómetro sin combustible (S/)'),
  ('moto_tarifa_minuto',        '0.10',  'Moto: precio por minuto de viaje (S/)'),
  ('moto_tarifa_minima',        '3.00',  'Moto: tarifa mínima de un viaje (S/)'),
  ('moto_rendimiento_km_galon', '100',   'Moto: kilómetros que recorre con un galón en ciudad')
ON CONFLICT (clave) DO NOTHING;
