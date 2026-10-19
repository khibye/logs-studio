import { config, kibanaBase } from "./config";
import { es, HttpError } from "./elastic";
import type { Capabilities } from "../shared/recipe";

/**
 * Works out what this deployment may do, from the API key's real privileges.
 * The UI turns features on or off from this — nothing is assumed.
 * Cached briefly; this is not user state, just a probe result.
 */

let cache: { at: number; value: Capabilities } | null = null;
const TTL_MS = 60_000;

function versionAtLeast(v: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v ?? "");
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

async function kibanaVersion(): Promise<string | undefined> {
  if (!config.kibana.url) return undefined;
  try {
    const res = await fetch(`${config.kibana.url}/api/status`, {
      headers: { Authorization: `ApiKey ${config.kibana.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return undefined;
    const body: any = await res.json();
    return body?.version?.number;
  } catch {
    return undefined;
  }
}

export async function getCapabilities(force = false): Promise<Capabilities> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const caps: Capabilities = {
    elastic: { ok: false },
    llm: { configured: Boolean(config.llm.baseUrl && config.llm.model), model: config.llm.model || undefined },
    logs: { read: false, patterns: config.elastic.logPatterns },
    library: { read: false, write: false, index: config.elastic.dashboardsIndex },
    discover: { enabled: Boolean(config.kibana.publicUrl), baseUrl: kibanaBase(config.kibana.publicUrl) },
    kibanaExport: { enabled: false, experimental: true },
    chat: { retentionHours: config.chatRetentionHours },
  };

  if (!config.elastic.apiKey) {
    caps.elastic.error = "ELASTIC_API_KEY is not set";
  } else {
    try {
      const info = await es("/");
      caps.elastic = { ok: true, version: info?.version?.number };
    } catch (err: any) {
      // Some read-only keys may not call "/" — the privilege check below still tells us if we're connected.
      caps.elastic = { ok: false, error: err.message };
    }

    try {
      const priv = await es("/_security/user/_has_privileges", {
        body: {
          index: [
            { names: config.elastic.logPatterns, privileges: ["read"] },
            { names: [config.elastic.dashboardsIndex], privileges: ["read", "create_doc"] },
          ],
        },
      });
      caps.elastic.ok = true;
      const idx = priv?.index ?? {};
      const missing = config.elastic.logPatterns.filter((p) => !idx[p]?.read);
      caps.logs.read = missing.length === 0;
      if (missing.length) caps.logs.reason = `No read privilege on: ${missing.join(", ")}`;
      const d = idx[config.elastic.dashboardsIndex] ?? {};
      caps.library.read = Boolean(d.read);
      caps.library.write = Boolean(d.read && d.create_doc);
      if (!d.read) caps.library.reason = "The API key cannot read the dashboards index";
      else if (!d.create_doc) caps.library.reason = "The API key can read the dashboards index but not write to it";
    } catch (err: any) {
      caps.logs.reason = `Privilege check failed: ${err.message}`;
      caps.library.reason = caps.logs.reason;
    }

    if (caps.library.read) {
      try {
        await es(`/${encodeURIComponent(config.elastic.dashboardsIndex)}/_search`, { body: { size: 0 } });
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          caps.library.read = false;
          caps.library.write = false;
          caps.library.reason = `Index ${config.elastic.dashboardsIndex} does not exist yet (see README → setup)`;
        }
      }
    }
  }

  if (!config.kibana.url) {
    caps.kibanaExport.reason = "KIBANA_URL is not set";
  } else if (!config.kibana.exportEnabled) {
    caps.kibanaExport.reason = "Turned off (KIBANA_EXPORT=off)";
  } else {
    const v = await kibanaVersion();
    caps.kibanaExport.kibanaVersion = v;
    if (!v) caps.kibanaExport.reason = "Could not read the Kibana version";
    else if (!versionAtLeast(v, 9, 4)) caps.kibanaExport.reason = `Needs Kibana 9.4 or later (this is ${v})`;
    else caps.kibanaExport.enabled = true;
  }

  cache = { at: Date.now(), value: caps };
  return caps;
}
