import { startGuardian } from './main.js';

startGuardian().catch((err) => {
  console.error('[guardian] fatal:', err);
  process.exit(1);
});
