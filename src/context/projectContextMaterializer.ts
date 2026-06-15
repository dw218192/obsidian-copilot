import { BrevilabsClient } from "@/LLMProviders/brevilabsClient";
import { err2String } from "@/errorFormat";
import { logInfo, logWarn } from "@/logger";
import { getCachedProjectRecordById } from "@/projects/state";
import { getProjectContextSignature } from "@/projects/projectContextSignature";
import { getMatchingPatterns } from "@/search/searchUtils";
import { listMaterializeCandidates } from "@/context/materializeCandidates";
import { App, FileSystemAdapter, normalizePath, TFile, TFolder } from "obsidian";
import { createVaultContextCacheFs } from "./contextCacheFs";
import {
  CONTEXT_CACHE_DIR,
  materializeSources,
  reconcileCache,
  type ContextConverters,
  type FileSource,
  type MaterializedSourceType,
  type RemoteSource,
  type SourceFailure,
} from "./contextCacheStore";
import { buildProjectContextBlock, type ManifestPathEntry } from "./manifestBuilder";

/**
 * Plain-data result of materializing a project's context before a session opens.
 *
 * This is the shared contract resolved by a session's `contextReady`. Keep it
 * minimal: searchable roots plus the optional inline context block — nothing
 * else. Reason: progress counts for the UI loading card live in a SEPARATE
 * `agentProjectContextLoadAtom`, never here, so this stays a clean dirs+block
 * value that any backend / the UI can consume without folding in load state.
 */
export interface ContextMaterializationResult {
  /** Absolute paths to widen the agent's searchable roots (add-dir). Empty if none. */
  additionalDirectories: string[];
  /**
   * The `<project_context>` block to inline into the session's FIRST user
   * prompt (absolute folder/note paths, snapshot pointers, tag/ext/URL guides).
   * Undefined when the project declares no context sources.
   */
  projectContextBlock?: string;
  /**
   * The context signature of the project record THIS run actually read (see
   * {@link getProjectContextSignature}). Lets a caller tell which source revision
   * was captured — critical because the single-flight guard can hand a joined
   * caller a result materialized from an EARLIER record than the one live now.
   * Undefined only when no record was found, or the whole run threw.
   */
  contextSignature?: string;
}

/**
 * Live progress for the materialization steps, surfaced to the UI loading card.
 * Carried OUT-OF-BAND from {@link ContextMaterializationResult} (counts never
 * fold into the result) so the result stays a clean dirs+block value. The
 * session manager is the sole subscriber and republishes these to the
 * projectId-keyed `agentProjectContextLoadAtom`.
 */
export type ContextMaterializeProgress =
  | { phase: "resolve"; resolved: number }
  | { phase: "prefetch"; done: number; total: number }
  | { phase: "parse"; done: number; total: number }
  | { phase: "failures"; failures: SourceFailure[] };

export type ContextMaterializeProgressFn = (progress: ContextMaterializeProgress) => void;

/** Re-fetch a URL/YouTube source at most once per day (cheap-skip otherwise). */
const REMOTE_TTL_MS = 24 * 60 * 60 * 1000;

// Referential stability: a single frozen empty array for every "no context" exit.
const EMPTY_DIRECTORIES: string[] = Object.freeze([] as string[]) as string[];
/**
 * Frozen fallback result for the "no usable record / whole-run failure" exits —
 * NO `contextSignature`, so it never clears a caller's dirty flag (nothing was
 * captured). A project that resolves to no sources returns a DISTINCT result
 * carrying its signature (so its dirty flag can clear); only the record-absent
 * and catch paths use this shared frozen reference. Exported so the session
 * manager's materialize-failure path hands back the same reference.
 */
export const EMPTY_CONTEXT_MATERIALIZATION_RESULT: ContextMaterializationResult = Object.freeze({
  additionalDirectories: EMPTY_DIRECTORIES,
});
const EMPTY_RESULT = EMPTY_CONTEXT_MATERIALIZATION_RESULT;

