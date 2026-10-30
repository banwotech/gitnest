import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWorkspace, readComparison, readCommits, performRepositoryAction } from './git.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
app.setName('GitNest');
const dataArgument = process.argv.find((arg) => arg.startsWith('--data-dir='));
if (dataArgument) app.setPath('userData', dataArgument.slice(11));
let window;
let workspace = null;
let settings = { recent: [], lastWorkspace: null };
let operation = Promise.resolve();

async function loadSettings() {
  try {
    const stored = JSON.parse(await readFile(path.join(app.getPath('userData'), 'workspaces.json'), 'utf8'));
    settings.recent = Array.isArray(stored.recent) ? stored.recent.filter((item) => typeof item === 'string').slice(0, 8) : [];
    settings.lastWorkspace = typeof stored.lastWorkspace === 'string' ? stored.lastWorkspace : null;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('无法读取工作区设置：', error.message);
  }
}

async function openWorkspace(folder) {
  const scanned = await scanWorkspace(folder);
  const next = { recent: [scanned.path, ...settings.recent.filter((item) => item !== scanned.path)].slice(0, 8), lastWorkspace: scanned.path };
  const settingsPath = path.join(app.getPath('userData'), 'workspaces.json');
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(`${settingsPath}.tmp`, JSON.stringify(next, null, 2));
  await rename(`${settingsPath}.tmp`, settingsPath);
  settings = next;
  workspace = scanned;
  return { workspace, recent: settings.recent };
}

function repositoryFor(repositoryPath) {
  const repository = workspace?.projects.find((item) => item.isRepository && item.path === repositoryPath);
  if (!repository) throw new Error('该仓库不在当前工作区，请重新选择文件夹。');
  return repository;
}

function changedFile(repository, filePath) {
  const file = repository.files.find((item) => item.path === filePath);
  if (!file) throw new Error('该文件的状态已变化，请刷新后重试。');
  return file;
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: '无效的请求来源。' };
    try { return { ok: true, data: await callback(...args) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
}

function queueWorkspace(callback) {
  const next = operation.then(callback, callback);
  operation = next.catch(() => {});
  return next;
}

function registerHandlers() {
  handle('window:is-fullscreen', () => window.isFullScreen());
  handle('workspace:initialize', () => queueWorkspace(async () => {
    const initial = process.argv.find((arg) => arg.startsWith('--workspace='))?.slice(12) ?? settings.lastWorkspace;
    if (initial) return openWorkspace(initial);
    return { workspace: null, recent: settings.recent };
  }));
  handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择工作区文件夹', buttonLabel: '打开工作区', properties: ['openDirectory'], defaultPath: workspace?.path });
    if (result.canceled || !result.filePaths[0]) return null;
    return queueWorkspace(() => openWorkspace(result.filePaths[0]));
  });
  handle('workspace:recent', (folder) => queueWorkspace(() => {
    if (!settings.recent.includes(folder)) throw new Error('此文件夹不在最近打开的工作区中。');
    return openWorkspace(folder);
  }));
  handle('workspace:refresh', () => queueWorkspace(async () => {
    if (!workspace) return null;
    workspace = await scanWorkspace(workspace.path);
    return workspace;
  }));
  handle('file:compare', (repositoryPath, filePath, source = 'working') => {
    const repository = repositoryFor(repositoryPath);
    return readComparison(repository, changedFile(repository, filePath), source);
  });
  handle('repository:action', (repositoryPath, action, payload) => queueWorkspace(async () => {
    const repository = repositoryFor(repositoryPath);
    let message = null;
    let error = null;
    try { message = await performRepositoryAction(repository, action, payload); }
    catch (failure) { error = failure.message; }
    workspace = await scanWorkspace(workspace.path);
    return { workspace, message, error };
  }));
  handle('repository:commits', (repositoryPath, options) => readCommits(repositoryFor(repositoryPath), options));
  handle('file:reveal', (repositoryPath, filePath) => {
    const repository = repositoryFor(repositoryPath);
    if (filePath) {
      changedFile(repository, filePath);
      shell.showItemInFolder(path.join(repository.path, filePath));
    } else shell.showItemInFolder(repository.path);
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 1080, minHeight: 680, title: 'GitNest',
    backgroundColor: '#fafaf8', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 },
    icon: path.join(directory, '../build/icon.png'),
    webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const notifyFullscreen = () => window.webContents.send('window:fullscreen-changed', window.isFullScreen());
  window.on('enter-full-screen', notifyFullscreen);
  window.on('leave-full-screen', notifyFullscreen);
  const devUrl = process.env.GITNEST_DEV_URL;
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(directory, '../dist/index.html'));
}

app.whenReady().then(async () => {
  await loadSettings();
  registerHandlers();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'GitNest', submenu: [{ role: 'about', label: '关于 GitNest' }, { type: 'separator' }, { role: 'hide', label: '隐藏 GitNest' }, { role: 'quit', label: '退出 GitNest' }] },
  { label: '文件', submenu: [{ label: '打开工作区…', accelerator: 'CmdOrCtrl+O', click: () => window?.webContents.send('menu:choose-folder') }, { role: 'close', label: '关闭窗口' }] },
  { label: '编辑', submenu: [{ role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
  { label: '视图', submenu: [{ role: 'reload', label: '重新载入' }, { role: 'toggleDevTools', label: '开发者工具' }, { role: 'togglefullscreen', label: '全屏' }] },
  ]));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => {
  dialog.showErrorBox('GitNest 启动失败', error.message);
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
