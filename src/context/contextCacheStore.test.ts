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
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

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

  it("cheap-skips an unchanged successful source indefinitely (no re-fetch / re-parse)", async () => {
    const fs = memFs();
    const conv = converters();
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    const file = fileSource();

    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes, files: [file], nowMs: T0 }); // prettier-ignore
    // Second pass far in the future: a successful snapshot has no TTL, so its
    // identity / fingerprint match still cheap-skips both the fetch and parse.
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes, files: [file], nowMs: T0 + 365 * DAY }); // prettier-ignore

    expect(conv.fetchRemote).toHaveBeenCalledTimes(1);
    expect(conv.parseFile).toHaveBeenCalledTimes(1);
  });

  it("stamps the cache schema version into written snapshots", async () => {
    const fs = memFs();
    const { entries } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: converters(),
      remotes: [{ type: "web", url: "https://a.com" }],
      files: [],
      nowMs: T0,
    });
    expect(fs.files.get(join(CACHE_DIR, entries[0].cacheFileName))!).toContain('"schemaVersion":1');
  });

  it("re-materializes a snapshot whose schema version no longer matches (not cheap-skipped)", async () => {
    const fs = memFs();
    const conv = converters();
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];

    const { entries } = await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes, files: [], nowMs: T0 }); // prettier-ignore
    // Simulate a future format change: an on-disk snapshot from a different
    // schema version. The version gate must treat it as a miss, not cheap-skip.
    const key = join(CACHE_DIR, entries[0].cacheFileName);
    fs.files.set(key, fs.files.get(key)!.replace('"schemaVersion":1', '"schemaVersion":999'));

    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes, files: [], nowMs: T0 + DAY }); // prettier-ignore

    expect(conv.fetchRemote).toHaveBeenCalledTimes(2); // re-fetched, not skipped
  });

  it("re-parses a file when its mtime/size fingerprint changes", async () => {
    const fs = memFs();
    const conv = converters();

    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes: [], files: [fileSource({ mtime: 1000, size: 50 })], nowMs: T0 }); // prettier-ignore
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes: [], files: [fileSource({ mtime: 2000, size: 50 })], nowMs: T0 }); // prettier-ignore

    expect(conv.parseFile).toHaveBeenCalledTimes(2);
  });

  it("keeps a stale file snapshot when a re-parse fails", async () => {
    // Files are the kind whose fingerprint (`mtime:size`) routinely changes, so
    // they are the practical way to reach the "kept-stale on re-fetch failure"
    // path: a successful remote snapshot matches its identity fingerprint and is
    // cheap-skipped, so it normally never re-fetches (a mismatched/legacy remote
    // snapshot could still reach this path, but that's the rare edge, not the norm).
    const fs = memFs();
    const good = converters();
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: good, remotes: [], files: [fileSource({ mtime: 1000, size: 50 })], nowMs: T0 }); // prettier-ignore
    const fileName = [...fs.files.keys()].find((k) => k.includes("file-"))!;
    const staleBody = fs.files.get(fileName)!;

    const failing = converters({
      parseFile: jest.fn(async () => {
        throw new Error("bad parse");
      }),
    });
    const { entries, failures } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: failing,
      remotes: [],
      files: [fileSource({ mtime: 2000, size: 99 })], // edited → re-parse attempted
      nowMs: T0 + 1,
    });

    expect(failing.parseFile).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1); // stale entry still counts as present
    expect(fs.files.get(fileName)).toBe(staleBody); // content untouched
    // A kept-stale source is a failure flagged as still-usable (no missing source).
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: "Proj/doc.pdf", kind: "file", usedStaleSnapshot: true }); // prettier-ignore
    expect(failures[0].error).toContain("bad parse");
    // No failure marker is written when a stale snapshot remains usable.
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
    });

    expect(entries).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: "https://a.com", kind: "web", usedStaleSnapshot: false }); // prettier-ignore
    expect(failures[0].error).toContain("boom");
    // A failure marker IS written for a missing source, and it is wanted so a
    // same-run reconcile keeps it (the status panel reads it to surface the error).
    const marker = [...fs.files.keys()].find((k) => k.includes("failed-web-"))!;
    expect(marker).toBeDefined();
    expect(wantedFileNames.has(marker.slice(`${CACHE_DIR}/`.length))).toBe(true);
  });

  it("cheap-skips a known-bad remote on the next automatic run (no re-fetch) but still surfaces it", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0 }); // prettier-ignore
    // Second automatic run: the failure marker is honored — no second fetch — yet
    // the failure is still reported (and its marker kept) so the panel surfaces it.
    const { failures, wantedFileNames } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: failing,
      remotes,
      files: [],
      nowMs: T0 + 1,
    });

    expect(failing.fetchRemote).toHaveBeenCalledTimes(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: "https://a.com", kind: "web", usedStaleSnapshot: false }); // prettier-ignore
    expect(failures[0].error).toContain("boom");
    const markerKey = [...fs.files.keys()].find((k) => k.includes("failed-web-"))!;
    expect(wantedFileNames.has(markerKey.slice(`${CACHE_DIR}/`.length))).toBe(true);
  });

  it("emits no itemStart/itemFailed for a cheap-skipped failed source", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0 }); // prettier-ignore
    const events: MaterializeProgress[] = [];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0 + 1, onProgress: (p) => events.push(p) }); // prettier-ignore
    // The cheap-skip is silent (symmetric with a successful cheap-skip): no
    // per-source lifecycle events, only the step-count progress.
    expect(events.some((p) => p.phase.startsWith("item"))).toBe(false);
  });

  it("re-fetches a known-bad remote when forceRetryFailed is set", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0 }); // prettier-ignore
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0 + 1, forceRetryFailed: true }); // prettier-ignore

    expect(failing.fetchRemote).toHaveBeenCalledTimes(2);
  });

  it("cheap-skips a known-bad file on the next automatic run while unchanged", async () => {
    const fs = memFs();
    const failing = converters({
      parseFile: jest.fn(async () => {
        throw new Error("bad parse");
      }),
    });
    const file = fileSource({ mtime: 1000, size: 50 });
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [file], nowMs: T0 }); // prettier-ignore
    const { failures } = await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [file], nowMs: T0 + 1 }); // prettier-ignore

    expect(failing.parseFile).toHaveBeenCalledTimes(1); // marker honored, no re-parse
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: "Proj/doc.pdf", kind: "file", usedStaleSnapshot: false }); // prettier-ignore
  });

  it("re-parses a known-bad file when its mtime/size fingerprint changes (marker stale)", async () => {
    const fs = memFs();
    const failing = converters({
      parseFile: jest.fn(async () => {
        throw new Error("bad parse");
      }),
    });
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [fileSource({ mtime: 1000, size: 50 })], nowMs: T0 }); // prettier-ignore
    // The file was edited (new mtime/size) after it failed: the marker's
    // fingerprint no longer matches, so it's re-attempted rather than skipped.
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [fileSource({ mtime: 2000, size: 99 })], nowMs: T0 + 1 }); // prettier-ignore

    expect(failing.parseFile).toHaveBeenCalledTimes(2);
  });

  it("re-parses a known-bad file when its marker predates the fingerprint field", async () => {
    const fs = memFs();
    const failing = converters({
      parseFile: jest.fn(async () => {
        throw new Error("bad parse");
      }),
    });
    const file = fileSource({ mtime: 1000, size: 50 });
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [file], nowMs: T0 }); // prettier-ignore
    // Simulate a legacy marker written before Option D: strip the fingerprint.
    const markerKey = [...fs.files.keys()].find((k) => k.includes("failed-file-"))!;
    const legacy = JSON.parse(fs.files.get(markerKey)!) as Record<string, unknown>;
    delete legacy.fingerprint;
    fs.files.set(markerKey, JSON.stringify(legacy));

    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [file], nowMs: T0 + 1 }); // prettier-ignore
    // A marker with no fingerprint is untrustworthy → re-attempt once, not skip.
    expect(failing.parseFile).toHaveBeenCalledTimes(2);
  });

  it("does not honor a failure marker while a stale snapshot still exists (existing !== null wins)", async () => {
    // A successful parse leaves a snapshot. A later edit + failed re-parse keeps
    // that stale snapshot AND writes no marker, so the source stays present and
    // is re-attempted whenever its fingerprint changes — the marker cheap-skip
    // path is gated on `existing === null` and never reached here.
    const fs = memFs();
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: converters(), remotes: [], files: [fileSource({ mtime: 1000, size: 50 })], nowMs: T0 }); // prettier-ignore
    const failing = converters({
      parseFile: jest.fn(async () => {
        throw new Error("bad parse");
      }),
    });
    const { entries, failures } = await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [], files: [fileSource({ mtime: 2000, size: 99 })], nowMs: T0 + 1 }); // prettier-ignore

    expect(failing.parseFile).toHaveBeenCalledTimes(1); // re-attempted, not marker-skipped
    expect(entries).toHaveLength(1); // stale snapshot still present
    expect(failures[0]).toMatchObject({ usedStaleSnapshot: true });
    expect([...fs.files.keys()].some((k) => k.includes("failed-"))).toBe(false);
  });

  it("keeps a newly-written failure marker wanted so a same-run reconcile can't delete it", async () => {
    // Production reconciles every run; the marker must be in `wantedFileNames`
    // the run it's written, or reconcile would delete it before the status panel
    // can read it.
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    const { wantedFileNames } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: failing,
      remotes,
      files: [],
      nowMs: T0,
    });
    const markerKey = [...fs.files.keys()].find((k) => k.includes("failed-web-"))!;
    expect(markerKey).toBeDefined();
    expect(wantedFileNames.has(markerKey.slice(`${CACHE_DIR}/`.length))).toBe(true);
    await reconcileCache(fs, CACHE_DIR, wantedFileNames);
    expect(fs.files.has(markerKey)).toBe(true); // survived the reconcile
  });

  it("clears the failure marker once a previously-failed source succeeds", async () => {
    const fs = memFs();
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes, files: [], nowMs: T0 }); // prettier-ignore
    expect([...fs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);

    // A forced retry re-attempts the known-bad remote (the automatic path would
    // cheap-skip it); now it succeeds, removing the marker and writing the entry.
    const { entries, failures } = await materializeSources({
      cacheDir: CACHE_DIR,
      fs,
      converters: converters(),
      remotes,
      files: [],
      nowMs: T0 + 1,
      forceRetryFailed: true,
    });
    expect(entries).toHaveLength(1);
    expect(failures).toHaveLength(0);
    expect([...fs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(false);
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

  it("emits itemStart/itemSettled only for sources that do work (cheap-skips stay silent)", async () => {
    const fs = memFs();
    const conv = converters();
    const remotes: RemoteSource[] = [{ type: "web", url: "https://a.com" }];
    const first: MaterializeProgress[] = [];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes, files: [], nowMs: T0, onProgress: (p) => first.push(p) }); // prettier-ignore
    expect(first.filter((p) => p.phase === "itemStart")).toEqual([
      { phase: "itemStart", item: { kind: "web", source: "https://a.com" } },
    ]);
    expect(first.some((p) => p.phase === "itemSettled")).toBe(true);

    // Second pass: the fresh snapshot cheap-skips, so no lifecycle events fire.
    const second: MaterializeProgress[] = [];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes, files: [], nowMs: T0 + 1, onProgress: (p) => second.push(p) }); // prettier-ignore
    expect(second.some((p) => p.phase.startsWith("item"))).toBe(false);
  });

  it("emits itemFailed (carrying the error) for a failed source, never itemSettled", async () => {
    const fs = memFs();
    const failing = converters({
      fetchRemote: jest.fn(async () => {
        throw new Error("boom");
      }),
    });
    const events: MaterializeProgress[] = [];
    await materializeSources({ cacheDir: CACHE_DIR, fs, converters: failing, remotes: [{ type: "web", url: "https://a.com" }], files: [], nowMs: T0, onProgress: (p) => events.push(p) }); // prettier-ignore
    expect(events.filter((p) => p.phase.startsWith("item")).map((p) => p.phase)).toEqual([
      "itemStart",
      "itemFailed",
    ]);
    const failed = events.find((p) => p.phase === "itemFailed");
    expect(failed?.phase).toBe("itemFailed");
    if (failed?.phase === "itemFailed") {
      expect(failed.item).toEqual({ kind: "web", source: "https://a.com" });
      expect(failed.failure.error).toContain("boom");
    }
  });

  it("fetches URLs in parallel — both are in flight before either settles", async () => {
    const fs = memFs();
    const gates: Record<string, () => void> = {};
    const inFlight: string[] = [];
    const conv = converters({
      fetchRemote: jest.fn(async (s: RemoteSource) => {
        inFlight.push(s.url);
        await new Promise<void>((resolve) => {
          gates[s.url] = resolve;
        });
        return `content ${s.url}`;
      }),
    });
    const done = materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes: [{ type: "web", url: "https://a.com" }, { type: "web", url: "https://b.com" }], files: [], nowMs: T0 }); // prettier-ignore
    // Flush microtasks so both tasks reach their (gated) fetch await.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(new Set(inFlight)).toEqual(new Set(["https://a.com", "https://b.com"]));
    gates["https://a.com"]();
    gates["https://b.com"]();
    await done;
  });

  it("isolates a marker-write failure to its own source — the parallel run still resolves", async () => {
    // A's fetch fails AND writing its failure marker also throws (full/locked
    // disk) while B is still in flight. Pre-fix this rejected the remotes'
    // `Promise.all` mid-run, so B's late progress could re-block an
    // already-settled atom. Now A degrades to a per-source failure
    // (lifecycle-paired: itemStart → itemFailed, never itemSettled) and the
    // still-running B finishes untouched, with prefetch reaching 2/2.
    const fs = memFs();
    // memFs's writeText closes over `files` (no `this`), so capturing it plainly
    // and calling it unbound is safe — we just gate the failure-marker path.
    const writeText = fs.writeText;
    fs.writeText = async (p: string, content: string) => {
      if (p.includes("failed-")) throw new Error("disk full");
      await writeText(p, content);
    };
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const conv = converters({
      fetchRemote: jest.fn(async (s: RemoteSource) => {
        if (s.url === "https://a.com") throw new Error("net down");
        await bGate; // keep B in flight until A has already failed its marker write
        return `content ${s.url}`;
      }),
    });
    const events: MaterializeProgress[] = [];
    const done = materializeSources({ cacheDir: CACHE_DIR, fs, converters: conv, remotes: [{ type: "web", url: "https://a.com" }, { type: "web", url: "https://b.com" }], files: [], nowMs: T0, onProgress: (p) => events.push(p) }); // prettier-ignore
    // Flush microtasks so A runs through its (throwing) marker write while B waits.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    releaseB();
    const result = await done;

    // The run resolved (no rejection): A is a per-source failure, B an entry.
    expect(result.failures.map((f) => f.source)).toEqual(["https://a.com"]);
    expect(result.entries.map((e) => e.source)).toEqual(["https://b.com"]);

    const itemPhasesFor = (url: string) =>
      events.filter((p) => "item" in p && p.item.source === url).map((p) => p.phase);
    expect(itemPhasesFor("https://a.com")).toEqual(["itemStart", "itemFailed"]);
    expect(itemPhasesFor("https://b.com")).toEqual(["itemStart", "itemSettled"]);
    // Both remote tasks completed their prefetch accounting despite A's throw.
    const prefetch = events.filter((p) => p.phase === "prefetch");
    expect(prefetch[prefetch.length - 1]).toEqual({ phase: "prefetch", done: 2, total: 2 });
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

  it("prunes every materialized source type (incl. youtube snapshots and failure markers)", async () => {
    // Guards the derived owned-file pattern: a regex that only matched web/file
    // would leak youtube orphans. Adding a 4th type must stay covered here too.
    const fs = memFs({
      [join(CACHE_DIR, "youtube-abc0001.md")]: "obsolete",
      [join(CACHE_DIR, "failed-youtube-abc0002.json")]: "{}",
      [join(CACHE_DIR, "keep-me.md")]: "not ours",
    });

    await reconcileCache(fs, CACHE_DIR, new Set());

    expect(fs.files.has(join(CACHE_DIR, "youtube-abc0001.md"))).toBe(false);
    expect(fs.files.has(join(CACHE_DIR, "failed-youtube-abc0002.json"))).toBe(false);
    expect(fs.files.has(join(CACHE_DIR, "keep-me.md"))).toBe(true);
  });
});
