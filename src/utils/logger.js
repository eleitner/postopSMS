const winston = require('winston');

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'postop-sms' },
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'production'
        ? winston.format.json()
        : winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
    // Audit file — never log PHI here, only event metadata
    new winston.transports.File({
      filename: process.env.AUDIT_LOG_PATH || './logs/audit.log',
      level: 'info',
    }),
  ],
});

module.exports = logger;
