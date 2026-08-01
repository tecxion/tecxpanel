'use strict';

// queries/catalog.js — instalaciones del catálogo one-click.
const { db } = require('../client');

module.exports = {
  getCatalogInstall:    db.prepare('SELECT * FROM catalog_installs WHERE app_id = ?'),
  listCatalogInstalls:  db.prepare('SELECT * FROM catalog_installs ORDER BY created_at DESC'),
  insertCatalogInstall: db.prepare('INSERT INTO catalog_installs (app_id, mode, domain, port, ref, db_name) VALUES (@app_id, @mode, @domain, @port, @ref, @db_name)'),
  deleteCatalogInstall: db.prepare('DELETE FROM catalog_installs WHERE app_id = ?'),
};
