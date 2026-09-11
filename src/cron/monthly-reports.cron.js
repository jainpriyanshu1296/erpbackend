const cron = require('node-cron');
module.exports = () => cron.schedule('0 0 1 * *', () => {});
