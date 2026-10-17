-- Credenciales completas del conductor para un transporte seguro:
-- licencia con vencimiento, SOAT/CAT, revisión técnica, tarjeta de propiedad,
-- antecedentes, selfie con DNI, contacto de emergencia y consentimiento.
-- Solo AGREGA columnas: los conductores existentes no se tocan. Seguro de correr más de una vez.

ALTER TABLE conductores
  -- Licencia
  ADD COLUMN IF NOT EXISTS licencia_vence               DATE,
  ADD COLUMN IF NOT EXISTS licencia_foto_trasera_url    TEXT,
  -- Identidad
  ADD COLUMN IF NOT EXISTS selfie_dni_url               TEXT,
  -- Vehículo
  ADD COLUMN IF NOT EXISTS vehiculo_serie               VARCHAR(30),
  ADD COLUMN IF NOT EXISTS vehiculo_foto_trasera_url    TEXT,
  ADD COLUMN IF NOT EXISTS vehiculo_foto_interior_url   TEXT,
  -- Propiedad
  ADD COLUMN IF NOT EXISTS es_propietario               BOOLEAN,
  ADD COLUMN IF NOT EXISTS propietario_nombre           VARCHAR(120),
  ADD COLUMN IF NOT EXISTS tarjeta_propiedad_url        TEXT,
  ADD COLUMN IF NOT EXISTS autorizacion_propietario_url TEXT,
  -- Seguro obligatorio: SOAT o CAT (AFOCAT)
  ADD COLUMN IF NOT EXISTS soat_tipo                    VARCHAR(5),
  ADD COLUMN IF NOT EXISTS soat_numero                  VARCHAR(40),
  ADD COLUMN IF NOT EXISTS soat_aseguradora             VARCHAR(60),
  ADD COLUMN IF NOT EXISTS soat_vence                   DATE,
  ADD COLUMN IF NOT EXISTS soat_foto_url                TEXT,
  -- Revisión técnica
  ADD COLUMN IF NOT EXISTS revision_tecnica_vence       DATE,
  ADD COLUMN IF NOT EXISTS revision_tecnica_foto_url    TEXT,
  -- Antecedentes (antecedentes_url ya existía)
  ADD COLUMN IF NOT EXISTS antecedentes_fecha           DATE,
  -- Permiso municipal (opcional, según la municipalidad)
  ADD COLUMN IF NOT EXISTS permiso_municipal_numero     VARCHAR(40),
  ADD COLUMN IF NOT EXISTS permiso_municipal_vence      DATE,
  ADD COLUMN IF NOT EXISTS permiso_municipal_url        TEXT,
  -- Contacto de emergencia
  ADD COLUMN IF NOT EXISTS emergencia_nombre            VARCHAR(100),
  ADD COLUMN IF NOT EXISTS emergencia_celular           VARCHAR(15),
  ADD COLUMN IF NOT EXISTS emergencia_parentesco        VARCHAR(30),
  -- Consentimiento de términos y datos personales
  ADD COLUMN IF NOT EXISTS acepta_terminos_en           TIMESTAMP,
  -- Revisión del administrador por rubro y renovaciones en espera de aprobación
  ADD COLUMN IF NOT EXISTS verificacion                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS renovaciones                 JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conductores_soat_tipo_chk') THEN
    ALTER TABLE conductores ADD CONSTRAINT conductores_soat_tipo_chk
      CHECK (soat_tipo IS NULL OR soat_tipo IN ('soat', 'cat'));
  END IF;
END $$;

-- Para barrer rápido los documentos por vencer
CREATE INDEX IF NOT EXISTS idx_conductores_soat_vence     ON conductores (soat_vence)             WHERE soat_vence IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conductores_licencia_vence ON conductores (licencia_vence)         WHERE licencia_vence IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conductores_revision_vence ON conductores (revision_tecnica_vence) WHERE revision_tecnica_vence IS NOT NULL;
