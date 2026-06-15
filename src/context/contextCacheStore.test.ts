import { join } from "node:path";
import type { ContextCacheFs } from "./contextCacheFs";
import {
  MANIFEST_FILE_NAME,
  materializeSources,
  reconcileCache,
  type ContextConverters,
  type FileSource,
  type MaterializeProgress,
  type RemoteSource,
} from "./contextCacheStore";

/** Minimal in-memory {@link ContextCacheFs} for deterministic, network-free tests. */
function memFs(seed: Record<string, string> = {}): ContextCacheFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    async exists(p) {
      return files.has(p);
    },
    async mkdirRecursive() {
      // no-op: the flat map needs no directories
    },
    async list(dir) {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .filter((name) => !name.includes("/"));
    },
    async readText(p) {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    async writeText(p, content) {
      files.set(p, content);
    },
    async remove(p) {
      files.delete(p);
    },
  };
}

const CACHE_DIR = "/vault/Proj/.context-cache";
const TTL = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function converters(overrides: Partial<ContextConverters> = {}): ContextConverters {
  return {
    fetchRemote: jest.fn(async (s: RemoteSource) => `content for ${s.url}`),
    parseFile: jest.fn(async (_bytes: ArrayBuffer, ext: string) => `parsed ${ext}`),
    ...overrides,
  };
}

function fileSource(over: Partial<FileSource> = {}): FileSource {
  return {
    vaultPath: "Proj/doc.pdf",
    ext: "pdf",
    mtime: 1000,
    size: 50,
    read: jest.fn(async () => new ArrayBuffer(8)),
    ...over,
  };
}

