import { err2String } from "@/errorFormat";
import { logWarn } from "@/logger";
import type { ContextCacheFs } from "./contextCacheFs";

/** Source kinds that get materialized into `.context-cache/` as text snapshots. */
export type MaterializedSourceType = "web" | "youtube" | "file";

/** A URL or YouTube link to fetch via brevilabs primitives. */
export interface RemoteSource {
  type: "web" | "youtube";
  /** The configured URL — also the cache key and fingerprint basis. */
  url: string;
}

/** An in-vault binary file (PDF/image/doc) to parse into searchable text. */
export interface FileSource {
  /** Vault-relative path (the user-facing source identity). */
  vaultPath: string;
  /** Lowercased extension passed to the parser. */
  ext: string;
  /** Cheap change signal — no read required to compute. */
  mtime: number;
  size: number;
  /** Lazily reads the file's bytes (only invoked when a (re)parse is needed). */
  read: () => Promise<ArrayBuffer>;
}

/** Brevilabs-backed converters, injected so the core stays network-free in tests. */
export interface ContextConverters {
  fetchRemote: (source: RemoteSource) => Promise<string>;
  parseFile: (bytes: ArrayBuffer, ext: string) => Promise<string>;
}

/** One successfully-present cache file (fresh or kept-stale), for the manifest. */
export interface MaterializedEntry {
  type: MaterializedSourceType;
  /** Original source (URL or vault path). */
  source: string;
  /** Path of the cache file relative to `.context-cache/`. */
  cacheFileName: string;
}

/**
 * A source that failed to fetch/parse during materialization. The run still
 * completes (the session degrades gracefully); these are surfaced to the status
 * icon + popover so the failure is diagnosable. `usedStaleSnapshot` distinguishes
 * "refresh failed but a previous snapshot is still in use" (context available,
 * just stale) from "no snapshot at all, source is missing".
 */
export interface SourceFailure {
  source: string;
  kind: MaterializedSourceType;
  error: string;
  usedStaleSnapshot: boolean;
}

/**
 * Per-item progress for the two materialization loops, emitted as work lands.
 * `done` counts completed items (0 at loop start), `total` the deduped count for
 * that loop. Consumed by the UI loading card via a separate progress atom — it
 * is never folded into the materialization RESULT.
 */
export interface MaterializeProgress {
  phase: "prefetch" | "parse";
  done: number;
  total: number;
}

export interface MaterializeSourcesInput {
  cacheDir: string;
  fs: ContextCacheFs;
  converters: ContextConverters;
  remotes: RemoteSource[];
  files: FileSource[];
  /** Current wall-clock (ms) — injected for deterministic TTL tests. */
  nowMs: number;
  /** Re-fetch a remote source only after this many ms have elapsed. */
  ttlMs: number;
  /**
   * Suppress the negative-cache skip: re-attempt every source even if it failed
   * within {@link ttlMs}. Set by the manual "Retry" action so a user can force a
   * re-fetch before the failure TTL elapses.
   */
  forceRetryFailed?: boolean;
  /** Optional progress sink, fired per item as each loop advances. */
  onProgress?: (progress: MaterializeProgress) => void;
}

export interface MaterializeSourcesResult {
  entries: MaterializedEntry[];
  /** Cache file names that belong to current sources (reconcile keeps these). */
  wantedFileNames: Set<string>;
  /** Sources that failed to fetch/parse this run (empty when all succeeded). */
  failures: SourceFailure[];
}

/** Metadata block persisted at the top of every cache file. */
export interface CacheEntryMeta {
  sourceType: MaterializedSourceType;
  /** Origin URL for web/youtube snapshots. */
  sourceUrl?: string;
  /** Vault path for in-vault file snapshots. */
  sourcePath?: string;
  fetchedAt: string;
  contentHash: string;
  /** Cheap-skip key: identity for remotes, `mtime:size` for files. */
  fingerprint: string;
}

const META_OPEN = "<!-- copilot-context-cache";
const META_CLOSE = "-->";
export const MANIFEST_FILE_NAME = "CONTEXT.md";

