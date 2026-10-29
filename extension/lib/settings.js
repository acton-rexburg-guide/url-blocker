// Reads the raw settings the admin pushed (or, on unpacked installs, a local test config).

export const isDev = !('update_url' in chrome.runtime.getManifest());

// storage.managed.get() can hang while Chrome is still loading policy at
// startup, and forever on a device with no policy. Returns null if it didn't answer.
export async function readManaged() {
  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5000));
    return await Promise.race([chrome.storage.managed.get(null), timeout]);
  } catch {
    return {};
  }
}

// source: 'developer' | 'admin' | 'none', or 'pending' when policy hasn't loaded yet.
export async function readSettings() {
  if (isDev) {
    const { devConfig } = await chrome.storage.local.get('devConfig');
    if (devConfig) return { raw: devConfig, source: 'developer' };
  }
  const managed = await readManaged();
  if (managed === null) return { raw: null, source: 'pending' };
  if (Object.keys(managed).length) return { raw: managed, source: 'admin' };
  return { raw: null, source: 'none' };
}
