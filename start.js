// Le seed ne se lance plus automatiquement au démarrage — il TRUNCATE toutes les tables
// et ne doit être exécuté qu'à la main, volontairement : node src/db/seed.js
require('./src/index.js')