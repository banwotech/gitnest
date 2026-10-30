import { execFile } from 'node:child_process';
import { promisify, TextDecoder } from 'node:util';
import { readdir, realpath, lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const gitEnv = {
  ...process.env,
  PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1',
};

async function git(cwd, args, options = {}) {
  try {
    const { input, ...execOptions } = options;
    const task = exec('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      env: gitEnv, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 20000, ...execOptions,
    });
    task.child.stdin?.end(input ?? '');
    const { stdout } = await task;
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未找到 Git。请先安装 Git 或 Xcode Command Line Tools。');
    throw error;
  }
}

async function hasMergeHead(directory) {
  try { await git(directory, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}

export function parseStatus(output) {
  const records = output.split('\0');
  const files = [];
  let branch = '';
  let head = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('# branch.head ')) branch = record.slice(14);
    else if (record.startsWith('# branch.oid ')) head = record.slice(13) === '(initial)' ? null : record.slice(13);
    else if (record.startsWith('# branch.upstream ')) upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) {
      const counts = record.match(/\+(\d+) -(\d+)/);
      if (counts) { ahead = Number(counts[1]); behind = Number(counts[2]); }
    } else if (/^[12u] /.test(record)) {
      const fields = record.split(' ');
      const type = fields[0];
      const status = fields[1];
      const filePath = fields.slice(type === '1' ? 8 : type === '2' ? 9 : 10).join(' ');
      const originalPath = type === '2' ? records[++i] : null;
      files.push({
        path: filePath, originalPath, indexStatus: status[0], worktreeStatus: status[1],
        kind: type === 'u' ? 'conflict' : status.includes('R') ? 'renamed' : status.includes('D') ? 'deleted' : status.includes('A') ? 'added' : 'modified',
        staged: status[0] !== '.', unstaged: status[1] !== '.', submodule: fields[2].startsWith('S'),
      });
    } else if (record.startsWith('? ')) {
      files.push({ path: record.slice(2), originalPath: null, indexStatus: '?', worktreeStatus: '?', kind: 'untracked', staged: false, unstaged: true, submodule: false });
    }
  }
  return { branch: branch === '(detached)' ? `游离 HEAD · ${head?.slice(0, 7) ?? ''}` : branch, branchName: branch === '(detached)' ? null : branch, head, upstream, ahead, behind, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

async function inspectProject(directory) {
  const base = { name: path.basename(directory), path: directory, isRepository: false, files: [], error: null };
  try {
    let top;
    try { top = (await git(directory, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) {
      if (String(error.stderr).includes('not a git repository')) return base;
      throw error;
    }
    if (await realpath(top) !== directory) return base;
    const status = parseStatus(await git(directory, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
    const [log, remoteOutput, tracking, refsOutput, mergeInProgress] = await Promise.all([
      status.head ? git(directory, ['log', '-1', '--format=%s%x00%an%x00%aI']) : '',
      git(directory, ['remote']),
      status.head && status.branchName ? git(directory, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${status.branchName}`]) : '',
      git(directory, ['for-each-ref', '--format=%(refname)%00%(symref)%00%(worktreepath)%00', 'refs/heads/', 'refs/remotes/']),
      hasMergeHead(directory),
    ]);
    let commit = null;
    if (log) {
      const [subject, author, date] = log.trimEnd().split('\0');
      commit = { subject, author, date };
    }
    const [upstreamRemote, upstreamBranch] = tracking.trimEnd().split('\0');
    const remotes = remoteOutput.trim().split('\n').filter(Boolean);
    if (upstreamRemote === '.' && !remotes.includes('.')) remotes.unshift('.');
    const remoteNames = remotes.filter((name) => name !== '.').sort((a, b) => b.length - a.length);
    const branches = refsOutput.split('\0\n').filter(Boolean).flatMap((record) => {
      const [ref, symbolicRef, worktreePath] = record.split('\0');
      if (symbolicRef) return [];
      if (ref.startsWith('refs/heads/')) return [{ ref, name: ref.slice(11), remote: null, checkedOutElsewhere: Boolean(worktreePath && path.resolve(worktreePath) !== directory) }];
      const remote = remoteNames.find((name) => ref.startsWith(`refs/remotes/${name}/`));
      return remote ? [{ ref, name: ref.slice(`refs/remotes/${remote}/`.length), remote, checkedOutElsewhere: false }] : [];
    });
    return { ...base, ...status, isRepository: true, commit, remotes, branches, mergeInProgress, upstreamRemote: upstreamRemote || null, upstreamBranch: upstreamBranch || null };
  } catch (error) {
    return { ...base, error: error.stderr?.trim() || error.message };
  }
}

async function mapLimited(items, fn, limit = 4) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

export async function scanWorkspace(folder) {
  const root = await realpath(folder);
  if (!(await lstat(root)).isDirectory()) throw new Error('请选择一个文件夹。');
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && entry.name !== '.git').map((entry) => path.join(root, entry.name));
  const [rootProject, children] = await Promise.all([inspectProject(root), mapLimited(directories, inspectProject)]);
  const projects = rootProject.isRepository ? [rootProject, ...children] : children;
  projects.sort((a, b) => Number(b.isRepository) - Number(a.isRepository) || a.name.localeCompare(b.name));
  return { path: root, name: path.basename(root), projects, scannedAt: new Date().toISOString() };
}

export async function readCommits(repository, { ref = '', query = '', offset = 0 } = {}) {
  if (typeof ref !== 'string' || typeof query !== 'string' || query.length > 300 || !Number.isInteger(offset) || offset < 0 || offset > 50000) throw new Error('无效的提交查询。');
  const current = await inspectProject(repository.path);
  if (!current.isRepository) throw new Error(current.error ?? '该文件夹已不再是 Git 仓库。');
  if (ref && !current.branches.some((branch) => branch.ref === ref)) throw new Error('目标分支已不存在，请重新选择。');
  if (!current.head && !current.branches.length) return { commits: [], hasMore: false };
  const revisions = ref ? [ref] : ['--branches', '--remotes', ...(current.head ? ['HEAD'] : [])];
  const output = await git(current.path, ['log', '--date-order', '--decorate=short', '--format=%H%x00%h%x00%s%x00%an%x00%aI%x00%D%x00', '--max-count=51', `--skip=${offset}`, ...(query.trim() ? ['--fixed-strings', '--regexp-ignore-case', `--grep=${query.trim()}`] : []), ...revisions, '--']);
  const commits = output.split('\0\n').filter(Boolean).map((record) => {
    const [id, shortId, subject, author, date, refs] = record.split('\0');
    return { id, shortId, subject, author, date, refs };
  });
  return { commits: commits.slice(0, 50), hasMore: commits.length > 50 };
}

function decode(buffer) {
  if (buffer.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { return null; }
}

export async function readComparison(repository, file, source = 'working') {
  if (!['working', 'staged'].includes(source)) throw new Error('无效的对比版本。');
  const relative = file.path;
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('无效的文件路径。');
  const result = { path: relative, originalPath: file.originalPath, original: '', modified: '', head: repository.head, source, kind: 'text', message: null };
  let originalBuffer = Buffer.alloc(0);
  let modifiedBuffer = Buffer.alloc(0);
  if (repository.head && file.kind !== 'untracked' && file.indexStatus !== 'A') {
    const tree = await git(repository.path, ['ls-tree', '-z', repository.head, '--', file.originalPath ?? relative]);
    if (tree) {
      const [mode, type, oid] = tree.split('\t')[0].split(' ');
      if (mode === '160000' || type === 'commit') return { ...result, kind: 'unsupported', message: '这是一个 Git 子模块。请选择该子模块文件夹，查看其中的文件差异。' };
      const size = Number((await git(repository.path, ['cat-file', '-s', oid])).trim());
      if (size > MAX_FILE_SIZE) return { ...result, kind: 'unsupported', message: '此文件超过 5 MB，暂不支持完整文件对比。' };
      originalBuffer = await git(repository.path, ['cat-file', 'blob', oid], { encoding: 'buffer', maxBuffer: MAX_FILE_SIZE + 1024 });
    }
  }
  if (source === 'staged') {
    if (!file.staged || file.kind === 'conflict') throw new Error('该文件没有可查看的已暂存版本。');
    if (file.indexStatus !== 'D') {
      const entry = await git(repository.path, ['ls-files', '--stage', '-z', '--', relative]);
      const [mode, oid, stage] = entry.split('\t')[0].split(' ');
      if (!oid || stage !== '0') throw new Error('暂存区状态已变化，请刷新后重试。');
      if (mode === '160000') return { ...result, kind: 'unsupported', message: '这是一个 Git 子模块，暂不支持文本对比。' };
      if (Number((await git(repository.path, ['cat-file', '-s', oid])).trim()) > MAX_FILE_SIZE) return { ...result, kind: 'unsupported', message: '此文件超过 5 MB，暂不支持完整文件对比。' };
      modifiedBuffer = await git(repository.path, ['cat-file', 'blob', oid], { encoding: 'buffer', maxBuffer: MAX_FILE_SIZE + 1024 });
    }
  } else try {
    const absolute = path.resolve(repository.path, relative);
    // Resolve the parent only: Git stores a symbolic link's target as its content.
    const parent = await realpath(path.dirname(absolute));
    const resolvedRelative = path.relative(repository.path, parent);
    if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative)) throw new Error('该文件位于仓库外部，无法读取。');
    const stat = await lstat(absolute);
    if (stat.isDirectory()) return { ...result, kind: 'unsupported', message: '这是一个目录或子模块，无法作为普通文件进行对比。' };
    if (stat.size > MAX_FILE_SIZE) return { ...result, kind: 'unsupported', message: '此文件超过 5 MB，暂不支持完整文件对比。' };
    modifiedBuffer = stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const original = decode(originalBuffer);
  const modified = decode(modifiedBuffer);
  if (original === null || modified === null) return { ...result, kind: 'binary', message: '此文件是二进制文件或非 UTF-8 文本，暂不支持文本对比。' };
  return { ...result, original, modified };
}

function selectedPaths(repository, payload, section) {
  const candidates = repository.files.filter((file) => section === 'staged' ? file.staged && file.kind !== 'conflict' : file.unstaged || file.kind === 'conflict');
  if (!candidates.length) throw new Error(section === 'staged' ? '没有已暂存的文件。' : '没有未暂存的文件。');
  if (payload.paths === undefined) {
    if (section === 'staged' && repository.files.some((file) => file.kind === 'conflict')) return [...new Set(candidates.flatMap((file) => [file.path, ...(file.originalPath ? [file.originalPath] : [])]))];
    return ['.'];
  }
  if (!Array.isArray(payload.paths) || !payload.paths.length || payload.paths.some((item) => typeof item !== 'string')) throw new Error('请选择需要操作的文件。');
  const paths = new Set();
  for (const requested of payload.paths) {
    const file = candidates.find((item) => item.path === requested);
    if (!file) throw new Error('文件状态已变化，请刷新后重试。');
    paths.add(file.path);
    if (section === 'staged' && file.originalPath) paths.add(file.originalPath);
  }
  return [...paths];
}

export async function performRepositoryAction(repository, action, payload = {}) {
  try {
    const current = await inspectProject(repository.path);
    if (!current.isRepository) throw new Error(current.error ?? '该文件夹已不再是 Git 仓库。');
    if (!payload || typeof payload !== 'object') throw new Error('无效的操作参数。');
    switch (action) {
      case 'createBranch': {
        if (!current.head) throw new Error('这个仓库还没有提交，请先提交再新建分支。');
        if (current.mergeInProgress || current.files.some((file) => file.kind === 'conflict')) throw new Error('请先完成当前合并或解决冲突，再新建分支。');
        const name = payload.name;
        if (typeof name !== 'string' || !name || name.length > 1024 || name !== name.trim()) throw new Error('请填写有效的分支名称。');
        await git(current.path, ['check-ref-format', '--branch', name]);
        await git(current.path, ['check-ref-format', `refs/heads/${name}`]);
        if (payload.checkout !== undefined && typeof payload.checkout !== 'boolean') throw new Error('无效的分支操作参数。');
        if (payload.checkout !== false) await git(current.path, ['switch', '--no-guess', '--no-track', '-c', name]);
        else await git(current.path, ['branch', '--no-track', '--', name, current.head]);
        return `已创建分支 ${name}${payload.checkout !== false ? ' 并切换' : ''}`;
      }
      case 'deleteBranch': {
        const branch = current.branches.find((item) => !item.remote && item.ref === payload.branch);
        if (!branch) throw new Error('目标本地分支已不存在，请刷新后重试。');
        if (branch.name === current.branchName) throw new Error('不能删除当前分支，请先切换到其他分支。');
        if (branch.checkedOutElsewhere) throw new Error('该分支正在其他工作区中使用，无法删除。');
        if (payload.force !== undefined && typeof payload.force !== 'boolean') throw new Error('无效的分支操作参数。');
        if (!payload.force && current.head) {
          try { await git(current.path, ['merge-base', '--is-ancestor', branch.ref, current.head]); }
          catch (error) { if (error.code === 1) throw new Error('该分支包含尚未合并到当前分支的提交。需要删除时，请勾选「强制删除未合并分支」。'); throw error; }
        }
        await git(current.path, ['branch', payload.force ? '-D' : '-d', '--', branch.name]);
        return `已删除本地分支 ${branch.name}`;
      }
      case 'merge': {
        if (!current.head || !current.branchName) throw new Error('请先切换到一个已有提交的本地分支。');
        if (current.mergeInProgress || current.files.some((file) => file.kind === 'conflict')) throw new Error('请先完成当前合并或解决冲突。');
        if (payload.expectedHead !== current.head || payload.branch !== current.branchName) throw new Error('当前分支或提交已变化，请重新打开合并面板。');
        if (current.files.some((file) => file.staged || (file.unstaged && file.kind !== 'untracked'))) throw new Error('请先提交或处理已跟踪文件的修改，再合并。');
        if (typeof payload.commit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(payload.commit)) throw new Error('请选择有效的提交。');
        if (payload.noFastForward !== undefined && typeof payload.noFastForward !== 'boolean') throw new Error('无效的合并选项。');
        const target = (await git(current.path, ['rev-parse', '--verify', `${payload.commit}^{commit}`])).trim();
        try {
          await git(current.path, ['merge', '--commit', '--no-squash', '--no-edit', '--no-autostash', payload.noFastForward ? '--no-ff' : '--ff', '--', target], { timeout: 120000 });
        } catch (error) {
          if (await hasMergeHead(current.path)) throw new Error(`合并未完成。请解决冲突并暂存后提交，或点击「合并 → 中止合并」。\n${[error.stderr, error.stdout].filter(Boolean).join('\n').trim()}`);
          throw error;
        }
        return `已将 ${target.slice(0, 7)} 合并到 ${current.branchName}`;
      }
      case 'abortMerge': {
        if (!current.mergeInProgress) throw new Error('当前没有进行中的合并。');
        await git(current.path, ['merge', '--abort']);
        return '已中止合并';
      }
      case 'switch': {
        const branch = current.branches.find((item) => item.ref === payload.branch);
        if (!branch) throw new Error('目标分支已不存在，请刷新后重试。');
        if (branch.checkedOutElsewhere) throw new Error('该分支正在其他工作区中使用，无法切换。');
        if (current.mergeInProgress || current.files.some((file) => file.kind === 'conflict')) throw new Error('请先完成当前合并或解决合并冲突，再切换分支。');
        await git(current.path, ['check-ref-format', '--branch', branch.name]);
        if (branch.remote) {
          if (current.branches.some((item) => !item.remote && item.name === branch.name)) throw new Error(`本地已有同名分支「${branch.name}」，请从本地分支列表选择。`);
          await git(current.path, ['switch', '--no-guess', '--track=direct', '-c', branch.name, '--', branch.ref]);
        } else await git(current.path, ['switch', '--no-guess', '--', branch.name]);
        return `已切换到 ${branch.name}`;
      }
      case 'stage': {
        const paths = selectedPaths(current, payload, 'unstaged');
        await git(current.path, ['add', '--all', '--', ...paths]);
        return '已暂存所选修改';
      }
      case 'unstage': {
        const paths = selectedPaths(current, payload, 'staged');
        await git(current.path, current.head ? ['restore', '--staged', '--source=HEAD', '--', ...paths] : ['rm', '-r', '--cached', '--force', '--ignore-unmatch', '--', ...paths]);
        return '已取消暂存，磁盘文件保持不变';
      }
      case 'commit': {
        if (typeof payload.message !== 'string' || !payload.message.trim()) throw new Error('请填写提交说明。');
        if (Buffer.byteLength(payload.message) > 65536) throw new Error('提交说明过长，请控制在 64 KB 以内。');
        if (current.files.some((file) => file.kind === 'conflict')) throw new Error('请先解决合并冲突并暂存，再提交。');
        if (!current.files.some((file) => file.staged) && !current.mergeInProgress) throw new Error('请先暂存需要提交的文件。');
        await git(current.path, ['commit', '--file=-'], { input: payload.message.trim(), timeout: 120000 });
        return '提交成功';
      }
      case 'pull':
      case 'push': {
        if (!current.branchName) throw new Error('当前处于游离 HEAD 状态，请先切换到一个分支。');
        const remote = payload.remote;
        if (typeof remote !== 'string' || !current.remotes.includes(remote)) throw new Error('请选择该仓库中已配置的远程仓库。');
        const target = remote === current.upstreamRemote && current.upstreamBranch ? current.upstreamBranch : `refs/heads/${current.branchName}`;
        if (action === 'pull') {
          await git(current.path, ['pull', '--ff-only', '--no-rebase', '--', remote, target], { timeout: 120000 });
          return '拉取完成';
        }
        if (!current.head) throw new Error('这个仓库还没有提交，请先提交再推送。');
        const options = remote === current.upstreamRemote && current.upstreamBranch ? [] : ['--set-upstream'];
        await git(current.path, ['push', ...options, '--', remote, `HEAD:${target}`], { timeout: 120000 });
        return '推送完成';
      }
      default: throw new Error('不支持的 Git 操作。');
    }
  } catch (error) {
    if (error.killed) throw new Error('Git 操作超时，请检查网络、Git 凭据或提交钩子。');
    const details = [error.stderr, error.stdout].filter(Boolean).map(String).join('\n').trim();
    if (details) throw new Error(details.slice(0, 6000));
    throw error;
  }
}
