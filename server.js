require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const pondsRoutes = require('./routes/ponds');
const devicesRoutes = require('./routes/devices');
const ingestRoutes = require('./routes/ingest');
const notificationsRoutes = require('./routes/notifications');
const reportsRoutes = require('./routes/reports');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
// ingestRoutes must be mounted before any router below, since those
// routers apply `router.use(requireAuth)` for ALL /api/* traffic that
// reaches them (including paths they don't define, like /ingest/*) —
// Express stops at the first router that sends a response, so ingest
// requests need to hit their own (unauthenticated, device-key-based)
// routes before reaching another router's blanket auth check.
app.use('/api', ingestRoutes);
// Super Admin routes: mounted on their own /api/admin prefix and BEFORE the
// farm-scoped routers below, which require a farm a Super Admin doesn't have.
app.use('/api/admin', adminRoutes);
app.use('/api', profileRoutes);
app.use('/api', pondsRoutes);
app.use('/api', devicesRoutes);
app.use('/api', notificationsRoutes);
app.use('/api', reportsRoutes);

// Express 5 forwards thrown/rejected errors from async handlers here
// automatically — no extra try/catch or middleware package needed.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`HyQual API listening on port ${PORT}`));