/** Hidden, Obsidian-ignored dir under a project folder (the agent still greps
 * it) holding the materialized text snapshots + failure markers this store
 * owns. Shared by the materializer (writer) and the edit modal's Content
 * Conversion panel (read-only). */
export const CONTEXT_CACHE_DIR = ".context-cache";

/**
 * Persisted negative-cache marker: a source that failed to fetch/parse with NO
 * usable snapshot. Lets a later run cheap-skip a known-bad source within the TTL
 * instead of re-hitting brevilabs (and re-incurring the latency) on every new
 * chat. A `.json` file — never `.md` — so the agent never greps a failure marker
 * as if it were materialized context. Cleared when the source later succeeds.
 */
export interface FailureMarker {
  source: string;
  kind: MaterializedSourceType;
  error: string;
  failedAt: number;
  /**
   * The source's `mtime:size` fingerprint at failure time (file kind only).
   * The TTL skip is honored only while this still matches the live file, so
   * editing/replacing a failed file re-attempts it immediately rather than
   * staying skipped until the TTL elapses — mirroring the snapshot path's
   * fingerprint check. Absent for remotes (identity-fingerprinted) and for
   * markers written before this field existed (treated as "still matches").
   */
  fingerprint?: string;
}

/**
 * Materialize every configured source into `cacheDir`, skipping any whose
 * fingerprint is unchanged (and, for remotes, still within TTL). A fetch/parse
 * failure never throws: an existing stale file is kept, otherwise the source is
 * skipped and a negative-cache marker is written so the next run can cheap-skip
 * it within the TTL (unless `forceRetryFailed`). Returns the present entries, the
 * set of wanted file names (cache files + live failure markers, so reconcile
 * keeps them), and the per-source failures for this run.
 */
export async function materializeSources(
  input: MaterializeSourcesInput
): Promise<MaterializeSourcesResult> {
  const { cacheDir, fs, converters, nowMs, ttlMs, forceRetryFailed, onProgress } = input;
  await fs.mkdirRecursive(cacheDir);

  const entries: MaterializedEntry[] = [];
  const failures: SourceFailure[] = [];
  // No manifest seed: the project context is delivered inline in the first user
  // prompt now (no `.context-cache/CONTEXT.md`). Leaving it out of the wanted set
  // lets `reconcileCache` delete any CONTEXT.md a prior version wrote.
  const wantedFileNames = new Set<string>();

  // Dedupe up front so the emitted totals match the actual work performed.
  const remotes = dedupeBy(input.remotes, (r) => `${r.type}:${r.url}`);
  const files = dedupeBy(input.files, (f) => f.vaultPath);

  // Sequential per source: brevilabs calls are rate-limited and steady-state is
  // a no-op (cheap-skip), so wall-clock only matters on the rare cold prefetch.
  if (remotes.length > 0) onProgress?.({ phase: "prefetch", done: 0, total: remotes.length });
  for (let i = 0; i < remotes.length; i++) {
    const remote = remotes[i];
    const fileName = cacheFileName(remote.type, remote.url);
    const markerName = failureMarkerName(remote.type, remote.url);
    const result = await upsertRemote(
      cacheDir,
      fileName,
      markerName,
      remote,
      converters,
      fs,
      nowMs,
      ttlMs,
      forceRetryFailed ?? false
    );
    if (result.present) {
      wantedFileNames.add(fileName);
      entries.push({ type: remote.type, source: remote.url, cacheFileName: fileName });
    }
    if (result.failure) {
      failures.push(result.failure);
      // The marker belongs to a still-configured source: keep it (reconcile
      // would otherwise delete it the same run we wrote/honored it).
      if (result.markerWanted) wantedFileNames.add(markerName);
    }
    onProgress?.({ phase: "prefetch", done: i + 1, total: remotes.length });
  }

  if (files.length > 0) onProgress?.({ phase: "parse", done: 0, total: files.length });
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileName = cacheFileName("file", file.vaultPath);
    const markerName = failureMarkerName("file", file.vaultPath);
    const result = await upsertFile(
      cacheDir,
      fileName,
      markerName,
      file,
      converters,
      fs,
      nowMs,
      ttlMs,
      forceRetryFailed ?? false
    );
    if (result.present) {
      wantedFileNames.add(fileName);
      entries.push({ type: "file", source: file.vaultPath, cacheFileName: fileName });
    }
    if (result.failure) {
      failures.push(result.failure);
      if (result.markerWanted) wantedFileNames.add(markerName);
    }
    onProgress?.({ phase: "parse", done: i + 1, total: files.length });
  }

  return { entries, wantedFileNames, failures };
}

