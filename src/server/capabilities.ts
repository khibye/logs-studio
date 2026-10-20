import { config, kibanaBase, onConfigChange, withEnv } from "./config";
import { es, HttpError } from "./elastic";
import type { Capabilities } from "../shared/recipe";

/**
 * Works out what this deployment may do, from the API key's real privileges.
 * The UI turns features on or off from this — nothing is assumed.
 * Cached briefly; this is not user state, just a probe result.
 */

const cache = new Map<string, { at: number; value: Capabilities }>();
const TTL_MS = 60_000;
onConfigChange(() => {
  cache.clear();
});

function versionAtLeast(v: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v ?? "");
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}

/** Kibana's version — and whether KIBANA_URL actually answers like Elasticsearch (a common mix-up). */
async function kibanaProbe(): Promise<{ version?: string; isElasticsearch?: boolean }> {
  if (!config.kibana.url) return {};
  try {
    const res = await fetch(`${config.kibana.url}/api/status`, {
      headers: { Authorization: `ApiKey ${config.kibana.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return {};
    }
    // Elasticsearch answers unknown paths with { error: { type, reason: "no handler found for uri ..." } }
    if (body?.error?.type || /no handler found for uri/i.test(text)) return { isElasticsearch: true };
    return res.ok ? { version: body?.version?.number } : {};
  } catch {
    return {};
  }
}

/** Library privileges are checked in the environment that holds the library. */
async function libraryCaps(): Promise<Capabilities["library"]> {
  return withEnv(config.libraryEnv, async () => {
    const lib: Capabilities["library"] = { read: false, write: false, index: config.elastic.dashboardsIndex };
    try {
      const priv = await es("/_security/user/_has_privileges", {
        body: { index: [{ names: [config.elastic.dashboardsIndex], privileges: ["read", "create_doc"] }] },
      });
      const d = priv?.index?.[config.elastic.dashboardsIndex] ?? {};
      lib.read = Boolean(d.read);
      lib.write = Boolean(d.read && d.create_doc);
      if (!d.read) lib.reason = "The API key cannot read the dashboards index";
      else if (!d.create_doc) lib.reason = "The API key can read the dashboards index but not write to it";
    } catch (err: any) {
      lib.reason = `Privilege check failed: ${err.message}`;
      return lib;
    }
    if (lib.read) {
      try {
        await es(`/${encodeURIComponent(config.elastic.dashboardsIndex)}/_search`, { body: { size: 0 } });
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) {
          lib.read = false;
          lib.write = false;
          lib.reason = `Index ${config.elastic.dashboardsIndex} does not exist yet (see README → setup)`;
        }
      }
    }
    if (config.libraryEnv !== config.env.id || config.environments.length > 1) lib.env = config.env.name;
    return lib;
  });
}

export async function getCapabilities(force = false): Promise<Capabilities> {
  const envId = config.env.id;
  const hit = cache.get(envId);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const caps: Capabilities = {
    elastic: { ok: false, via: config.elastic.connection },
    llm: { configured: Boolean(config.llm.baseUrl), model: config.llm.model || undefined },
    logs: { read: false, patterns: config.elastic.logPatterns },
    library: { read: false, write: false, index: config.elastic.dashboardsIndex },
    discover: {
      enabled: Boolean(config.kibana.publicUrl),
      baseUrl: kibanaBase(config.kibana.publicUrl),
      reason: config.kibana.publicUrl ? undefined : "KIBANA_URL is not set",
    },
    kibanaExport: { enabled: false, experimental: true },
    chat: { retentionHours: config.chatRetentionHours },
    admin: { enabled: Boolean(config.adminPassword) },
    env: { id: config.env.id, name: config.env.name },
    environments: config.environments.map((e) => ({ id: e.id, name: e.name })),
  };
  const libraryPromise = libraryCaps();

  const apiKey =
    config.elastic.connection === "kibana" ? config.elastic.apiKey || config.kibana.apiKey : config.elastic.apiKey;
  if (!apiKey) {
    caps.elastic.error = "ELASTIC_API_KEY is not set";
  } else {
    try {
      const info = await es("/");
      caps.elastic = { ok: true, version: info?.version?.number, via: config.elastic.connection };
    } catch (err: any) {
      // Some read-only keys may not call "/" — the privilege check below still tells us if we're connected.
      caps.elastic = { ok: false, error: err.message, via: config.elastic.connection };
    }

    try {
      const priv = await es("/_security/user/_has_privileges", {
        body: { index: [{ names: config.elastic.logPatterns, privileges: ["read"] }] },
      });
      caps.elastic.ok = true;
      caps.elastic.error = undefined;
      const idx = priv?.index ?? {};
      const missing = config.elastic.logPatterns.filter((p) => !idx[p]?.read);
      caps.logs.read = missing.length === 0;
      if (missing.length) caps.logs.reason = `No read privilege on: ${missing.join(", ")}`;
    } catch (err: any) {
      caps.logs.reason = `Privilege check failed: ${err.message}`;
    }
  }
  caps.library = await libraryPromise;

  if (!config.kibana.url) {
    caps.kibanaExport.reason = "KIBANA_URL is not set";
  } else if (!config.kibana.exportEnabled) {
    caps.kibanaExport.reason = "Turned off (KIBANA_EXPORT=off)";
  } else {
    const probe = await kibanaProbe();
    const v = probe.version;
    caps.kibanaExport.kibanaVersion = v;
    if (probe.isElasticsearch) {
      const why = "KIBANA_URL points to Elasticsearch, not Kibana. Use the address you open Kibana with in the browser.";
      caps.kibanaExport.reason = why;
      // Only a warning: the Discover button stays on (the check could be wrong behind some proxies).
      if (config.kibana.publicUrl === config.kibana.url) caps.discover.warning = why;
    } else if (!v) caps.kibanaExport.reason = "Could not read the Kibana version";
    else if (!versionAtLeast(v, 9, 4)) caps.kibanaExport.reason = `Needs Kibana 9.4 or later (this is ${v})`;
    else caps.kibanaExport.enabled = true;
  }

  cache.set(envId, { at: Date.now(), value: caps });
  return caps;
}
