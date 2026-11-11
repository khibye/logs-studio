import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./settings";

/**
 * Files on the app's own persistent volume (DATA_DIR) — settings, templates and, when
 * Elasticsearch can't be written, dashboards. One replica writes them (see the k8s example).
 */

/** Writes JSON atomically (temp file + rename), readable only by the app. */
export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Whether DATA_DIR can be written (checked with a real write). */
export function dataWritable(): { write: boolean; reason?: string; dir: string } {
  try {
    mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return { write: true, dir: dataDir };
  } catch (err: any) {
    return { write: false, dir: dataDir, reason: `התיקייה ${dataDir} לא ניתנת לכתיבה: ${err.code ?? err.message}` };
  }
}
