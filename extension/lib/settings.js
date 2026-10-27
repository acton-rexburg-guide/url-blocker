// Reads the raw settings the admin pushed (or, on unpacked installs, a local test config).

export const isDev = !('update_url' in chrome.runtime.getManifest());

// On a device with no admin policy, storage.managed.get() can hang forever.
async function readManaged() {
  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve({}), 2000));
    return (await Promise.race([chrome.storage.managed.get(null), timeout])) ?? {};
  } catch {
    return {};
  }
}

export async function readSettings() {
  const managed = await readManaged();
  if (Object.keys(managed).length) return { raw: managed, source: 'admin' };
  if (isDev) {
    const { devConfig } = await chrome.storage.local.get('devConfig');
    if (devConfig) return { raw: devConfig, source: 'developer' };
  }
  return { raw: null, source: 'none' };
}
