-- El código SMS (OTP) ahora se guarda como hash SHA-256 (64 caracteres) en vez de en claro.
-- Hay que ampliar la columna. Seguro de correr más de una vez.
ALTER TABLE usuarios ALTER COLUMN otp_codigo TYPE VARCHAR(64);
-- Los códigos pendientes (de 5 minutos) quedan inválidos: el usuario pide uno nuevo.
UPDATE usuarios SET otp_codigo = NULL, otp_expira_en = NULL WHERE otp_codigo IS NOT NULL;