/** Outcome of an upsert: whether a usable snapshot is present, and any failure. */
interface UpsertResult {
  present: boolean;
  failure?: SourceFailure;
  /**
   * True when a negative marker for this source exists on disk after the upsert
   * (freshly written this run, OR pre-existing and honored on a TTL skip). The
   * caller adds it to `wantedFileNames` so the same-run `reconcileCache` doesn't
   * delete it — otherwise the TTL would only ever survive a single run.
   */
  markerWanted?: boolean;
}

async function upsertRemote(
  cacheDir: string,
  fileName: string,
  markerName: string,
  remote: RemoteSource,
  converters: ContextConverters,
  fs: ContextCacheFs,
  nowMs: number,
  ttlMs: number,
  forceRetryFailed: boolean
): Promise<UpsertResult> {
  const filePath = joinCachePath(cacheDir, fileName);
  const markerPath = joinCachePath(cacheDir, markerName);
  const existing = await readMeta(fs, filePath);
  const fingerprint = `${remote.type}:${remote.url}`;
  const fresh =
    existing !== null &&
    existing.fingerprint === fingerprint &&
    nowMs - Date.parse(existing.fetchedAt) < ttlMs;
  if (fresh) return { present: true };

  // Negative-cache skip: a recent failure with no snapshot. Skip the re-fetch
  // (avoid re-paying the latency every chat) and re-surface the prior failure,
  // unless the user forced a retry.
  if (!forceRetryFailed && existing === null) {
    const marker = await readFailureMarker(fs, markerPath);
    if (marker !== null && nowMs - marker.failedAt < ttlMs) {
      return {
        present: false,
        failure: { source: remote.url, kind: remote.type, error: marker.error, usedStaleSnapshot: false }, // prettier-ignore
        markerWanted: true, // honor the existing marker — keep it past reconcile
      };
    }
  }

  try {
    const content = await converters.fetchRemote(remote);
    await writeEntry(fs, filePath, remote.type, remote.url, fingerprint, content, nowMs);
    await fs.remove(markerPath); // success clears any prior negative marker
    return { present: true };
  } catch (err) {
    const error = err2String(err);
    logWarn(`[project-context] fetch failed for ${remote.url}: ${error}`);
    const usedStaleSnapshot = existing !== null;
    // Only write a negative marker when there is NO snapshot to fall back on;
    // a stale snapshot is still usable, so its source is not "missing".
    let markerWanted = false;
    if (!usedStaleSnapshot) {
      await writeFailureMarker(fs, markerPath, remote.url, remote.type, error, nowMs);
      markerWanted = true;
    }
    return {
      present: usedStaleSnapshot,
      failure: { source: remote.url, kind: remote.type, error, usedStaleSnapshot },
      markerWanted,
    };
  }
}

