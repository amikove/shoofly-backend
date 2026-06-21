const { execSync } = require('child_process')

try {
  console.log('🌱 Lancement du seed...')
  execSync('node src/db/seed.js', { stdio: 'inherit' })
} catch (e) {
  console.log('Seed déjà fait ou erreur ignorée:', e.message)
}

require('./src/index.js')