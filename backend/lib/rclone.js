'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de rclone (destinos remotos)
//
//  Sin estado ni dependencias del servidor: nombres de remoto,
//  construcción del entorno por tipo (S3/SFTP), y (Task 2) montaje
//  del remoto crypt y args de rclone. Los secretos viajan por env
//  vars del proceso hijo, nunca por argv ni por rclone.conf.
// ============================================================

// Nombres de remoto INTERNOS que rclone lee de las env vars
// RCLONE_CONFIG_<NOMBRE>_*. El operador NUNCA los ve.
const RCLONE_REMOTE = 'txpl';
const RCLONE_CRYPT = 'txplcrypt';

// Env para un remoto S3-compatible (Amazon, Backblaze B2, Wasabi, MinIO, DO Spaces…).
// PROVIDER='Other' + ENV_AUTH='false' evita que rclone intente resolver credenciales
// del entorno del sistema.
function buildS3Env({ endpoint, region, accessKey, secretKey } = {}) {
  return {
    RCLONE_CONFIG_TXPL_TYPE: 's3',
    RCLONE_CONFIG_TXPL_PROVIDER: 'Other',
    RCLONE_CONFIG_TXPL_ENV_AUTH: 'false',
    RCLONE_CONFIG_TXPL_ENDPOINT: endpoint,
    RCLONE_CONFIG_TXPL_REGION: region,
    RCLONE_CONFIG_TXPL_ACCESS_KEY_ID: accessKey,
    RCLONE_CONFIG_TXPL_SECRET_ACCESS_KEY: secretKey,
  };
}

// Env para un remoto SFTP. Prefiere `keyFile` (ruta a la clave privada) sobre
// `password`; si ambos vienen, la clave gana.
function buildSftpEnv({ host, port, user, password, keyFile } = {}) {
  const env = {
    RCLONE_CONFIG_TXPL_TYPE: 'sftp',
    RCLONE_CONFIG_TXPL_HOST: host,
    RCLONE_CONFIG_TXPL_PORT: String(port),
    RCLONE_CONFIG_TXPL_USER: user,
  };
  if (keyFile) env.RCLONE_CONFIG_TXPL_KEY_FILE = keyFile;
  else if (password) env.RCLONE_CONFIG_TXPL_PASS = password;
  return env;
}

// Ruta destino que se pasa a rclone. Con cifrado activo, el remoto crypt
// ya apunta al remote_path por debajo (ver buildCryptEnv en Task 2), así que
// aquí simplemente devolvemos su raíz.
function effectiveRemote(encryptEnabled, remotePath) {
  if (encryptEnabled) return `${RCLONE_CRYPT}:`;
  return `${RCLONE_REMOTE}:${remotePath || ''}`;
}

module.exports = {
  RCLONE_REMOTE, RCLONE_CRYPT,
  buildS3Env, buildSftpEnv, effectiveRemote,
};
