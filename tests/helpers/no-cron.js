// Préchargé par les tests HTTP (node -r) : aucun cron ne tourne pendant les tests, donc pas
// d'envoi de notifications ni d'auto-validation sur la base locale. Les crons restent intacts en prod.
const cron = require('node-cron');
cron.schedule = () => ({ start() {}, stop() {} });
