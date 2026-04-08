const DEVICE_ID_KEY = 'ayran_device_id';

let cachedDeviceId: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  const stored = localStorage.getItem(DEVICE_ID_KEY);
  if (stored) {
    cachedDeviceId = stored;
    return stored;
  }

  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_ID_KEY, id);
  cachedDeviceId = id;
  return id;
}
