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
};
