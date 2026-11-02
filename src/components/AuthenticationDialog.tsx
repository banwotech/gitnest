import { useEffect, useRef, useState } from 'react';
import { LockKey, X } from '@phosphor-icons/react';
import type { AuthenticationRequest, GitCredentials } from '../types';

export default function AuthenticationDialog({ request, onRespond }: {
  request: AuthenticationRequest;
  onRespond: (credentials: GitCredentials | null) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [username, setUsername] = useState(request.username);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(request.remember);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(request.error);
  const action = request.action === 'push' ? '推送' : '拉取';
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement>(request.username ? 'input[type="password"]' : 'input[name="username"]')?.focus();
  }, []);
  const respond = async (credentials: GitCredentials | null) => {
    if (submitting) return;
    setSubmitting(true);
    try { await onRespond(credentials); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setSubmitting(false); }
  };
  return <dialog ref={dialog} className="repository-dialog" aria-labelledby="authentication-title" onCancel={(event) => { event.preventDefault(); void respond(null); }}>
    <form onSubmit={(event) => { event.preventDefault(); void respond({ username: username.trim(), password, remember }); }}>
      <div className="repository-dialog-heading"><h2 id="authentication-title">登录远程仓库</h2><button type="button" className="icon-button" aria-label="取消认证" disabled={submitting} onClick={() => void respond(null)}><X size={18} /></button></div>
      <p className="authentication-remote">{request.url}</p>
      {error && <p className="authentication-error" role="alert">{error}</p>}
      <div className="authentication-fields">
        <label className="dialog-field">用户名<input name="username" aria-label="仓库用户名" autoComplete="username" maxLength={256} required value={username} readOnly={request.usernameLocked} disabled={submitting} onChange={(event) => setUsername(event.target.value)} /></label>
        <label className="dialog-field">密码或访问令牌（Token）<input type="password" aria-label="仓库密码或 Token" autoComplete="off" maxLength={8192} required value={password} disabled={submitting} onChange={(event) => setPassword(event.target.value)} /></label>
      </div>
      <label className="dialog-checkbox"><input type="checkbox" checked={remember} disabled={submitting} onChange={(event) => setRemember(event.target.checked)} />保存账号和密码，下次自动登录</label>
      <div className="repository-dialog-footer"><button type="button" className="button" disabled={submitting} onClick={() => void respond(null)}>取消</button><button type="submit" className="button primary" disabled={submitting || !username.trim() || !password}><LockKey size={16} />{submitting ? '正在继续…' : `继续${action}`}</button></div>
    </form>
  </dialog>;
}
