require('dotenv').config();
const app = require('./app');
const cron = require('./cron');
const port = Number(process.env.PORT || 5000);
app.listen(port, () => { console.log(`ERP API listening on port ${port}`); cron.start(); });
process.on('SIGTERM', async () => { const db = require('./config/db'); await db.close(); process.exit(0); });