/**
 * Per-project single-flight guard. Concurrent cold-start sessions for the same
 * project (e.g. the user opens a second chat / a history-load races the first)
 * would otherwise each miss the disk cheap-skip before the first write lands and
 * redundantly hit brevilabs + race on the same hash-named cache files. The map
 * entry is cleared once the promise settles, so a later call re-evaluates fresh
 * on-disk fingerprints (idempotent). Mirrors `inFlightMigrations`.
 *
 * DESIGN NOTE — keyed by `projectId` ALONE, not `projectId+cwd`. `cwd` is a pure
 * function of `projectId` (`resolveScopeCwd` → `dirname(record.filePath)`), so
 * two concurrent calls for the same project resolve the same cwd. They could
 * diverge only if the project folder is renamed in the sub-second window between
 * two cold-start session opens while a materialize is mid-flight — at which point
 * the joined caller would write to the pre-rename dir. That window is effectively
 * unreachable, the next session (in-flight entry cleared on settle) self-heals to
 * the new cwd, and keying by cwd would weaken the single-flight (the whole point
 * is to dedupe per project). Not worth the extra key. If a future review flags
 * this again, point them at this note.
 */
const inFlightMaterializations = new Map<string, Promise<ContextMaterializationResult>>();

/**
 * Materialize a project's external context (URLs/YouTube/PDFs/images) into a
 * hidden `<cwd>/.context-cache/` dir, build a source manifest, and report any
 * out-of-cwd folder inclusions as extra searchable roots. Called by the session
 * manager at its cwd choke points, after config migration + cwd resolution.
 *
 * Contract (relied on by the manager): NEVER rejects — any failure degrades to a
 * best-effort partial / empty result so session start is never blocked. Cheap on
 * unchanged context (fingerprint + TTL skip; no per-session re-fetch). Concurrent
 * calls for the same project dedupe to one in-flight run. Writes only under
 * `cwd/.context-cache/`.
 */
export async function ensureProjectContextMaterialized(
  app: App,
  projectId: string,
  cwd: string,
  onProgress?: ContextMaterializeProgressFn,
  forceRetryFailed?: boolean
): Promise<ContextMaterializationResult> {
  const existing = inFlightMaterializations.get(projectId);
  // Single-flight: a second concurrent caller joins the in-flight run and its
  // `onProgress` is intentionally dropped — the flight owner's sink already
  // drives the shared progress atom, so every reader still sees live counts.
  // (A manual "Retry" that lands mid-flight therefore joins the running pass and
  // its `forceRetryFailed` is a no-op — acceptable: the UI hides Retry while
  // working, and the in-flight pass is already re-attempting the same sources.)
  if (existing) return existing;

  const promise = runMaterialize(app, projectId, cwd, onProgress, forceRetryFailed).finally(() => {
    inFlightMaterializations.delete(projectId);
  });
  inFlightMaterializations.set(projectId, promise);
  return promise;
}

/**
 * Join any in-flight full materialization for a project (resolves immediately
 * when none is running). A single-source retry writes one snapshot WITHOUT a
 * reconcile pass, but a concurrent full run's `reconcileCache` only keeps sources
 * it marked `present` this round — so it can delete a snapshot the retry wrote
 * after the full run's `materializeSources` finished but before its reconcile
 * listed the dir, silently reverting a successful Retry to failed. Awaiting the
 * in-flight run before writing closes that window: any later full run re-reads
 * and keeps the fresh snapshot.
 */
export function awaitInFlightMaterialization(projectId: string): Promise<unknown> {
  return inFlightMaterializations.get(projectId) ?? Promise.resolve();
}

/**
 * The materialization body, wrapped so it always resolves with a result —
 * `ensureProjectContextMaterialized` adds the single-flight guard on top.
 */
