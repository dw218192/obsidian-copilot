import { err2String } from "@/errorFormat";
import { logWarn } from "@/logger";
import type { ContextCacheFs } from "./contextCacheFs";

/** Source kinds that get materialized into `.context-cache/` as text snapshots.
 * The single source of truth — file-name patterns (see {@link isOwnedCacheFile})
 * and other modules' source-kind unions derive from this, so adding a kind here
 * updates them all. */
export const MATERIALIZED_SOURCE_TYPES = ["web", "youtube", "file"] as const;
export type MaterializedSourceType = (typeof MATERIALIZED_SOURCE_TYPES)[number];

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

/** Identity of one source as it moves through the materialization lifecycle. */
export interface MaterializeSourceIdentity {
  kind: MaterializedSourceType;
  source: string;
}

/**
 * Progress for the materialization loops, emitted as work lands. The step counts
 * (`prefetch`/`parse`, `done`/`total`) drive the loading card's progress rows;
 * the per-source lifecycle events drive the popover's live queue — `itemStart`
 * when a source actually begins fetching/parsing (a cheap-skip never starts),
 * then `itemFailed`/`itemSettled` when it lands. All are carried OUT-OF-BAND from
 * the materialization RESULT.
 */
export type MaterializeProgress =
  | { phase: "prefetch" | "parse"; done: number; total: number }
  | { phase: "itemStart"; item: MaterializeSourceIdentity }
  | { phase: "itemFailed"; item: MaterializeSourceIdentity; failure: SourceFailure }
  | { phase: "itemSettled"; item: MaterializeSourceIdentity };

export interface MaterializeSourcesInput {
  cacheDir: string;
  fs: ContextCacheFs;
  converters: ContextConverters;
  remotes: RemoteSource[];
  files: FileSource[];
  /** Current wall-clock (ms) — injected for deterministic snapshot timestamps. */
  nowMs: number;
  /**
   * Re-attempt every failed source even if a persisted failure marker would
   * otherwise cheap-skip it. Default `false` (the automatic path skips known-bad
   * sources); set `true` only by the user-driven "Retry" actions so a manual
   * retry always forces a fresh fetch/parse.
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
  /** Cache format version — readers discard a mismatch as a miss (see {@link CACHE_SCHEMA_VERSION}). */
  schemaVersion: number;
  sourceType: MaterializedSourceType;
  /** Origin URL for web/youtube snapshots. */
  sourceUrl?: string;
  /** Vault path for in-vault file snapshots. */
  sourcePath?: string;
  fetchedAt: string;
  /** Cheap-skip key: identity for remotes, `mtime:size` for files. */
  fingerprint: string;
}

const META_OPEN = "<!-- copilot-context-cache";
const META_CLOSE = "-->";
/**
 * Persisted cache-format version. Bump ONLY when an EXISTING field's semantics
 * change (e.g. the `fingerprint` `mtime:size` format) — readers then treat a
 * mismatch as a cache miss and re-materialize, instead of misreading an old file
 * as fresh. Additive/removed fields are tolerant-parsed and need no bump. The
 * cache is regenerable, so this discards-and-rebuilds rather than migrating
 * (unlike `settingsVersion`, which migrates non-regenerable settings).
 *
 * Exported so tests can stamp a current-version fixture without hardcoding the
 * number (which would silently break them on the next bump).
 */
export const CACHE_SCHEMA_VERSION = 1;
export const MANIFEST_FILE_NAME = "CONTEXT.md";

/** Hidden, Obsidian-ignored dir under a project folder (the agent still greps
 * it) holding the materialized text snapshots + failure markers this store
 * owns. Shared by the materializer (writer) and the edit modal's Content
 * Conversion panel (read-only). */
export const CONTEXT_CACHE_DIR = ".context-cache";

