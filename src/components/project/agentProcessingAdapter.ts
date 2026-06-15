/**
 * Adapter that synthesizes the agent pipeline's three data sources — the live
 * `agentProjectContextLoadAtom` entry, the on-disk `.context-cache` snapshots /
 * failure markers, and the (possibly unsaved) form draft — into the
 * ProcessingItem[] model rendered by the ProcessingStatus panel.
 *
 * Per-item status priority (highest first):
 *  1. live failure from this session's run (missing → failed; stale → ready)
 *  2. disk snapshot present → Converted (for files, only when the stored
 *     `mtime:size` fingerprint still matches — a changed file shows Queued)
 *  3. disk failure marker present → failed, with the persisted error
 *  4. a run is in flight and the source is saved → processing
 *  5. otherwise → pending (Queued: the next materialization handles it)
 *
 * The live atom carries per-source data ONLY for failures (plus coarse phase),
 * so ready/queued always comes from disk — never inferred from the atom.
 */

import type { AgentProjectContextLoadState, FailedItem } from "@/aiParams";
import { EMPTY_RETRYING_SOURCES } from "@/aiParams";
import {
  processingItemEnvelope,
  type ProcessingItem,
} from "@/components/project/processingAdapter";
import {
  cacheFileName,
  CONTEXT_CACHE_DIR,
  failureMarkerName,
  parseFailureMarker,
  parseSnapshotMeta,
  type FailureMarker,
  type MaterializedSourceType,
} from "@/context/contextCacheStore";
import { normalizePath, type DataAdapter } from "obsidian";

/** One configured source the agent pipeline would materialize. */
export interface AgentProcessingSource {
  kind: MaterializedSourceType;
  /** URL (web/youtube) or vault path (file). */
  source: string;
  /** Live `mtime:size` for files — stale-snapshot detection. Unset for URLs. */
  fingerprint?: string;
}

/** Read-only view of a project's `.context-cache` dir, keyed by file name. */
export interface AgentCacheDirState {
  snapshotNames: Set<string>;
  markersByName: Map<string, FailureMarker>;
  /** Stored fingerprints of file-kind snapshots (only those we were asked to read). */
  fingerprintsByName: Map<string, string>;
}

/**
 * List a project's `.context-cache` and parse what status needs: failure-marker
 * JSON bodies, plus the meta fingerprint of the file snapshots in
 * `fileSnapshotNames` (URL snapshots are identity-fingerprinted — the name
 * alone proves freshness, so their bodies are never read). Returns undefined
 * when the dir is missing/unreadable — a project that never materialized has
 * no dir, which is not an error.
 */
export async function readAgentCacheDirState(
  adapter: DataAdapter,
  projectFolderPath: string,
  fileSnapshotNames: ReadonlySet<string>
): Promise<AgentCacheDirState | undefined> {
  const dir = normalizePath(`${projectFolderPath}/${CONTEXT_CACHE_DIR}`);
  let filePaths: string[];
  try {
    filePaths = (await adapter.list(dir)).files;
  } catch {
    return undefined;
  }

  const snapshotNames = new Set<string>();
  const markersByName = new Map<string, FailureMarker>();
  const fingerprintsByName = new Map<string, string>();

  for (const path of filePaths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (name.startsWith("failed-") && name.endsWith(".json")) {
      const marker = await readJsonTolerant(adapter, path);
      if (marker) markersByName.set(name, marker);
      continue;
    }
    snapshotNames.add(name);
    if (fileSnapshotNames.has(name)) {
      const meta = await readMetaTolerant(adapter, path);
      if (meta) fingerprintsByName.set(name, meta.fingerprint);
    }
  }
  return { snapshotNames, markersByName, fingerprintsByName };
}

async function readJsonTolerant(adapter: DataAdapter, path: string): Promise<FailureMarker | null> {
  try {
    return parseFailureMarker(await adapter.read(path));
  } catch {
    return null;
  }
}

async function readMetaTolerant(adapter: DataAdapter, path: string) {
  try {
    return parseSnapshotMeta(await adapter.read(path));
  } catch {
    return null;
  }
}

/** Live FailedItem kinds map onto materialized-source kinds ("nonMd" ↔ "file"). */
function liveFailureMatches(failure: FailedItem, kind: MaterializedSourceType): boolean {
  if (kind === "file") return failure.type === "nonMd";
  return failure.type === kind;
}

const IN_FLIGHT_PHASES = new Set<AgentProjectContextLoadState["phase"]>([
  "resolve",
  "prefetch",
  "parse",
]);

/**
 * Build the panel's item list. `savedKeys` holds `${kind}:${source}` for every
 * source in the PERSISTED project config — a draft-only addition can't be
 * "processing" (no run knows about it yet), so it stays Queued until saved.
 */
export function buildAgentProcessingItems(
  sources: AgentProcessingSource[],
  liveEntry: AgentProjectContextLoadState | undefined,
  disk: AgentCacheDirState | undefined,
  savedKeys: ReadonlySet<string>
): ProcessingItem[] {
  const running = liveEntry !== undefined && IN_FLIGHT_PHASES.has(liveEntry.phase);
  const liveFailures = liveEntry?.failedSources ?? [];
  const retrying = liveEntry?.retryingSources ?? EMPTY_RETRYING_SOURCES;

  return sources.map(({ kind, source, fingerprint }) => {
    const key = `${kind}:${source}`;
    let status: ProcessingItem["status"] = "pending";
    let error: string | undefined;

    const live = liveFailures.find((f) => f.path === source && liveFailureMatches(f, kind));
    const snapshotName = cacheFileName(kind, source);
    const hasSnapshot = disk?.snapshotNames.has(snapshotName) ?? false;
    const marker = disk?.markersByName.get(failureMarkerName(kind, source));
    const isRetrying = retrying.some((r) => r.kind === kind && r.source === source);

    if (isRetrying && savedKeys.has(key)) {
      // Optimistic: this source's per-source retry is in flight — show the
      // spinner immediately so the click has feedback even if it fails again.
      status = "processing";
    } else if (live && !live.usedStaleSnapshot) {
      status = "failed";
      error = live.error;
    } else if (live?.usedStaleSnapshot) {
      // A stale-but-usable live failure counts as converted (context is present).
      status = "ready";
    } else if (hasSnapshot) {
      // A file snapshot is only trustworthy when its stored `mtime:size` still
      // matches the live file; a missing/unparseable fingerprint can't prove the
      // snapshot is current, so fall back to Queued rather than assert Converted.
      // URL snapshots are identity-fingerprinted (the name proves freshness).
      const stored = disk?.fingerprintsByName.get(snapshotName);
      const fileSnapshotCurrent =
        kind !== "file" || (stored !== undefined && stored === fingerprint);
      status = fileSnapshotCurrent ? "ready" : "pending";
    } else if (marker) {
      status = "failed";
      error = marker.error;
    } else if (running && savedKeys.has(key)) {
      status = "processing";
    }

    return {
      // Envelope (id/name/source/fileType) is shared with the CAG adapter so the
      // two produce structurally identical items; `id` is the raw URL / vault
      // path, which the shared ProcessingStatus row renders for URLs and the
      // modal's remove handler matches by (cacheKind, id).
      ...processingItemEnvelope(kind, source),
      status,
      ...(error !== undefined ? { error } : {}),
    };
  });
}
