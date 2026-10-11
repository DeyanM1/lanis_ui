export type InstallAvailability =
  | 'native'
  | 'ios-safari'
  | 'macos-safari'
  | 'ios-other-browser'
  | 'unsupported'
  | 'installed';

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach(listener => listener());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

export const subscribeToInstallAvailability = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getDeferredInstallPrompt = () => deferredPrompt;

export const clearDeferredInstallPrompt = () => {
  deferredPrompt = null;
  notify();
};

export const isStandaloneMode = () => (
  window.matchMedia('(display-mode: standalone)').matches
  || (window.navigator as Navigator & { standalone?: boolean }).standalone === true
);

const isIosDevice = () => {
  const navigatorWithTouchPoints = window.navigator as Navigator & { maxTouchPoints?: number };
  return /iPad|iPhone|iPod/.test(window.navigator.userAgent)
    || (window.navigator.platform === 'MacIntel' && (navigatorWithTouchPoints.maxTouchPoints || 0) > 1);
};

const isSafari = () => {
  const userAgent = window.navigator.userAgent;
  return /Safari/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(userAgent);
};

export const getInstallAvailability = (): InstallAvailability => {
  if (isStandaloneMode()) return 'installed';
  if (deferredPrompt) return 'native';
  if (isIosDevice()) return isSafari() ? 'ios-safari' : 'ios-other-browser';
  if (isSafari() && /Macintosh|Mac OS X/i.test(window.navigator.userAgent)) return 'macos-safari';
  return 'unsupported';
};
