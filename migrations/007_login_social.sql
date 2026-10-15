-- Login social (Apple y Facebook además de Google). Seguro de repetir.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS apple_id    VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(255);
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_apple_id    ON usuarios (apple_id)    WHERE apple_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_facebook_id ON usuarios (facebook_id) WHERE facebook_id IS NOT NULL;
