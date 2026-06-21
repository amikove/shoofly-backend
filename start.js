
const { execSync } = require('child_process')
try {
  execSync('node src/db/seed.js', { stdio: 'inherit' })
} catch (e) {
  console.log('Seed ignoré:', e.message)
}
require('./src/index.js')