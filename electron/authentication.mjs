import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./askpass.cjs', import.meta.url));
const authenticationError = /could not read (?:Username|Password)|authentication failed|invalid (?:username|password|credentials|token)|HTTP Basic: Access denied|returned error: 401/i;

export class AuthenticationCancelledError extends Error {
  constructor() { super('已取消认证'); }
}

export function validateCredentials(credentials) {
  if (!credentials || typeof credentials.username !== 'string' || !credentials.username.trim() || credentials.username.length > 256
    || typeof credentials.password !== 'string' || !credentials.password || credentials.password.length > 8192
    || /[\r\n\0]/.test(credentials.username + credentials.password)
    || (credentials.remember !== undefined && typeof credentials.remember !== 'boolean')) throw new Error('请填写有效的用户名和密码 / Token。');
}

function isAuthenticationError(error) {
  return authenticationError.test([error.stderr, error.stdout, error.message].filter(Boolean).join('\n'));
}

function redactError(error, credentials) {
  const secrets = [credentials.password, encodeURIComponent(credentials.password), Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')];
  for (const field of ['message', 'stderr', 'stdout']) {
    if (typeof error[field] === 'string') for (const secret of secrets) error[field] = error[field].split(secret).join('[已隐藏]');
  }
}

export async function withAskpass(origin, credentials, run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'gn-auth-'));
  const token = randomBytes(32).toString('hex');
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\gitnest-${token}` : path.join(directory, 'auth.sock');
  const server = createServer((socket) => {
    let input = '';
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 8192) return socket.destroy();
      if (!input.includes('\n')) return;
      try {
        const request = JSON.parse(input);
        const prompt = /^(Username|Password) for '(.+)':\s*$/.exec(request.prompt);
        if (request.token !== token || !prompt || new URL(prompt[2]).origin !== origin) return socket.destroy();
        socket.end(JSON.stringify({ answer: prompt[1] === 'Username' ? credentials.username : credentials.password }) + '\n');
      } catch { socket.destroy(); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const launcher = path.join(directory, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
    await writeFile(launcher, process.platform === 'win32'
      ? '@"%GITNEST_ASKPASS_NODE%" "%GITNEST_ASKPASS_SCRIPT%" %*\r\n'
      : '#!/bin/sh\nexec "$GITNEST_ASKPASS_NODE" "$GITNEST_ASKPASS_SCRIPT" "$@"\n', { mode: 0o700 });
    return await run({
      config: ['-c', 'credential.helper=', '-c', `credential.username=${credentials.username}`],
      env: {
        GIT_ASKPASS: launcher, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ELECTRON_RUN_AS_NODE: '1',
        GITNEST_ASKPASS_NODE: process.execPath, GITNEST_ASKPASS_SCRIPT: helper,
        GITNEST_ASKPASS_SOCKET: socketPath, GITNEST_ASKPASS_TOKEN: token,
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runWithAuthentication({ run, remoteURL, requestCredentials, saveCredentials, repository, action }) {
  let failure;
  try { return await run(); }
  catch (error) {
    if (!requestCredentials || !isAuthenticationError(error)) throw error;
    failure = error;
  }
  let url;
  try { url = new URL((await remoteURL()).trim()); }
  catch { throw failure; }
  if (!['https:', 'http:'].includes(url.protocol)) throw failure;
  const usernameLocked = Boolean(url.username);
  let username = decodeURIComponent(url.username);
  url.username = ''; url.password = '';
  let error = null;
  let remember = false;
  for (;;) {
    const credentials = await requestCredentials({ repository, action, url: url.href, username, usernameLocked, error, remember });
    if (!credentials) throw new AuthenticationCancelledError();
    validateCredentials(credentials);
    if (usernameLocked && credentials.username !== username) throw new Error('请使用远程地址中配置的用户名。');
    let result;
    try { result = await withAskpass(url.origin, credentials, run); }
    catch (failure) {
      const retry = isAuthenticationError(failure);
      redactError(failure, credentials);
      if (!retry) throw failure;
      username = credentials.username;
      remember = Boolean(credentials.remember);
      error = '认证失败，请检查账号和密码 / Token，并确认该账号有仓库访问权限。';
      continue;
    }
    if (credentials.remember) {
      try { await saveCredentials(url.href, credentials); }
      catch (failure) {
        redactError(failure, credentials);
        throw new Error(`${action === 'push' ? '推送' : '拉取'}已完成，但保存账号密码失败：${failure.message}`);
      }
    }
    return result;
  }
}
