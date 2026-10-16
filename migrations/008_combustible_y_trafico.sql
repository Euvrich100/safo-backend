-- Tarifa con combustible, velocidad urbana máxima y tráfico estimado.
-- Solo AGREGA ajustes: no borra ni cambia datos existentes (salvo el precio por km si seguía
-- con el valor original de fábrica, que se baja porque ahora el combustible se suma aparte).
-- Seguro de correr más de una vez.

INSERT INTO configuracion (clave, valor, descripcion) VALUES
  ('velocidad_max_kmh',        '40',    'Velocidad máxima urbana del taxi (km/h): ningún tramo se calcula más rápido'),
  ('combustible_precio_galon', '16.50', 'Precio del galón de combustible (S/). El costo por km se calcula solo'),
  ('rendimiento_km_galon',     '34',    'Kilómetros que recorre el taxi con un galón en ciudad'),
  ('trafico_libre',            '1.00',  'Factor de demora con tráfico fluido (1 = sin demora)'),
  ('trafico_medio',            '1.20',  'Factor de demora con tráfico moderado'),
  ('trafico_pico',             '1.45',  'Factor de demora en hora pico'),
  ('condicion_factor',         '1.00',  'Factor por condición del día (lluvia, feria, obras). 1 = normal'),
  ('condicion_texto',          '',      'Texto que ve el pasajero cuando hay una condición especial')
ON CONFLICT (clave) DO NOTHING;

-- El combustible ahora se suma por separado (≈ S/ 0.49 por km): si el precio por km seguía
-- en el valor original (1.20), se baja a 0.80 para que las tarifas no suban de golpe.
UPDATE configuracion SET valor = '0.80', actualizado_en = NOW()
WHERE clave = 'tarifa_km' AND valor IN ('1.20', '1.2');
