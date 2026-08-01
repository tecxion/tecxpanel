// ============================================================
//  TecXPaneL — database.js (redirect v1 → v2)
//
//  Desde TecXPaneL 2.0, toda la lógica de BD vive en `db/`.
//  Este archivo se mantiene como proxy de compatibilidad para
//  los 27 archivos que hacen `require('../database')`.
//
//  SE ELIMINARÁ cuando se migren todas las referencias a
//  `require('../db')` en una release futura.
// ============================================================
module.exports = require('./db');