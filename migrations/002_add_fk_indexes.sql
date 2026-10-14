-- Índices sobre llaves foráneas que se usan en WHERE/JOIN.
-- Postgres NO indexa automáticamente una FK — solo PRIMARY KEY y UNIQUE.
-- (conductores.usuario_id y pasajeros.usuario_id ya tienen UNIQUE(usuario_id),
-- así que ya están cubiertos y no se repiten aquí.)

CREATE INDEX IF NOT EXISTS idx_suscripciones_conductor_id ON suscripciones(conductor_id);
CREATE INDEX IF NOT EXISTS idx_viajes_conductor_id         ON viajes(conductor_id);
CREATE INDEX IF NOT EXISTS idx_viajes_pasajero_id          ON viajes(pasajero_id);
CREATE INDEX IF NOT EXISTS idx_pagos_viaje_viaje_id        ON pagos_viaje(viaje_id);