async function runMaterialize(
  app: App,
  projectId: string,
  cwd: string,
  onProgress?: ContextMaterializeProgressFn,
  forceRetryFailed?: boolean
): Promise<ContextMaterializationResult> {
  try {
    const record = getCachedProjectRecordById(projectId);
    if (!record) return EMPTY_RESULT;
    // Captured up front from the record THIS run reads, so the result reports the
    // exact source revision it materialized (the dirty-tracking caller relies on
    // this to avoid clearing a flag a newer edit raised — see the result field).
    const contextSignature = getProjectContextSignature(record);
    const contextSource = record.project.contextSource;
    if (!contextSource) return { additionalDirectories: EMPTY_DIRECTORIES, contextSignature };

    const webUrls = splitLines(contextSource.webUrls);
    const youtubeUrls = splitLines(contextSource.youtubeUrls);
    const remotes: RemoteSource[] = [
      ...webUrls.map((url): RemoteSource => ({ type: "web", url })),
      ...youtubeUrls.map((url): RemoteSource => ({ type: "youtube", url })),
    ];

    const { inclusions } = getMatchingPatterns({
      inclusions: contextSource.inclusions,
      exclusions: contextSource.exclusions,
      isProject: true,
    });
    const folders = inclusions?.folderPatterns ?? [];
    const notes = inclusions?.notePatterns ?? [];
    const extensions = inclusions?.extensionPatterns ?? [];
    const tags = inclusions?.tagPatterns ?? [];

    const adapter = getVaultFileSystemAdapter(app);
    const { entries: folderEntries, additionalDirectories } = resolveFolderPaths(
      app,
      folders,
      cwd,
      adapter
    );
    const noteEntries = resolveNotePaths(app, notes, adapter);

    const files: FileSource[] = inclusions
      ? listMaterializeCandidates(app, contextSource).map((file) => ({
          vaultPath: file.path,
          ext: file.extension.toLowerCase(),
          mtime: file.stat.mtime,
          size: file.stat.size,
          read: () => app.vault.readBinary(file),
        }))
      : [];

    const hasAnySource =
      remotes.length > 0 ||
      files.length > 0 ||
      folders.length > 0 ||
      notes.length > 0 ||
      extensions.length > 0 ||
      tags.length > 0 ||
      additionalDirectories.length > 0;
    if (!hasAnySource) return { additionalDirectories: EMPTY_DIRECTORIES, contextSignature };

    // Inclusions are resolved; report the count of binary files queued for
    // materialization so the loading card can show "Resolve files (N)".
    onProgress?.({ phase: "resolve", resolved: files.length });

    // The cache is written through the vault adapter, so its dir is vault-relative
    // and derived from the project record (the authoritative vault-relative source)
    // — not from the absolute `cwd`, which is only used for the add-dir in/out check.
    const cacheDir = joinVaultPath(getProjectFolderPath(record.filePath), CONTEXT_CACHE_DIR);
    const fs = createVaultContextCacheFs(app);

    const { entries, wantedFileNames, failures } = await materializeSources({
      cacheDir,
      fs,
      converters: createConverters(),
      remotes,
      files,
      nowMs: Date.now(),
      ttlMs: REMOTE_TTL_MS,
      forceRetryFailed,
      onProgress,
    });

    // Surface per-source failures out-of-band (never folded into the result, which
    // stays a clean dirs+block value). Always emitted — an empty array clears any
    // prior run's failures in the subscriber.
    onProgress?.({ phase: "failures", failures });

    const projectContextBlock = buildProjectContextBlock({
      folders: folderEntries,
      notes: noteEntries,
      extensions,
      tags,
      webUrls,
      youtubeUrls,
      materialized: entries,
    });
    // No manifest file is written: the block above is inlined into the session's
    // first user prompt. `reconcileCache` still runs to prune stale snapshots and
    // delete any `CONTEXT.md` left by a prior version.
    await reconcileCache(fs, cacheDir, wantedFileNames);

    logInfo(
      `[project-context] materialized ${entries.length} source(s) for ${projectId}; ` +
        `add-dir=${additionalDirectories.length}, failures=${failures.length}`
    );

    return {
      additionalDirectories:
        additionalDirectories.length > 0 ? additionalDirectories : EMPTY_DIRECTORIES,
      projectContextBlock,
      contextSignature,
    };
  } catch (err) {
    // A failure HERE (not a per-source fetch/parse error, which never throws) is a
    // whole-materialization breakdown: cache fs, reconcile, or block builder. Keep
    // the never-reject contract, but surface it as a single synthetic failure so
    // the status icon can still flag "context unavailable" with a readable cause.
    const error = err2String(err);
    logWarn(`[project-context] materialize failed for ${projectId}; continuing`, err);
    onProgress?.({
      phase: "failures",
      failures: [{ source: "Project context", kind: "file", error, usedStaleSnapshot: false }],
    });
    return EMPTY_RESULT;
  }
}

