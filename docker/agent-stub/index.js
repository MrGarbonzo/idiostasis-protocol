const express = require('express');

const app = express();
const PORT = 3001;

app.use(express.json());

app.use((req, _res, next) => {
  console.log(`[agent-stub] ${req.method} ${req.path}`);
  next();
});

app.get('/status', (_req, res) => {
  res.json({ role: 'primary', healthy: true, uptime: process.uptime() });
});

app.get('/ping', (_req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

app.post('/api/admission', (_req, res) => {
  res.json({ accepted: true, reason: 'dev-mode' });
});

app.listen(PORT, () => {
  console.log(`[agent-stub] listening on port ${PORT}`);
});
