/**
 * PostOp SMS Protocol — Main Server
 * 
 * Production-ready Express server for post-discharge surgical patient screening.
 * 
 * Architecture:
 *   /api/sms/inbound   — Twilio webhook (patient messages)
 *   /api/sms/status    — Twilio delivery callbacks
 *   /api/patients      — Enrollment CRUD
 *   /api/auth/*        — Dashboard authentication
 *   /api/dashboard/*   — Alerts, analytics, triage
 *   Scheduler          — Hourly cron triggering check-ins
 */
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const smsRoutes = require('./routes/sms');
const patientRoutes = require('./routes/patients');
const dashboardRoutes = require('./routes/dashboard');
const { startScheduler } = require('./services/scheduler');
const logger = require('./utils/logger');
const { pool } = require('./utils/db');

const app = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
}));
app.use(compression());

// NOTE: /api/sms routes need urlencoded parsing (Twilio sends form data)
// Other routes use JSON — applied per-route or globally here
app.use(express.json());

// Request logging (no PHI in logs)
app.use(morgan(':method :url :status :response-time ms', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Twilio webhooks get higher limits (patients texting back quickly)
const smsLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  standardHeaders: true,
});

// ═══════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════

app.use('/api/sms', smsLimiter, smsRoutes);
app.use('/api/patients', apiLimiter, patientRoutes);
app.use('/api', apiLimiter, dashboardRoutes);

// Dashboard (static HTML)
const path = require('path');
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), demo: process.env.DEMO_MODE === 'true' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════

async function start() {
  // Verify database connection
  try {
    await pool.query('SELECT 1');
    logger.info('Database connected');
  } catch (err) {
    logger.error('Database connection failed', { error: err.message });
    if (process.env.DEMO_MODE !== 'true') {
      process.exit(1);
    }
    logger.warn('Running in DEMO_MODE without database');
  }

  // Start scheduler
  startScheduler();

  // Start server
  app.listen(PORT, () => {
    logger.info(`PostOp SMS server running on port ${PORT}`, {
      env: process.env.NODE_ENV,
      demo: process.env.DEMO_MODE === 'true',
      facility: process.env.FACILITY_NAME,
    });
  });
}

start();

module.exports = app;
