CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE usuarios (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nombre        VARCHAR(100) NOT NULL,
    celular       VARCHAR(15)  NOT NULL UNIQUE,
    rol           VARCHAR(20)  NOT NULL CHECK (rol IN ('conductor', 'pasajero', 'admin')),
    estado        VARCHAR(20)  NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo', 'suspendido', 'inactivo')),
    otp_codigo    VARCHAR(6),
    otp_expira_en TIMESTAMP,
    creado_en     TIMESTAMP    NOT NULL DEFAULT NOW(),
    actualizado_en TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE TABLE conductores (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id          UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    dni                 VARCHAR(20)  NOT NULL DEFAULT '',
    licencia_numero     VARCHAR(30)  NOT NULL DEFAULT '',
    licencia_foto_url   TEXT,
    placa               VARCHAR(15)  NOT NULL DEFAULT '',
    vehiculo_marca      VARCHAR(50),
    vehiculo_modelo     VARCHAR(50),
    vehiculo_color      VARCHAR(30),
    vehiculo_anno       SMALLINT,
    vehiculo_foto_url   TEXT,
    antecedentes_url    TEXT,
    estado_doc          VARCHAR(20)  NOT NULL DEFAULT 'pendiente' CHECK (estado_doc IN ('pendiente', 'aprobado', 'rechazado')),
    rechazo_motivo      TEXT,
    disponible          BOOLEAN      NOT NULL DEFAULT FALSE,
    lat_actual          DECIMAL(10,7),
    lng_actual          DECIMAL(10,7),
    calificacion_prom   DECIMAL(2,1) NOT NULL DEFAULT 0.0,
    total_viajes        INTEGER      NOT NULL DEFAULT 0,
    suscripcion_vence   DATE,
    creado_en           TIMESTAMP    NOT NULL DEFAULT NOW(),
    actualizado_en      TIMESTAMP    NOT NULL DEFAULT NOW(),
    UNIQUE(usuario_id)
);

CREATE TABLE pasajeros (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    usuario_id          UUID    NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    cancelaciones_mes   SMALLINT NOT NULL DEFAULT 0,
    mes_cancelaciones   DATE    NOT NULL DEFAULT DATE_TRUNC('month', NOW()),
    creado_en           TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(usuario_id)
);

CREATE TABLE suscripciones (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conductor_id    UUID         NOT NULL REFERENCES conductores(id) ON DELETE CASCADE,
    monto           DECIMAL(6,2) NOT NULL DEFAULT 5.00,
    estado          VARCHAR(20)  NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagado', 'vencido')),
    metodo_pago     VARCHAR(20)  CHECK (metodo_pago IN ('yape', 'plin', 'efectivo', 'transferencia')),
    comprobante_url TEXT,
    periodo_mes     DATE         NOT NULL,
    pagado_en       TIMESTAMP,
    confirmado_por  UUID REFERENCES usuarios(id),
    creado_en       TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE TABLE viajes (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conductor_id            UUID         REFERENCES conductores(id),
    pasajero_id             UUID         NOT NULL REFERENCES pasajeros(id),
    estado                  VARCHAR(30)  NOT NULL DEFAULT 'solicitado' CHECK (estado IN ('solicitado','aceptado','en_camino','recogido','completado','cancelado_pasajero','cancelado_conductor','no_show')),
    lat_origen              DECIMAL(10,7) NOT NULL,
    lng_origen              DECIMAL(10,7) NOT NULL,
    direccion_origen        TEXT,
    lat_destino             DECIMAL(10,7),
    lng_destino             DECIMAL(10,7),
    direccion_destino       TEXT,
    lat_conductor_acepto    DECIMAL(10,7),
    lng_conductor_acepto    DECIMAL(10,7),
    cancelado_en            TIMESTAMP,
    cancelacion_motivo      TEXT,
    conductor_fue_despachado BOOLEAN NOT NULL DEFAULT FALSE,
    solicitado_en           TIMESTAMP NOT NULL DEFAULT NOW(),
    aceptado_en             TIMESTAMP,
    recogido_en             TIMESTAMP,
    completado_en           TIMESTAMP,
    actualizado_en          TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE pagos_viaje (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    viaje_id         UUID         NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
    monto_total      DECIMAL(6,2) NOT NULL DEFAULT 1.50,
    metodo_pago      VARCHAR(20)  NOT NULL CHECK (metodo_pago IN ('yape','plin','saldo_app')),
    tipo             VARCHAR(30)  NOT NULL DEFAULT 'garantia' CHECK (tipo IN ('garantia','compensacion')),
    estado           VARCHAR(30)  NOT NULL DEFAULT 'retenido' CHECK (estado IN ('retenido','liberado_plataforma','devuelto','compensado_conductor')),
    monto_conductor  DECIMAL(6,2) DEFAULT 0.00,
    monto_plataforma DECIMAL(6,2) DEFAULT 0.00,
    referencia_pago  VARCHAR(100),
    creado_en        TIMESTAMP NOT NULL