import { useEffect, useState } from 'react';
import { Download, WifiOff, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function PwaControls() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const handleInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const handleInstalled = () => setInstallPrompt(null);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener('beforeinstallprompt', handleInstall);
    window.addEventListener('appinstalled', handleInstalled);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('beforeinstallprompt', handleInstall);
      window.removeEventListener('appinstalled', handleInstalled);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  async function install() {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  if (!online) return <div className="pwa-toast offline" role="status"><WifiOff size={17} /><span>オフラインです。再接続後に最新データを読み込みます。</span></div>;
  if (!installPrompt) return null;

  return <div className="pwa-toast" role="status">
    <Download size={18} />
    <span><strong>issueban をインストール</strong><small>ホーム画面からすぐに開けます</small></span>
    <button className="button primary compact" onClick={() => void install()}>インストール</button>
    <button className="icon-button mini" aria-label="閉じる" onClick={() => setInstallPrompt(null)}><X size={16} /></button>
  </div>;
}