describe("materializeSources", () => {
  it("writes a cache file per source with metadata and returns entries", async () => {
    const fs = memFs();
    const remotes: RemoteSource[] = [
      { type: "web", url: "https://a.com" },
      { type: "youtube", url: "https://youtu.be/x" },
    ];
    const { entries, wantedFileNames } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: converters(),
      remotes,
      files: [fileSource()],
      nowMs: T0,
      ttlMs: TTL,
    });

    expect(entries).toHaveLength(3);
    // The manifest file is no longer written, so it's never seeded as "wanted".
    expect(wantedFileNames.has(MANIFEST_FILE_NAME)).toBe(false);
    // Three source files all live under the cache dir.
    const written = [...fs.files.keys()];
    expect(written.every((p) => p.startsWith(`${CACHE_DIR}/`))).toBe(true);

    const webEntry = entries.find((e) => e.type === "web")!;
    const body = fs.files.get(join(CACHE_DIR, webEntry.cacheFileName))!;
    expect(body).toContain("copilot-context-cache");
    expect(body).toContain('"sourceUrl":"https://a.com"');
    expect(body).toContain("content for https://a.com");
  });

  it("cheap-skips unchanged sources within TTL (no re-fetch / re-parse)", async () => {
    const fs = memFs();
    const conv = converters();
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    const file = fileSource();

    await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: conv,
      remotes,
      files: [file],
      nowMs: T0,
      ttlMs: TTL,
    });
    // Second pass, same fingerprint, still inside TTL.
    await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: conv,
      remotes,
      files: [file],
      nowMs: T0 + TTL / 2,
      ttlMs: TTL,
    });

    expect(conv.fetchRemote).toHaveBeenCalledTimes(1);
    expect(conv.parseFile).toHaveBeenCalledTimes(1);
  });

  it("re-fetches a remote after its TTL expires", async () => {
    const fs = memFs();
    const conv = converters();
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];

    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes, files: [], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes, files: [], nowMs: T0 + TTL + 1, ttlMs: TTL }); // prettier-ignore

    expect(conv.fetchRemote).toHaveBeenCalledTimes(2);
  });

  it("re-parses a file when its mtime/size fingerprint changes", async () => {
    const fs = memFs();
    const conv = converters();

    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes: [], files: [fileSource({ mtime: 1000, size: 50 })], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes: [], files: [fileSource({ mtime: 2000, size: 50 })], nowMs: T0, ttlMs: TTL }); // prettier-ignore

    expect(conv.parseFile).toHaveBeenCalledTimes(2);
  });

  it("keeps the stale snapshot when a re-fetch fails", async () => {
    const fs = memFs();
    const good = converters();
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: good, remotes, files: [], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    const fileName = [...fs.files.keys()].find((k) => k.includes("web-"))!;
    const staleBody = fs.files.get(fileName)!;

    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("network down");
      }),
    });
    const { entries, failures } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: failing,
      remotes,
      files: [],
      nowMs: T0 + TTL + 1, // force a refetch attempt
      ttlMs: TTL,
    });

    expect(failing.fetchRemote).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1); // stale entry still counts as present
    expect(fs.files.get(fileName)).toBe(staleBody); // content untouched
    // A kept-stale source is a failure flagged as still-usable (no missing source).
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: "https://a.com", kind: "web", usedStaleSnapshot: true }); // prettier-ignore
    expect(failures[0].error).toContain("network down");
    // No negative marker is written when a stale snapshot remains usable.
    expect([...fs.files.keys()].some((k) => k.includes("failed-"))).toBe(false);
  });

  it("skips a brand-new source whose fetch fails (no file written) and records a failure", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { entries, failures, wantedFileNames } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: failing,
      remotes: [{ type: "web", url: "https://a.com" }],
      files: [],
      nowMs: T0,
      ttlMs: TTL,
    });

    expect(entries).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: "https://a.com", kind: "web", usedStaleSnapshot: false }); // prettier-ignore
    expect(failures[0].error).toContain("boom");
    // A negative marker IS written for a missing source, and it is wanted so a
    // same-run reconcile keeps it.
    const marker = [...fs.files.keys()].find((k) => k.includes("failed-web-"))!;
    expect(marker).toBeDefined();
    expect(wantedFileNames.has(marker.slice(`${CACHE_DIR}/`.length))).toBe(true);
  });

  it("negative-cache skips a known-bad source within TTL (no re-fetch)", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    // Second run within TTL: should NOT re-fetch, but still report the failure.
    const { failures } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: failing,
      remotes,
      files: [],
      nowMs: T0 + TTL / 2,
      ttlMs: TTL,
    });

    expect(failing.fetchRemote).toHaveBeenCalledTimes(1); // skipped on the 2nd run
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: "https://a.com", kind: "web", usedStaleSnapshot: false }); // prettier-ignore
    expect(failures[0].error).toContain("boom");
  });

  it("keeps the negative marker wanted on a TTL skip so reconcile can't delete it", async () => {
    // Regression: the skip path must still mark the existing marker wanted.
    // Production reconciles every run; without this the marker is deleted the
    // same run it's honored, collapsing the 24h TTL to a single run.
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    const markerKey = [...fs.files.keys()].find((k) => k.includes("failed-web-"))!;
    expect(markerKey).toBeDefined();

    // Second run within TTL (the skip path), then reconcile as production does.
    const { wantedFileNames } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: failing,
      remotes,
      files: [],
      nowMs: T0 + TTL / 2,
      ttlMs: TTL,
    });
    expect(wantedFileNames.has(markerKey.slice(`${CACHE_DIR}/`.length))).toBe(true);
    await reconcileCache(fs, CACHE_DIR, wantedFileNames);
    expect(fs.files.has(markerKey)).toBe(true); // survived — TTL still in force
  });

  it("re-attempts a known-bad source after the failure TTL expires", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0 + TTL + 1, ttlMs: TTL }); // prettier-ignore

    expect(failing.fetchRemote).toHaveBeenCalledTimes(2);
  });

  it("re-attempts a failed file within TTL once its mtime:size changes", async () => {
    // A file negative marker is keyed to the fingerprint at failure time; editing
    // the file (new mtime:size) must re-attempt parsing, not stay skipped.
    const fs = memFs();
    const failing = converters({
      parseFile: jest.fn(async () => {
        throw new Error("bad parse");
      }),
    });
    const first = fileSource({ mtime: 1000, size: 50 });
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [first], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    expect(failing.parseFile).toHaveBeenCalledTimes(1);

    // Unchanged file within TTL → skipped.
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [first], nowMs: T0 + 1, ttlMs: TTL }); // prettier-ignore
    expect(failing.parseFile).toHaveBeenCalledTimes(1);

    // Edited file (new mtime:size) within TTL → re-attempted despite the marker.
    const edited = fileSource({ mtime: 2000, size: 99 });
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [edited], nowMs: T0 + 2, ttlMs: TTL }); // prettier-ignore
    expect(failing.parseFile).toHaveBeenCalledTimes(2);
  });

  it("forceRetryFailed re-attempts a known-bad source within TTL", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0 + 1, ttlMs: TTL, forceRetryFailed: true }); // prettier-ignore

    expect(failing.fetchRemote).toHaveBeenCalledTimes(2); // forced despite fresh marker
  });

  it("clears the negative marker once a previously-failed source succeeds", async () => {
    const fs = memFs();
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0, ttlMs: TTL }); // prettier-ignore
    expect([...fs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);

    // A forced retry that now succeeds must remove the marker and write the entry.
    const { entries, failures } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: converters(),
      remotes,
      files: [],
      nowMs: T0 + 1,
      ttlMs: TTL,
      forceRetryFailed: true,
    });
    expect(entries).toHaveLength(1);
    expect(failures).toHaveLength(0);
    expect([...fs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(false);
  });

  it("skips a brand-new source whose fetch fails (no file written)", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { entries } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: failing,
      remotes: [{ type: "web", url: "https://a.com" }],
      files: [],
      nowMs: T0,
      ttlMs: TTL,
    });

    expect(entries).toHaveLength(0);
    // The only file is the negative marker (no `.md` snapshot).
    expect([...fs.files.keys()].every((k) => k.includes("failed-web-"))).toBe(true);
  });

  it("deduplicates repeated sources to a single cache file", async () => {
    const fs = memFs();
    const conv = converters();
    await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: conv,
      remotes: [
        { type: "web", url: "https://a.com" },
        { type: "web", url: "https://a.com" },
      ],
      files: [],
      nowMs: T0,
      ttlMs: TTL,
    });
    expect(conv.fetchRemote).toHaveBeenCalledTimes(1);
    expect([...fs.files.keys()]).toHaveLength(1);
  });

  it("emits per-item onProgress for each loop with deduped totals", async () => {
    const fs = memFs();
    const progress: MaterializeProgress[] = [];
    await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: converters(),
      remotes: [
        { type: "web", url: "https://a.com" },
        { type: "web", url: "https://a.com" }, // duplicate → deduped to total 1
        { type: "youtube", url: "https://youtu.be/x" },
      ],
      files: [fileSource()],
      nowMs: T0,
      ttlMs: TTL,
      onProgress: (p) => progress.push(p),
    });

    // Prefetch: 0/2 seed then 1/2, 2/2 (the duplicate collapsed into total 2).
    expect(progress.filter((p) => p.phase === "prefetch")).toEqual([
      { phase: "prefetch", done: 0, total: 2 },
      { phase: "prefetch", done: 1, total: 2 },
      { phase: "prefetch", done: 2, total: 2 },
    ]);
    // Parse: 0/1 seed then 1/1.
    expect(progress.filter((p) => p.phase === "parse")).toEqual([
      { phase: "parse", done: 0, total: 1 },
      { phase: "parse", done: 1, total: 1 },
    ]);
  });

  it("omits onProgress for an empty loop", async () => {
    const fs = memFs();
    const progress: MaterializeProgress[] = [];
    await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: converters(),
      remotes: [{ type: "web", url: "https://a.com" }],
      files: [],
      nowMs: T0,
      ttlMs: TTL,
      onProgress: (p) => progress.push(p),
    });
    expect(progress.some((p) => p.phase === "parse")).toBe(false);
  });
});

describe("reconcileCache", () => {
  it("deletes obsolete owned files (incl. a legacy CONTEXT.md) but preserves unknown files", async () => {
    const fs = memFs({
      [join(CACHE_DIR, "web-deadbeef0001.md")]: "obsolete",
      [join(CACHE_DIR, "file-cafe0002.md")]: "wanted",
      [join(CACHE_DIR, MANIFEST_FILE_NAME)]: "# manifest",
      [join(CACHE_DIR, "user-notes.md")]: "not ours",
    });
    // CONTEXT.md is no longer wanted — the block is inline in the prompt now.
    const wanted = new Set(["file-cafe0002.md"]);

    await reconcileCache(fs, CACHE_DIR, wanted);

    expect(fs.files.has(join(CACHE_DIR, "web-deadbeef0001.md"))).toBe(false);
    expect(fs.files.has(join(CACHE_DIR, "file-cafe0002.md"))).toBe(true);
    // A leftover CONTEXT.md from a prior version is now reconciled away.
    expect(fs.files.has(join(CACHE_DIR, MANIFEST_FILE_NAME))).toBe(false);
    expect(fs.files.has(join(CACHE_DIR, "user-notes.md"))).toBe(true);
  });
});
