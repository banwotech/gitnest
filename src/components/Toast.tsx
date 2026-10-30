import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle, WarningCircle, X } from '@phosphor-icons/react';

export interface ToastMessage { kind: 'success' | 'error'; message: string }

export default function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: () => void }) {
  const [host, setHost] = useState<HTMLElement>(document.body);
  useLayoutEffect(() => {
    const updateHost = () => setHost(document.querySelector<HTMLDialogElement>('dialog[open]') ?? document.body);
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    updateHost();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, toast.kind === 'error' ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss]);

  return createPortal(<div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
    {toast.kind === 'error' ? <WarningCircle size={19} /> : <CheckCircle size={19} />}
    <span>{toast.message}</span>
    <button className="icon-button" aria-label="关闭提示" onClick={onDismiss}><X size={14} /></button>
  </div>, host);
}
