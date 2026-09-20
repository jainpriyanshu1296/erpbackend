const { Sequelize } = require('sequelize');
require('dotenv').config();

const masterDb = new Sequelize(process.env.MASTER_DB_NAME || 'masterERP', process.env.MASTER_DB_USER || 'root', process.env.MASTER_DB_PASS || '', {
  host: process.env.MASTER_DB_HOST || 'localhost',
  port: Number(process.env.MASTER_DB_PORT || 3306),
  dialect: 'mysql',
  logging: false,
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 }
});
module.exports = masterDb;
