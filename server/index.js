const express = require('express');
const path = require('path');

// Initialize database (creates tables on first run)
require('./db');

const authRoutes = require('./routes/auth');
const requestRoutes = require('./routes/requests');
const paymentRoutes = require('./routes/payments');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/users');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);

// Fallback: serve index.html for any non-API route
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PocketTab server running on http://localhost:${PORT}`);
});
