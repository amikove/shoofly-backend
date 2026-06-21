const seed = require('./src/db/seed.js')
const { execSync } = require('child_process')

seed().then(() => {
  require('./src/index.js')
}).catch((err) => {
  console.error('Seed error:', err.message)
  require('./src/index.js')
})