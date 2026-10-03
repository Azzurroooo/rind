import { parsePairing } from "./pairing.js";

const KEY = "rind.mobile.hosts.v1";
const credentialKey = (id) => `rind.mobile.code.${id}`;
// Android's local HTTP origin lacks randomUUID, but supports getRandomValues.
const createId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, "0")).join("");

export function createHostStore(preferences, vault) {
  async function list() {
    const { value } = await preferences.get({ key: KEY });
    if (!value) return [];
    let records;
    try { records = JSON.parse(value); } catch { throw new Error("Saved computers could not be read. App storage may be damaged."); }
    if (!Array.isArray(records)) throw new Error("Saved computers could not be read.");
    return records.filter((host) => {
      try { return /^[a-zA-Z0-9-]{1,64}$/.test(host.id) && typeof host.name === "string" && parsePairing(host.origin).origin === host.origin; } catch { return false; }
    }).map(({ id, name, origin }) => ({ id, name, origin }));
  }
  const write = (hosts) => preferences.set({ key: KEY, value: JSON.stringify(hosts) });
  return {
    list,
    async save(host, token, remember) {
      const hosts = await list();
      const origin = parsePairing(host.origin).origin;
      const previous = hosts.find((entry) => entry.origin === origin);
      const saved = { id: previous?.id || createId(), name: host.name.trim().slice(0, 80) || new URL(origin).hostname, origin };
      // Write metadata before secrets: a failed metadata write cannot orphan a new code.
      await write([saved, ...hosts.filter((entry) => entry.id !== saved.id)]);
      if (remember) await vault.set(credentialKey(saved.id), token);
      else await vault.remove(credentialKey(saved.id));
      return saved;
    },
    token: (id) => vault.get(credentialKey(id)),
    clearToken: (id) => vault.remove(credentialKey(id)),
    async forget(id) {
      await vault.remove(credentialKey(id));
      await write((await list()).filter((host) => host.id !== id));
    },
  };
}
