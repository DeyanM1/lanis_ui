import { notificationsAPI } from '../services/api';

export interface BrowserPushRepairState { renewalPending: boolean }

/** Repair an opted-in browser without asking permission or enabling a new device. */
export async function repairBrowserPushRegistration(
  token: string,
  signal: AbortSignal,
  isCurrent: () => boolean,
  state: BrowserPushRepairState = { renewalPending: false },
): Promise<boolean> {
  const current = () => !signal.aborted && isCurrent();
  if (!current() || !('Notification' in window) || Notification.permission !== 'granted'
    || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration || !current()) return false;
  let subscription = await registration.pushManager.getSubscription();
  if ((!subscription && !state.renewalPending) || !current()) return false;

  const [config, preferences] = await Promise.all([
    notificationsAPI.getConfig(token, signal),
    notificationsAPI.getPreferences(token, signal),
  ]);
  if (!current() || !config.success || !config.configured || !config.public_key
    || !preferences.success || !preferences.preferences.enabled) return false;

  const encoded = config.public_key.replace(/-/g, '+').replace(/_/g, '/');
  const key = Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), char => char.charCodeAt(0));
  if (key.byteLength !== 65 || key[0] !== 4) throw new Error('Ungültiger Push-Schlüssel vom Server.');
  const storedKey = subscription?.options.applicationServerKey;
  const matches = storedKey && storedKey.byteLength === key.byteLength
    && new Uint8Array(storedKey).every((value, index) => value === key[index]);
  if (!matches) {
    // The existing subscription establishes that this device already opted in.
    // Rebind it when the server's signing key changes, without changing consent.
    state.renewalPending = true;
    if (subscription) await subscription.unsubscribe();
    if (!current()) return false;
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  if (!subscription || !current()) return false;
  const payload = subscription.toJSON();
  if (!payload.endpoint || !payload.keys?.p256dh || !payload.keys.auth) return false;
  const response = await notificationsAPI.registerSubscription(token, {
    endpoint: payload.endpoint,
    keys: { p256dh: payload.keys.p256dh, auth: payload.keys.auth },
  }, signal);
  if (response.success && current()) state.renewalPending = false;
  return current() && response.success;
}
