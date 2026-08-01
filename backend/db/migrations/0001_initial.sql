-- 0001-initial: marcador. No hace nada; la tabla _migrations y todos los
-- schema/*.sql ya crean el estado "fresh" correcto. Sirve para que una BD
-- existente v1 entre al sistema de migrations en su primer arranque v2.
-- El runner (db/index.js) detecta _migrations vacía + tablas preexistentes
-- y marca TODAS las migrations 0001+ como "ya aplicadas" sin ejecutarlas.
SELECT 1;
