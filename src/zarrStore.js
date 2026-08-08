import {open} from "zarrita";

export function createTolerantStore(url, {confirmOpaqueErrors = false} = {}) {
  const opaqueSeen = new Set();
  return {
    async get(key, options = {}) {
      const target = `${url}${key}`;
      let response;
      try {
        response = await fetch(target, options);
      } catch (err) {
        let reachable = false;
        try {
          await fetch(target, {mode: "no-cors", cache: "no-store"});
          reachable = true;
        } catch {
          // server genuinely unreachable
        }
        if (!reachable) throw err;
        if (confirmOpaqueErrors && !opaqueSeen.has(key)) {
          opaqueSeen.add(key);
          err.opaqueError = true;
          throw err;
        }
        return undefined;
      }
      if (response.status === 404 || response.status === 403) return undefined;
      if (!response.ok) throw new Error(`Unexpected response status ${response.status} fetching ${target}`);
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}

export const openZarrArray = (zarrUrl, name, storeOptions) => open.v3(createTolerantStore(`${zarrUrl}/${name}`, storeOptions));