async function upsertFile(
  cacheDir: string,
  fileName: string,
  markerName: string,
  file: FileSource,
  converters: ContextConverters,
  fs: ContextCacheFs,
  nowMs: number,
  ttlMs: number,
  forceRetryFailed: boolean
): Promise<UpsertResult> {
  const filePath = joinCachePath(cacheDir, fileName);
  const markerPath = joinCachePath(cacheDir, markerName);
  const existing = await readMeta(fs, filePath);
  const fingerprint = `${file.mtime}:${file.size}`;
  if (existing !== null && existing.fingerprint === fingerprint) return { present: true };

  // Negative-cache skip: a recent parse failure with no snapshot — but only
  // while the file is unchanged. A different `mtime:size` than the marker
  // recorded means the file was edited/replaced, so re-attempt instead of
  // honoring the stale failure (parity with the snapshot fingerprint check).
  if (!forceRetryFailed && existing === null) {
    const marker = await readFailureMarker(fs, markerPath);
    const fingerprintStillMatches = marker?.fingerprint === undefined || marker.fingerprint === fingerprint; // prettier-ignore
    if (marker !== null && nowMs - marker.failedAt < ttlMs && fingerprintStillMatches) {
      return {
        present: false,
        failure: { source: file.vaultPath, kind: "file", error: marker.error, usedStaleSnapshot: false }, // prettier-ignore
        markerWanted: true, // honor the existing marker — keep it past reconcile
      };
    }
  }

  try {
    const content = await converters.parseFile(await file.read(), file.ext);
    await writeEntry(fs, filePath, "file", file.vaultPath, fingerprint, content, nowMs);
    await fs.remove(markerPath);
    return { present: true };
  } catch (err) {
    const error = err2String(err);
    logWarn(`[project-context] parse failed for ${file.vaultPath}: ${error}`);
    const usedStaleSnapshot = existing !== null;
    let markerWanted = false;
    if (!usedStaleSnapshot) {
      await writeFailureMarker(fs, markerPath, file.vaultPath, "file", error, nowMs, fingerprint);
      markerWanted = true;
    }
    return {
      present: usedStaleSnapshot,
      failure: { source: file.vaultPath, kind: "file", error, usedStaleSnapshot },
      markerWanted,
    };
  }
}

/**
 * Delete cache files we own that are no longer referenced by the current config
 * (our `<type>-<hash>.md` snapshots, plus a legacy `CONTEXT.md` manifest from
 * versions that wrote one — context is inline in the prompt now). Unrecognized
 * files (e.g. a user's own notes) are always preserved.
 */
export async function reconcileCache(
  fs: ContextCacheFs,
  cacheDir: string,
  wantedFileNames: Set<string>
): Promise<void> {
  const present = await fs.list(cacheDir);
  for (const name of present) {
    if (wantedFileNames.has(name)) continue;
    if (!isOwnedCacheFile(name)) continue;
    await fs.remove(joinCachePath(cacheDir, name));
  }
}

/**
 * Join a cache-relative file name onto the cache dir. Cache paths are always
 * vault-relative and POSIX-separated, so a plain "/" join (no `node:path`) is
 * correct on every platform and keeps this module Node-builtin-free.
 */
function joinCachePath(dir: string, name: string): string {
  const left = dir.replace(/\/+$/, "");
  const right = name.replace(/^\/+/, "");
  return left ? `${left}/${right}` : right;
}

/**
 * Owned by us, safe to reconcile: a `<type>-<hash>.md` snapshot, a
 * `failed-<type>-<hash>.json` negative marker, or the legacy `CONTEXT.md`
 * manifest (no longer written — see {@link reconcileCache}).
 */
function isOwnedCacheFile(name: string): boolean {
  return (
    name === MANIFEST_FILE_NAME ||
    /^(web|youtube|file)-[0-9a-f]+\.md$/.test(name) ||
    /^failed-(web|youtube|file)-[0-9a-f]+\.json$/.test(name)
  );
}

/**
 * Deterministic snapshot file name for a source. Exported (with
 * {@link failureMarkerName}) so read-only consumers — the edit modal's Content
 * Conversion panel — can probe a cache dir for a source's persisted state by
 * name alone, without parsing file contents.
 */
export function cacheFileName(type: MaterializedSourceType, source: string): string {
  return `${type}-${stableHash(source)}.md`;
}

/** Negative-cache marker name for a source (parallel to {@link cacheFileName}). */
export function failureMarkerName(type: MaterializedSourceType, source: string): string {
  return `failed-${type}-${stableHash(source)}.json`;
}

async function writeFailureMarker(
  fs: ContextCacheFs,
  markerPath: string,
  source: string,
  kind: MaterializedSourceType,
  error: string,
  nowMs: number,
  fingerprint?: string
): Promise<void> {
  const marker: FailureMarker = { source, kind, error, failedAt: nowMs, ...(fingerprint !== undefined ? { fingerprint } : {}) }; // prettier-ignore
  await fs.writeText(markerPath, JSON.stringify(marker));
}

