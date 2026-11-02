import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWithAuthentication, withAskpass, AuthenticationCancelledError } from '../electron/authentication.mjs';
import { performRepositoryAction, scanWorkspace } from '../electron/git.mjs';

const exec = promisify(execFile);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const credentials = { username: 'gitnest-test', password: 'test-token-$-with-quotes-\"' };

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gn-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = path.join(root, 'client');
  git(root, 'init', '-b', 'main', client);
  git(client, 'config', 'user.name', 'GitNest Test');
  git(client, 'config', 'user.email', 'test@gitnest.local');
  await writeFile(path.join(client, 'README.md'), 'initial\n');
  git(client, 'add', '.'); git(client, 'commit', '-m', 'initial');
  const remote = path.join(root, 'remote.git');
  git(root, 'clone', '--bare', client, remote);
  git(remote, 'config', 'http.receivepack', 'true');
  const credentialFile = path.join(root, 'credentials');
  await writeFile(credentialFile, '');
  git(client, 'config', '--add', 'credential.helper', '');
  git(client, 'config', '--add', 'credential.helper', `store --file=${credentialFile}`);
  const authorization = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== authorization) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitNest test"' });
      response.end('Authentication required');
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    const input = [];
    for await (const chunk of request) input.push(chunk);
    const child = spawn('git', ['http-backend'], { env: {
      ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: credentials.username,
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: String(Buffer.concat(input).length),
    }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => { response.writeHead(500); response.end(); });
    child.on('close', () => {
      const output = Buffer.concat(chunks);
      const separator = output.indexOf('\r\n\r\n');
      if (separator < 0) { response.writeHead(500); response.end(); return; }
      for (const line of output.subarray(0, separator).toString().split('\r\n')) {
        const index = line.indexOf(':');
        const name = line.slice(0, index);
        const value = line.slice(index + 1).trim();
        if (name.toLowerCase() === 'status') response.statusCode = Number(value.split(' ')[0]);
        else response.setHeader(name, value);
      }
      response.end(output.subarray(separator + 4));
    });
    child.stdin.end(Buffer.concat(input));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/remote.git`;
  git(client, 'remote', 'add', 'origin', url);
  const initialHead = git(client, 'rev-parse', 'HEAD');
  await writeFile(path.join(client, 'README.md'), 'changed\n');
  git(client, 'commit', '-am', 'changed');
  const repository = (await scanWorkspace(client)).projects.find((item) => item.path === client || item.path.endsWith('/client'));
  assert.ok(repository);
  return { repository, client, remote, url, credentialFile, initialHead };
}

test('a real HTTP push requests credentials and does not persist them', async (t) => {
  const { repository, client, remote, credentialFile } = await fixture(t);
  let prompts = 0;
  assert.equal(await performRepositoryAction(repository, 'push', { remote: 'origin' }, { requestCredentials: async (request) => {
    prompts++;
    assert.equal(request.action, 'push');
    assert.equal(request.error, null);
    return credentials;
  } }), '推送完成');
  assert.equal(prompts, 1);
  assert.equal(git(remote, 'rev-parse', 'main'), git(client, 'rev-parse', 'HEAD'));
  assert.equal(await readFile(credentialFile, 'utf8'), '');
});

test('canceling authentication leaves the remote unchanged', async (t) => {
  const { repository, remote, initialHead } = await fixture(t);
  await assert.rejects(performRepositoryAction(repository, 'push', { remote: 'origin' }, { requestCredentials: async () => null }), AuthenticationCancelledError);
  assert.equal(git(remote, 'rev-parse', 'main'), initialHead);
});

test('wrong credentials can be corrected without restarting the operation', async (t) => {
  const { repository, credentialFile } = await fixture(t);
  const prompts = [];
  await performRepositoryAction(repository, 'push', { remote: 'origin' }, { requestCredentials: async (request) => {
    prompts.push(request);
    return prompts.length === 1 ? { ...credentials, password: 'wrong-token' } : credentials;
  } });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].error, /认证失败/);
  assert.equal(prompts[1].username, credentials.username);
  assert.ok(!JSON.stringify(prompts).includes('wrong-token'));
  assert.equal(await readFile(credentialFile, 'utf8'), '');
});

test('existing stored credentials continue to work without showing a dialog', async (t) => {
  const { repository, url, credentialFile } = await fixture(t);
  const storedURL = new URL(url);
  storedURL.username = credentials.username; storedURL.password = credentials.password;
  await writeFile(credentialFile, storedURL.href + '\n');
  await performRepositoryAction(repository, 'push', { remote: 'origin' }, { requestCredentials: async () => assert.fail('unexpected authentication dialog') });
});

test('remembering credentials saves them after success and skips the next authentication dialog', async (t) => {
  const { repository, credentialFile } = await fixture(t);
  let prompts = 0;
  const options = { requestCredentials: async () => { prompts++; return { ...credentials, remember: true }; } };
  await performRepositoryAction(repository, 'push', { remote: 'origin' }, options);
  assert.notEqual(await readFile(credentialFile, 'utf8'), '');
  await performRepositoryAction(repository, 'push', { remote: 'origin' }, options);
  assert.equal(prompts, 1);
});

test('an incorrect remembered password is not saved, and canceling preserves an empty store', async (t) => {
  const { repository, credentialFile } = await fixture(t);
  let prompts = 0;
  await assert.rejects(performRepositoryAction(repository, 'push', { remote: 'origin' }, { requestCredentials: async (request) => {
    prompts++;
    if (prompts === 1) return { ...credentials, password: 'incorrect-password', remember: true };
    assert.equal(request.remember, true);
    assert.equal(await readFile(credentialFile, 'utf8'), '');
    return null;
  } }), AuthenticationCancelledError);
  assert.equal(prompts, 2);
  assert.equal(await readFile(credentialFile, 'utf8'), '');
});

test('network errors do not open an authentication dialog', async () => {
  const failure = new Error('Could not resolve host: example.com');
  await assert.rejects(runWithAuthentication({
    run: async () => { throw failure; },
    remoteURL: async () => assert.fail('unexpected remote lookup'),
    requestCredentials: async () => assert.fail('unexpected authentication dialog'),
  }), (error) => error === failure);
});

test('askpass rejects other hosts and tokens and removes its temporary files', async () => {
  let launcher;
  await withAskpass('https://example.com', credentials, async ({ env, config }) => {
    launcher = env.GIT_ASKPASS;
    assert.ok(!JSON.stringify({ env, config }).includes(credentials.password));
    const options = { env: { ...process.env, ...env }, timeout: 10000 };
    assert.equal((await exec(launcher, ["Password for 'https://gitnest-test@example.com': "], options)).stdout.trim(), credentials.password);
    await assert.rejects(exec(launcher, ["Password for 'https://other.example': "], options));
    await assert.rejects(exec(launcher, ["Password for 'https://example.com': "], { ...options, env: { ...options.env, GITNEST_ASKPASS_TOKEN: 'wrong' } }));
  });
  await assert.rejects(access(launcher));
});
