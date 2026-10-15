-- Plataforma completa: tarifas y comisiones configurables, zonas de servicio,
-- botón SOS, compartir viaje, reclamos y auditoría de acciones del admin.
-- Solo AGREGA tablas/columnas: no toca ni borra datos existentes.
-- Seguro de correr más de una vez.

-- ── Configuración (tarifas, garantía, comisiones) ─────────────────────────
CREATE TABLE IF NOT EXISTS configuracion (
  clave          VARCHAR(60) PRIMARY KEY,
  valor          TEXT NOT NULL,
  descripcion    TEXT,
  actualizado_en TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('tarifa_base',            '3.00', 'Monto fijo de arranque del viaje (S/)'),
  ('tarifa_km',              '1.20', 'Precio por kilómetro (S/)'),
  ('tarifa_minuto',          '0.15', 'Precio por minuto de viaje (S/)'),
  ('tarifa_minima',          '4.00', 'Tarifa mínima de un viaje (S/)'),
  ('garantia_viaje',         '1.50', 'Garantía que paga el pasajero al pedir un taxi (S/)'),
  ('compensacion_conductor', '1.00', 'Parte de la garantía para el conductor si el pasajero cancela con el taxi en camino (S/). El resto es para la plataforma'),
  ('radio_busqueda_km',      '5',    'Radio para buscar conductores cercanos (km)')
ON CONFLICT (clave) DO NOTHING;

-- ── Zonas de servicio ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS zonas_servicio (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre     VARCHAR(80) NOT NULL,
  lat        DECIMAL(10,7) NOT NULL,
  lng        DECIMAL(10,7) NOT NULL,
  radio_km   DECIMAL(6,2) NOT NULL CHECK (radio_km > 0),
  activa     BOOLEAN NOT NULL DEFAULT TRUE,
  creado_en  TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO zonas_servicio (nombre, lat, lng, radio_km)
SELECT 'Huánuco y alrededores', -9.9306, -76.2422, 15
WHERE NOT EXISTS (SELECT 1 FROM zonas_servicio);

-- ── Datos de tarifa y compartir viaje en cada viaje ───────────────────────
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS distancia_km     DECIMAL(7,2);
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS duracion_min     SMALLINT;
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS tarifa_estimada  DECIMAL(7,2);
ALTER TABLE viajes ADD COLUMN IF NOT EXISTS token_compartir  VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_viajes_token_compartir
  ON viajes (token_compartir) WHERE token_compartir IS NOT NULL;

-- ── Botón de emergencia (SOS) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sos_alertas (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id   UUID NOT NULL REFERENCES usuarios(id),
  viaje_id     UUID REFERENCES viajes(id) ON DELETE SET NULL,
  lat          DECIMAL(10,7),
  lng          DECIMAL(10,7),
  mensaje      TEXT,
  estado       VARCHAR(20) NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa', 'atendida')),
  creado_en    TIMESTAMP NOT NULL DEFAULT NOW(),
  atendida_en  TIMESTAMP,
  atendida_por UUID REFERENCES usuarios(id),
  nota_admin   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sos_estado ON sos_alertas (estado, creado_en DESC);

-- ── Reclamos ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reclamos (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id   UUID NOT NULL REFERENCES usuarios(id),
  viaje_id     UUID REFERENCES viajes(id) ON DELETE SET NULL,
  asunto       VARCHAR(120) NOT NULL,
  descripcion  TEXT NOT NULL,
  estado       VARCHAR(20) NOT NULL DEFAULT 'abierto'
               CHECK (estado IN ('abierto', 'en_revision', 'resuelto', 'rechazado')),
  respuesta    TEXT,
  creado_en    TIMESTAMP NOT NULL DEFAULT NOW(),
  resuelto_en  TIMESTAMP,
  resuelto_por UUID REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_reclamos_estado  ON reclamos (estado, creado_en DESC);
CREATE INDEX IF NOT EXISTS idx_reclamos_usuario ON reclamos (usuario_id);

-- ── Auditoría de acciones del administrador ───────────────────────────────
CREATE TABLE IF NOT EXISTS auditoria (
  id          BIGSERIAL PRIMARY KEY,
  usuario_id  UUID REFERENCES usuarios(id),
  accion      VARCHAR(80) NOT NULL,
  entidad     VARCHAR(40),
  entidad_id  VARCHAR(80),
  detalle     JSONB,
  ip          VARCHAR(64),
  creado_en   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria (creado_en DESC);
