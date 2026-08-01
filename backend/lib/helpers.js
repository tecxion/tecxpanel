// ============================================================
//  TecXPaneL — helpers.js (redirect v1 → v2)
//
//  Desde TecXPaneL 2.0, los helpers viven en lib/common/.
//  Este archivo es un proxy de compatibilidad; los nuevos imports
//  pueden usar require('../lib/common/<sub>.js') directamente.
//
//  SE ELIMINARÁ cuando se migren todas las referencias a
//  require('../lib/common') en una release futura.
// ============================================================
module.exports = require('./common');