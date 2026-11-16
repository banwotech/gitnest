import { execFile } from 'node:child_process';

// GUI 进程（Dock / Finder / open 启动）由 launchd 拉起，只继承极简的
// PATH=/usr/bin:/bin:/usr/sbin:/sbin，不会加载 .zprofile/.zshrc，
// 因此 mise shims、代理、SSH agent 等配置全部缺失。
// 这里读取一次用户登录 shell 的环境，补回 Git 子进程真正需要的变量。

// 只导入白名单变量：避免把 ELECTRON_RUN_AS_NODE、NODE_OPTIONS 等
// 属于宿主进程的变量带进子进程，导致 Electron/Node 行为被改写。
const IMPORTED_KEYS = [
  'PATH', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];

const FALLBACK_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function parseEnvironment(buffer) {
  const values = {};
  for (const chunk of buffer.toString('utf8').split('\0')) {
    // shell 启动脚本可能往 stdout 打印内容，取每个条目最后一个换行之后的部分。
    const entry = chunk.slice(chunk.lastIndexOf('\n') + 1);
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const key = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = entry.slice(separator + 1);
  }
  return values;
}

function mergePath(...sources) {
  const seen = new Set();
  const entries = [];
  for (const source of sources) {
    for (const entry of String(source ?? '').split(':')) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
  }
  return entries.join(':');
}

export function currentPathWithFallbacks() {
  return mergePath(process.env.PATH, FALLBACK_PATH.join(':'));
}

// 返回需要覆盖到 Git 子进程环境中的变量；读取失败时退回当前 PATH + 常见目录。
export async function readLoginShellEnvironment({ timeout = 8000 } = {}) {
  const fallback = { PATH: currentPathWithFallbacks() };
  const shell = process.env.SHELL || '/bin/zsh';
  let buffer;
  try {
    ({ stdout: buffer } = await new Promise((resolve, reject) => {
      const task = execFile(shell, ['-ilc', 'env -0'], {
        env: { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.LOGNAME, TERM: 'dumb', PATH: process.env.PATH },
        encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout,
      }, (error, stdout) => {
        // 交互式 shell 退出码常被 rc 文件的最后一条命令污染，只要拿到了输出就继续解析。
        if (error && !stdout?.length) reject(error);
        else resolve({ stdout });
      });
      task.stdin?.end();
    }));
  } catch {
    return fallback;
  }

  const parsed = parseEnvironment(buffer);
  const patch = {};
  for (const key of IMPORTED_KEYS) {
    if (typeof parsed[key] === 'string' && parsed[key]) patch[key] = parsed[key];
  }
  if (!patch.PATH) return fallback;

  // 登录 shell 的 PATH 优先（用户意图），再补上宿主进程 PATH 和系统兜底目录。
  patch.PATH = mergePath(patch.PATH, process.env.PATH, FALLBACK_PATH.join(':'));
  return patch;
}
