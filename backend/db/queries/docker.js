'use strict';

// queries/docker.js — despliegues Docker desde Git (para re-desplegar sin
// volver a pedir datos al usuario). git_token_enc cifrado AES-256-GCM.
const { db } = require('../client');

module.exports = {
  getDockerDeploy:     db.prepare('SELECT * FROM docker_deploys WHERE container_name = ?'),
  listDockerDeploys:   db.prepare('SELECT * FROM docker_deploys'),
  deleteDockerDeploy:  db.prepare('DELETE FROM docker_deploys WHERE container_name = ?'),
  saveDockerDeploy:    db.prepare(`
    INSERT INTO docker_deploys (container_name, raw_repo_url, git_branch, git_token_enc, template, container_port, host_port, domain, ssl, volume_name, volume_path, envs, sub_dir, dockerfile_path, updated_at)
    VALUES (@container_name, @raw_repo_url, @git_branch, @git_token_enc, @template, @container_port, @host_port, @domain, @ssl, @volume_name, @volume_path, @envs, @sub_dir, @dockerfile_path, datetime('now'))
    ON CONFLICT(container_name) DO UPDATE SET
      raw_repo_url=@raw_repo_url, git_branch=@git_branch, git_token_enc=@git_token_enc,
      template=@template, container_port=@container_port, host_port=@host_port,
      domain=@domain, ssl=@ssl, volume_name=@volume_name, volume_path=@volume_path,
      envs=@envs, sub_dir=@sub_dir, dockerfile_path=@dockerfile_path, updated_at=datetime('now')`),
  createDockerJob:     db.prepare(`
    INSERT INTO docker_jobs (id, kind, container_name, status, user_name, image_tag)
    VALUES (@id, @kind, @container_name, 'running', @user_name, @image_tag)`),
  getDockerJob:        db.prepare('SELECT * FROM docker_jobs WHERE id = ?'),
  listDockerJobs:      db.prepare('SELECT * FROM docker_jobs ORDER BY created_at DESC LIMIT 50'),
  updateDockerJob:     db.prepare(`
    UPDATE docker_jobs SET
      status=COALESCE(@status, status), image_tag=COALESCE(@image_tag, image_tag),
      container_id=COALESCE(@container_id, container_id), error_text=COALESCE(@error_text, error_text),
      finished_at=COALESCE(@finished_at, finished_at), cancel_requested=COALESCE(@cancel_requested, cancel_requested)
    WHERE id=@id`),
  appendDockerJobLog:  db.prepare(`
    UPDATE docker_jobs SET log_text=substr(log_text || @chunk, -65536) WHERE id=@id`),
  requestDockerJobCancel: db.prepare(`
    UPDATE docker_jobs SET cancel_requested=1, status='cancelling' WHERE id=@id AND status='running'`),
  markInterruptedDockerJobs: db.prepare(`
    UPDATE docker_jobs SET status='failed', error_text='Proceso interrumpido al reiniciar el panel', finished_at=datetime('now')
    WHERE status IN ('running', 'cancelling')`),
};