/**
 * Persisted failure marker: a source that failed to fetch/parse with NO usable
 * snapshot. Negative cache — a later automatic run cheap-skips a known-bad
 * source (reading the stored error) instead of re-hitting brevilabs on every new
 * session, until the user forces a retry. A `.json` file — never `.md` — so the
 * agent never greps a failure marker as if it were materialized context. Cleared
 * when the source later succeeds.
 */
export interface FailureMarker {
  /** Cache format version — readers discard a mismatch as a miss (see {@link CACHE_SCHEMA_VERSION}). */
  schemaVersion: number;
  source: string;
  kind: MaterializedSourceType;
  error: string;
  failedAt: number;
  /**
   * The file's `mtime:size` fingerprint at failure time (file kind only). The
   * cheap-skip is honored only while this still matches the live file, so
   * editing/replacing a failed file re-attempts it immediately — mirroring the
   * snapshot path's fingerprint check. Absent for remotes (identity-keyed); a
   * marker written before this field existed is treated as untrustworthy and
   * re-attempted once rather than skipped on stale information.
   */
  fingerprint?: string;
}

/**
 * Materialize every configured source into `cacheDir`, skipping any whose
 * fingerprint is unchanged (a successful snapshot is kept indefinitely). A
 * fetch/parse failure never throws: an existing stale file is kept, otherwise
 * the source is skipped and a failure marker is written. A later automatic run
 * cheap-skips that known-bad source (re-surfacing the stored error) until the
 * file changes or `forceRetryFailed` forces a fresh attempt. Returns the present
 * entries, the set of wanted file names (cache files + live failure markers, so
 * reconcile keeps them), and the per-source failures for this run.
 */