/** Brevilabs-backed converters. Empty results throw so no useless cache file is written. */
function createConverters(): ContextConverters {
  return {
    fetchRemote: async (source) => {
      const client = BrevilabsClient.getInstance();
      const content =
        source.type === "youtube"
          ? ((await client.youtube4llm(source.url)).response?.transcript ?? "")
          : ((await client.url4llm(source.url)).response ?? "");
      if (!content.trim()) throw new Error(`empty content for ${source.url}`);
      return content;
    },
    parseFile: async (bytes, ext) => {
      const { response } = await BrevilabsClient.getInstance().docs4llm(bytes, ext);
      const content = docs4llmToText(response);
      if (!content.trim()) throw new Error(`empty parse result for .${ext}`);
      return content;
    },
  };
}

/**
 * Re-materialize a SINGLE context source — the per-row "Retry" in the Content
 * Conversion panel. Reuses the same cache dir / converters as the full run but
 * skips reconcile: it only (re)writes this one source's snapshot or failure
 * marker (materializeSources clears the marker on success), leaving every other
 * source untouched. Returns this source's failures (empty on success). Never
 * throws, mirroring the full run's contract.
 */
export async function materializeProjectContextSource(
  app: App,
  projectId: string,
  item: { kind: MaterializedSourceType; source: string }
): Promise<SourceFailure[]> {
  const record = getCachedProjectRecordById(projectId);
  if (!record) {
    return [
      {
        source: item.source,
        kind: item.kind,
        error: "Project not found",
        usedStaleSnapshot: false,
      },
    ];
  }

  const cacheDir = joinVaultPath(getProjectFolderPath(record.filePath), CONTEXT_CACHE_DIR);
  const fs = createVaultContextCacheFs(app);

  let remotes: RemoteSource[] = [];
  let files: FileSource[] = [];
  if (item.kind === "file") {
    const file = app.vault.getAbstractFileByPath(item.source);
    if (!(file instanceof TFile)) {
      return [
        {
          source: item.source,
          kind: "file",
          error: "File not found in vault",
          usedStaleSnapshot: false,
        },
      ];
    }
    files = [
      {
        vaultPath: file.path,
        ext: file.extension.toLowerCase(),
        mtime: file.stat.mtime,
        size: file.stat.size,
        read: () => app.vault.readBinary(file),
      },
    ];
  } else {
    remotes = [{ type: item.kind, url: item.source }];
  }

  try {
    const { failures } = await materializeSources({
      cacheDir,
      fs,
      converters: createConverters(),
      remotes,
      files,
      nowMs: Date.now(),
      ttlMs: REMOTE_TTL_MS,
      forceRetryFailed: true,
    });
    return failures;
  } catch (err) {
    return [
      { source: item.source, kind: item.kind, error: err2String(err), usedStaleSnapshot: false },
    ];
  }
}

/** docs4llm's `response` is `unknown` — normalize to text for the cache file. */
function docs4llmToText(response: unknown): string {
  if (typeof response === "string") return response;
  try {
    return JSON.stringify(response, null, 2);
  } catch (err) {
    logWarn(`[project-context] could not stringify docs4llm response: ${err2String(err)}`);
    return "";
  }
}

