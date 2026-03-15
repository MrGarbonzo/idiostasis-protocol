import { MoltbookAgent } from './agent.js';

const agent = new MoltbookAgent();

async function main(): Promise<void> {
  await agent.initialize();
  await agent.start();
}

process.on('SIGTERM', async () => {
  await agent.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await agent.shutdown();
  process.exit(0);
});

main().catch((err) => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
