-- Auxilio mecánico: directorio de mecánicos de confianza para conductores con el vehículo malogrado.
-- Solo CREA una tabla nueva (vacía): no se inventa ningún mecánico, el administrador los registra
-- desde el panel cuando tenga los convenios reales. Seguro de correr más de una vez.

CREATE TABLE IF NOT EXISTS mecanicos (
  id            SERIAL PRIMARY KEY,
  nombre        VARCHAR(120) NOT NULL,
  especialidad  VARCHAR(30)  NOT NULL DEFAULT 'general'
                CHECK (especialidad IN ('general','electricidad','llantas','grua','motos','planchado','combustible','cerrajeria')),
  telefono      VARCHAR(20)  NOT NULL,
  whatsapp      VARCHAR(20),
  direccion     VARCHAR(200),
  distrito      VARCHAR(80),
  horario       VARCHAR(120),
  atiende_24h   BOOLEAN      NOT NULL DEFAULT FALSE,
  vehiculos     VARCHAR(10)  NOT NULL DEFAULT 'ambos' CHECK (vehiculos IN ('taxi','moto','ambos')),
  notas         VARCHAR(300),
  activo        BOOLEAN      NOT NULL DEFAULT TRUE,
  creado_en     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mecanicos_activo ON mecanicos (activo, especialidad);
