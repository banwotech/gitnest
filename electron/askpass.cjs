const { createConnection } = require('node:net');

const socket = createConnection(process.env.GITNEST_ASKPASS_SOCKET);
let input = '';
socket.setTimeout(5000, () => socket.destroy(new Error('认证请求超时')));
socket.on('connect', () => socket.write(JSON.stringify({ token: process.env.GITNEST_ASKPASS_TOKEN, prompt: process.argv[2] }) + '\n'));
socket.on('data', (chunk) => {
  input += chunk;
  if (input.length > 65536) socket.destroy(new Error('无效的认证响应'));
});
socket.on('end', () => {
  try {
    const { answer } = JSON.parse(input);
    if (typeof answer !== 'string' || /[\r\n\0]/.test(answer)) throw new Error('无效的认证响应');
    process.stdout.write(answer + '\n');
  } catch { process.exitCode = 1; }
});
socket.on('error', () => { process.exitCode = 1; });