/**
 * The desktop disk-backed adapter, or null otherwise. Used to turn vault paths
 * into absolute OS paths (`getFullPath`) for the agent backend's searchable
 * roots; a non-disk adapter (mobile / in-memory) degrades to vault-path-only
 * manifest entries with no add-dir.
 */
function getVaultFileSystemAdapter(app: App): FileSystemAdapter | null {
  const adapter = app.vault.adapter;
  return adapter instanceof FileSystemAdapter ? adapter : null;
}

/**
 * Resolve folder inclusions to absolute `ManifestPathEntry`s for the context
 * block, and collect the subset that lives OUTSIDE the project cwd as add-dir
 * roots. In-cwd folders need no add-dir (already searchable); a pattern that
 * doesn't resolve to a real folder (e.g. a glob) is still listed in the block by
 * its vault path, just without an absolute path / add-dir entry.
 */
function resolveFolderPaths(
  app: App,
  folderPatterns: string[],
  cwd: string,
  adapter: FileSystemAdapter | null
): { entries: ManifestPathEntry[]; additionalDirectories: string[] } {
  const entries: ManifestPathEntry[] = [];
  const external = new Set<string>();
  for (const pattern of folderPatterns) {
    const vaultPath = pattern.replace(/\/+$/, "");
    const folder = app.vault.getAbstractFileByPath(vaultPath);
    if (adapter && folder instanceof TFolder) {
      const abs = adapter.getFullPath(folder.path);
      entries.push({ vaultPath, absPath: abs });
      if (!isUnderCwd(cwd, abs)) external.add(abs);
    } else {
      entries.push({ vaultPath });
    }
  }
  return {
    entries,
    additionalDirectories: external.size > 0 ? [...external] : EMPTY_DIRECTORIES,
  };
}

/**
 * Resolve `[[Title]]` note inclusions to absolute `ManifestPathEntry`s. The
 * title is matched against file basenames, mirroring how `searchUtils`'
 * `matchFilePathWithNotes` pairs a note pattern to a vault file — so a title
 * shared by several notes lists EVERY match (matching the inclusion semantics),
 * not just the first. A pattern with no matching file is still listed by its raw
 * `[[Title]]` form so the source is never dropped.
 */
function resolveNotePaths(
  app: App,
  notePatterns: string[],
  adapter: FileSystemAdapter | null
): ManifestPathEntry[] {
  if (notePatterns.length === 0) return [];
  const files = adapter ? app.vault.getFiles() : [];
  return notePatterns.flatMap((pattern) => {
    // categorizePatterns guarantees the `[[ ... ]]` shape, so slicing is safe.
    const title = pattern.slice(2, -2);
    if (!adapter) return [{ vaultPath: pattern }];
    const matches = files.filter((file) => file.basename === title);
    if (matches.length === 0) return [{ vaultPath: pattern }];
    return matches.map((file) => ({
      vaultPath: file.path,
      absPath: adapter.getFullPath(file.path),
    }));
  });
}

/**
 * Whether an absolute path lives at or under the session cwd. Compared on
 * forward-slash-normalized strings (not `node:path`) so it holds regardless of
 * the OS separator `getFullPath`/cwd report — folders already inside the cwd
 * need no add-dir root; only the rest become searchable-root entries.
 */
function isUnderCwd(cwd: string, abs: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm(cwd);
  const target = norm(abs);
  return target === base || target.startsWith(`${base}/`);
}

/** Vault-relative folder a project's config file sits in (`""` at vault root). */
function getProjectFolderPath(projectConfigPath: string): string {
  const normalized = normalizePath(projectConfigPath).replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "" : normalized.slice(0, idx);
}

/** Join a child segment onto a vault-relative dir (POSIX, no `node:path`). */
function joinVaultPath(dir: string, name: string): string {
  const left = dir.replace(/\/+$/, "");
  return normalizePath(left ? `${left}/${name}` : name);
}

/** Split a newline-joined config string into trimmed, non-empty entries. */
function splitLines(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
