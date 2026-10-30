import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer();
await server.listen();
const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, GITNEST_DEV_URL: 'http://127.0.0.1:5178' },
});
const close = async () => { child.kill(); await server.close(); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
child.on('exit', async (code) => { await server.close(); process.exit(code ?? 0); });
