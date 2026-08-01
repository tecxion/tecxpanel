'use strict';

// queries/apps.js — aplicaciones (PM2) gestionadas.
const { db } = require('../client');

module.exports = {
  listApps:              db.prepare('SELECT * FROM apps ORDER BY created_at DESC'),
  getApp:                db.prepare('SELECT * FROM apps WHERE id = ?'),
  getAppByName:          db.prepare('SELECT * FROM apps WHERE name = ?'),
  getAppByWebhookSecret: db.prepare('SELECT * FROM apps WHERE webhook_secret = ?'),
  insertApp:             db.prepare('INSERT INTO apps (name, type, path, start_cmd, port, domain, pm2_name, status, git_repo, git_branch, webhook_secret) VALUES (@name, @type, @path, @start_cmd, @port, @domain, @pm2_name, @status, @git_repo, @git_branch, @webhook_secret)'),
  setAppStatus:          db.prepare('UPDATE apps SET status = ? WHERE id = ?'),
  setAppConfig:          db.prepare('UPDATE apps SET type = ?, start_cmd = ? WHERE id = ?'),
  setAppDeployConfig:    db.prepare('UPDATE apps SET type = ?, start_cmd = ?, port = ?, domain = ? WHERE id = ?'),
  setAppGitConfig:       db.prepare('UPDATE apps SET git_repo = ?, git_branch = ? WHERE id = ?'),
  deleteApp:             db.prepare('DELETE FROM apps WHERE id = ?'),
};
