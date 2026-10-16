#!/usr/bin/env node
import { readVersion } from './version.js';

const [command] = process.argv.slice(2);

if (command === 'daemon') {
  const { startDaemon } = await import('../daemon/main.js');
  const handle = await startDaemon({ logger: true }).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
  const stop = () => void handle.stop().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  console.log(`aidboard ${readVersion()}`);
}