export async function materializeSources(
  input: MaterializeSourcesInput
): Promise<MaterializeSourcesResult> {
  const { cacheDir, fs, converters, nowMs, onProgress } = input;
  const forceRetryFailed = input.forceRetryFailed ?? false;
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

  // URLs are fetched in PARALLEL (matching the legacy CAG cache — `url4llm`
  // calls are independent and each failure is isolated per source); binary files
  // are parsed SEQUENTIALLY (heavier, also matching CAG). Each source emits
  // `itemStart` only when it truly begins work (a cheap-skip stays silent) and
  // `itemFailed`/`itemSettled` when it lands, so the popover renders a live queue.
  if (remotes.length > 0) onProgress?.({ phase: "prefetch", done: 0, total: remotes.length });
  let prefetchDone = 0;
  const remoteResults = await Promise.all(
    remotes.map(async (remote) => {
      const item: MaterializeSourceIdentity = { kind: remote.type, source: remote.url };
      const result = await runWithLifecycle(item, onProgress, (onStart) =>
        upsertRemote(
          cacheDir,
          cacheFileName(remote.type, remote.url),
          failureMarkerName(remote.type, remote.url),
          remote,
          converters,
          fs,
          nowMs,
          forceRetryFailed,
          onStart
        )
      );
      prefetchDone += 1;
      onProgress?.({ phase: "prefetch", done: prefetchDone, total: remotes.length });
      return { remote, result };
    })
  );
  // Fold results in the ORIGINAL order — the parallel tasks above must not race
  // on these shared collections, so the mutation happens here, sequentially.
  for (const { remote, result } of remoteResults) {
    const fileName = cacheFileName(remote.type, remote.url);
    const markerName = failureMarkerName(remote.type, remote.url);
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
  }

  if (files.length > 0) onProgress?.({ phase: "parse", done: 0, total: files.length });
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const item: MaterializeSourceIdentity = { kind: "file", source: file.vaultPath };
    const fileName = cacheFileName("file", file.vaultPath);
    const markerName = failureMarkerName("file", file.vaultPath);
    const result = await runWithLifecycle(item, onProgress, (onStart) =>
      upsertFile(
        cacheDir,
        fileName,
        markerName,
        file,
        converters,
        fs,
        nowMs,
        forceRetryFailed,
        onStart
      )
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

/**
 * Run one source's upsert and emit its lifecycle events. `itemStart` fires only
 * if the upsert actually began work (its `onStart` callback ran — a cheap-skip
 * never calls it, so a cached source stays silent and renders straight to Ready).
 * On settle, a failure emits `itemFailed` (carrying the error), success emits
 * `itemSettled`; both remove the source from the popover's "processing" set.
 *
 * This is the lifecycle OWNER: an upsert that throws (e.g. the failure-marker
 * write itself fails on a full/locked disk) is isolated into a per-source
 * failure rather than propagating. Reason: the remote upserts run under one
 * `Promise.all`, so a single rejection would (a) cancel nothing — sibling
 * sources keep running and their late `onProgress` would re-publish a `blocking`
 * state after the run already settled to `done`, stranding the loading card —
 * and (b) collapse the whole run into the materializer's whole-run catch. A
 * conservative per-source failure keeps the run resolvable and matches the
 * legacy CAG tracker's per-source isolation.
 */
async function runWithLifecycle(
  item: MaterializeSourceIdentity,
  onProgress: ((progress: MaterializeProgress) => void) | undefined,
  run: (onStart: () => void) => Promise<UpsertResult>
): Promise<UpsertResult> {
  let started = false;
  let result: UpsertResult;
  try {
    result = await run(() => {
      started = true;
      onProgress?.({ phase: "itemStart", item });
    });
  } catch (err) {
    // The only path that throws past the upsert's own catch today is the
    // failure-marker write, which runs only when there's no usable snapshot — so
    // `usedStaleSnapshot` is false here. A future throw site that DOES hold a
    // usable stale snapshot should convert its error inside the upsert (with
    // `usedStaleSnapshot: true`) rather than fall through to this default.
    result = {
      present: false,
      failure: {
        source: item.source,
        kind: item.kind,
        error: err2String(err),
        usedStaleSnapshot: false,
      },
    };
  }
  // Only emit a settle event when the source was shown as processing (started);
  // a throw before `onStart` leaves nothing to clear — the final `failures`
  // reconciliation carries it instead.
  if (started) {
    if (result.failure) onProgress?.({ phase: "itemFailed", item, failure: result.failure });
    else onProgress?.({ phase: "itemSettled", item });
  }
  return result;
}

/** Outcome of an upsert: whether a usable snapshot is present, and any failure. */
interface UpsertResult {
  present: boolean;
  failure?: SourceFailure;
  /**
   * True when a failure marker for this source was written this run. The caller
   * adds it to `wantedFileNames` so the same-run `reconcileCache` doesn't delete
   * the marker it just wrote (which the status panel reads to surface the error).
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
  forceRetryFailed: boolean,
  onStart?: () => void
): Promise<UpsertResult> {
  const filePath = joinCachePath(cacheDir, fileName);
  const markerPath = joinCachePath(cacheDir, markerName);
  const existing = await readMeta(fs, filePath);
  const fingerprint = `${remote.type}:${remote.url}`;
  // A successful snapshot is kept indefinitely (identity fingerprint), mirroring
  // the legacy project-context cache: re-fetch only when the source is added or
  // its config changes, never on a timer.
  if (existing !== null && existing.fingerprint === fingerprint) return { present: true };

  // Negative cheap-skip: a prior failure with no usable snapshot. Skip the
  // re-fetch (don't re-pay the latency on every new session) and re-surface the
  // stored error, unless the user forced a retry. The `existing === null` guard
  // keeps the success path above authoritative — a kept-stale snapshot is never
  // treated as a failure to skip. No `onStart` fires, so the source stays out of
  // the live "processing" queue and is carried purely by the failures list.
  if (!forceRetryFailed && existing === null) {
    const marker = await readFailureMarker(fs, markerPath);
    if (marker !== null) {
      return {
        present: false,
        failure: { source: remote.url, kind: remote.type, error: marker.error, usedStaleSnapshot: false }, // prettier-ignore
        markerWanted: true, // honor the existing marker so reconcile keeps it
      };
    }
  }

  try {
    onStart?.(); // about to fetch — surfaces this source as "processing"
    const content = await converters.fetchRemote(remote);
    await writeEntry(fs, filePath, remote.type, remote.url, fingerprint, content, nowMs);
    await fs.remove(markerPath); // success clears any prior failure marker
    return { present: true };
  } catch (err) {
    const error = err2String(err);
    logWarn(`[project-context] fetch failed for ${remote.url}: ${error}`);
    const usedStaleSnapshot = existing !== null;
    // Only write a failure marker when there is NO snapshot to fall back on;
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
  forceRetryFailed: boolean,
  onStart?: () => void
): Promise<UpsertResult> {
  const filePath = joinCachePath(cacheDir, fileName);
  const markerPath = joinCachePath(cacheDir, markerName);
  const existing = await readMeta(fs, filePath);
  const fingerprint = `${file.mtime}:${file.size}`;
  // A parsed snapshot is kept while the file is unchanged; a different
  // `mtime:size` re-parses.
  if (existing !== null && existing.fingerprint === fingerprint) return { present: true };

  // Negative cheap-skip: a prior parse failure with no snapshot — honored only
  // while the file is byte-for-byte unchanged (marker fingerprint matches the
  // live `mtime:size`), so an edited/replaced file re-attempts immediately. A
  // marker without a fingerprint predates this field: treat it as untrustworthy
  // and re-attempt once rather than skip on stale information.
  if (!forceRetryFailed && existing === null) {
    const marker = await readFailureMarker(fs, markerPath);
    if (marker !== null && marker.fingerprint === fingerprint) {
      return {
        present: false,
        failure: { source: file.vaultPath, kind: "file", error: marker.error, usedStaleSnapshot: false }, // prettier-ignore
        markerWanted: true, // honor the existing marker so reconcile keeps it
      };
    }
  }

  try {
    onStart?.(); // about to parse — surfaces this source as "processing"
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
 * `failed-<type>-<hash>.json` failure marker, or the legacy `CONTEXT.md`
 * manifest (no longer written — see {@link reconcileCache}).
 */
// Built from MATERIALIZED_SOURCE_TYPES so a new source kind is pruned by
// `reconcileCache` automatically. The values are plain identifiers, so a bare
// alternation needs no regex escaping.
const SOURCE_TYPE_ALTERNATION = MATERIALIZED_SOURCE_TYPES.join("|");
const OWNED_SNAPSHOT_RE = new RegExp(`^(${SOURCE_TYPE_ALTERNATION})-[0-9a-f]+\\.md$`);
const OWNED_MARKER_RE = new RegExp(`^failed-(${SOURCE_TYPE_ALTERNATION})-[0-9a-f]+\\.json$`);

function isOwnedCacheFile(name: string): boolean {
  return name === MANIFEST_FILE_NAME || OWNED_SNAPSHOT_RE.test(name) || OWNED_MARKER_RE.test(name);
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

/** Failure marker name for a source (parallel to {@link cacheFileName}). */
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
  const marker: FailureMarker = { schemaVersion: CACHE_SCHEMA_VERSION, source, kind, error, failedAt: nowMs, ...(fingerprint !== undefined ? { fingerprint } : {}) }; // prettier-ignore
  await fs.writeText(markerPath, JSON.stringify(marker));
}

/** Read and tolerantly parse a source's failure marker (null when absent/malformed). */
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
    // Version mismatch -> treat as no marker, so the source is re-attempted.
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
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
    schemaVersion: CACHE_SCHEMA_VERSION,
    sourceType,
    ...(sourceType === "file" ? { sourcePath: source } : { sourceUrl: source }),
    fetchedAt,
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
    // Version mismatch -> treat as a miss so the source re-materializes. Note the
    // old snapshot is then NOT used as a stale fallback if the re-fetch fails; on
    // an unreleased format that one-time rebuild is acceptable.
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
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