async function readFailureMarker(
  fs: ContextCacheFs,
  markerPath: string
): Promise<FailureMarker | null> {
  let raw: string;
  try {
    raw = await fs.readText(markerPath);
  } catch {
    return null;
  }
  return parseFailureMarker(raw);
}

/**
 * Tolerant parse of a failure marker's JSON content (null on any malformation).
 * Exported for read-only consumers that fetch the bytes themselves (the edit
 * modal reads via the vault adapter rather than {@link ContextCacheFs}).
 *
 * DESIGN NOTE: `kind` is type-checked as a string but NOT validated against the
 * `FailureMarker["kind"]` union. These markers are written only by this module
 * (never user-authored), so a value outside the union can't arise on the real
 * path; the downstream panel renders an unknown kind harmlessly as a generic
 * failure. Tightening to a union whitelist would only guard a hand-corrupted
 * cache file, which has no real caller. If a future review flags this again,
 * point them at this note.
 */
export function parseFailureMarker(raw: string): FailureMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FailureMarker>;
    if (
      typeof parsed.source !== "string" ||
      typeof parsed.kind !== "string" ||
      typeof parsed.error !== "string" ||
      typeof parsed.failedAt !== "number"
    ) {
      return null;
    }
    return parsed as FailureMarker;
  } catch {
    return null;
  }
}

async function writeEntry(
  fs: ContextCacheFs,
  filePath: string,
  sourceType: MaterializedSourceType,
  source: string,
  fingerprint: string,
  content: string,
  nowMs: number
): Promise<void> {
  const fetchedAt = new Date(nowMs).toISOString();
  const meta: CacheEntryMeta = {
    sourceType,
    ...(sourceType === "file" ? { sourcePath: source } : { sourceUrl: source }),
    fetchedAt,
    contentHash: stableHash(content),
    fingerprint,
  };
  const body = content.trim();
  const text =
    `${META_OPEN}\n${JSON.stringify(meta)}\n${META_CLOSE}\n\n` +
    `# ${sourceType === "file" ? "File" : sourceType === "youtube" ? "YouTube" : "URL"}: ${source}\n` +
    `_Materialized ${fetchedAt} — snapshot; refresh if the source changed._\n\n` +
    `${body}\n`;
  await fs.writeText(filePath, text);
}

async function readMeta(fs: ContextCacheFs, filePath: string): Promise<CacheEntryMeta | null> {
  let raw: string;
  try {
    raw = await fs.readText(filePath);
  } catch {
    return null;
  }
  return parseSnapshotMeta(raw);
}

/**
 * Tolerant parse of a snapshot file's leading meta block (null on any
 * malformation). Exported for read-only consumers that fetch the bytes
 * themselves — the edit modal compares a file snapshot's stored `fingerprint`
 * against the live `mtime:size` to detect a stale conversion.
 */
export function parseSnapshotMeta(raw: string): CacheEntryMeta | null {
  if (!raw.startsWith(META_OPEN)) return null;
  const close = raw.indexOf(META_CLOSE);
  if (close < 0) return null;
  const json = raw.slice(META_OPEN.length, close).trim();
  try {
    const parsed = JSON.parse(json) as Partial<CacheEntryMeta>;
    const hasSource = Boolean(parsed.sourceUrl ?? parsed.sourcePath);
    if (!parsed.sourceType || !hasSource || !parsed.fetchedAt || !parsed.fingerprint) {
      return null;
    }
    return parsed as CacheEntryMeta;
  } catch {
    return null;
  }
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * cyrb53 — a fast, well-distributed non-cryptographic string hash. Used only to
 * derive stable cache file names and a cheap content-change signal; collision
 * resistance across a project's handful of sources is more than sufficient, and
 * it keeps this module dependency- and `node:crypto`-free (so fully pure for
 * tests). Source: bryc, https://stackoverflow.com/a/52171480.
 */
function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}
