/**
 * Auth Middleware — JWT validation for dashboard routes
 */
const jwt = require('jsonwebtoken');
const { audit } = require('../utils/db');
const logger = require('../utils/logger');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      audit(req.user?.email || 'unknown', 'unauthorized_access', null, null, {
        requiredRoles: roles,
        actualRole: req.user?.role,
        path: req.path,
      }, req.ip);
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
