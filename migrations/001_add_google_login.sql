-- Agrega soporte de login con Google a usuarios existentes.
-- Es seguro correr esto más de una vez (usa IF NOT EXISTS).

ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email     VARCHAR(255) UNIQUE;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;

-- Para habilitar a un administrador existente a entrar con Google,
-- asigna su correo (debe coincidir exactamente con el de su cuenta de Google):
--
--   UPDATE usuarios SET email = 'admin@ejemplo.com' WHERE celular = '999000001' AND rol = 'admin';
