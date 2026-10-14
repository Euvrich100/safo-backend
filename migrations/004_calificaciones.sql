-- Calificaciones de viajes. db.sql dejó de incluir esta tabla, por lo que
-- POST /viajes/:id/calificar fallaba con "relation calificaciones does not exist".
-- Es seguro correrla aunque la tabla ya exista en tu base de datos.

CREATE TABLE IF NOT EXISTS calificaciones (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    viaje_id     UUID     NOT NULL REFERENCES viajes(id) ON DELETE CASCADE,
    conductor_id UUID     NOT NULL REFERENCES conductores(id),
    pasajero_id  UUID     NOT NULL REFERENCES pasajeros(id),
    estrellas    SMALLINT NOT NULL CHECK (estrellas BETWEEN 1 AND 5),
    comentario   TEXT,
    creado_en    TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(viaje_id)
);

CREATE INDEX IF NOT EXISTS idx_calificaciones_conductor_id ON calificaciones(conductor_id);

-- Promedio del conductor. total_viajes ya NO se incrementa aquí: un viaje
-- completado sin calificar también cuenta, así que se hace al completar.
CREATE OR REPLACE FUNCTION actualizar_calificacion_conductor()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE conductores
    SET calificacion_prom = (
        SELECT ROUND(AVG(estrellas)::numeric, 1)
        FROM calificaciones
        WHERE conductor_id = NEW.conductor_id
    )
    WHERE id = NEW.conductor_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_calificacion_conductor ON calificaciones;
CREATE TRIGGER trg_calificacion_conductor
AFTER INSERT ON calificaciones
FOR EACH ROW EXECUTE FUNCTION actualizar_calificacion_conductor();
