'use strict';

// queries/websites.js — virtual hosts Nginx.
const { db } = require('../client');

module.exports = {
  listWebsites:       db.prepare('SELECT * FROM websites ORDER BY created_at DESC'),
  getWebsite:         db.prepare('SELECT * FROM websites WHERE id = ?'),
  getWebsiteByDomain: db.prepare('SELECT * FROM websites WHERE domain = ?'),
  insertWebsite:      db.prepare('INSERT INTO websites (domain, type, php, ssl, status, listen_port, php_version) VALUES (@domain, @type, @php, @ssl, @status, @listen_port, @php_version)'),
  getMaxListenPort:   db.prepare('SELECT MAX(listen_port) as maxPort FROM websites'),
  setWebsiteSsl:      db.prepare('UPDATE websites SET ssl = 1 WHERE id = ?'),
  deleteWebsite:      db.prepare('DELETE FROM websites WHERE id = ?'),
};
