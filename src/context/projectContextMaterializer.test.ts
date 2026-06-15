import { FileSystemAdapter, TFolder, type App } from "obsidian";
import type { ContextCacheFs } from "./contextCacheFs";

// In-memory fs injected in place of the vault-adapter-backed cache fs.
let mockFs: ContextCacheFs & { files: Map<string, string> };

jest.mock("./contextCacheFs", () => ({
  createVaultContextCacheFs: () => mockFs,
}));

jest.mock("@/projects/state", () => ({
  getCachedProjectRecordById: jest.fn(),
}));
jest.mock("@/search/searchUtils", () => ({
  getMatchingPatterns: jest.fn(),
  shouldIndexFile: jest.fn(() => true),
}));
jest.mock("@/LLMProviders/brevilabsClient", () => ({
  BrevilabsClient: { getInstance: jest.fn() },
}));

import { BrevilabsClient } from "@/LLMProviders/brevilabsClient";
import { getCachedProjectRecordById } from "@/projects/state";
import { getMatchingPatterns } from "@/search/searchUtils";
import {
  ensureProjectContextMaterialized,
  type ContextMaterializeProgress,
} from "./projectContextMaterializer";

const getRecord = getCachedProjectRecordById as jest.Mock;
const getPatterns = getMatchingPatterns as jest.Mock;
const getClient = BrevilabsClient.getInstance as jest.Mock;

const CWD = "/vault/Proj";
// Cache writes are vault-relative now (adapter-backed), derived from the
// project record's folder (`record.filePath` = "Proj/AGENTS.md" → "Proj"),
// NOT from the absolute cwd. The agent-facing absolute paths still come from
// `getFullPath` and are asserted as `/vault/...` below — unchanged.
const CACHE_DIR = "Proj/.context-cache";

function memFs(): ContextCacheFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    exists: async (p) => files.has(p),
    mkdirRecursive: async () => undefined,
    list: async (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .filter((n) => !n.includes("/"));
    },
    readText: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    writeText: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  };
}

function record(contextSource: Record<string, string | undefined>) {
  return { project: { id: "p1", contextSource }, filePath: "Proj/AGENTS.md", folderName: "Proj" };
}

function patterns(over: Record<string, string[]> = {}) {
  return {
    inclusions: { folderPatterns: [], notePatterns: [], extensionPatterns: [], tagPatterns: [], ...over }, // prettier-ignore
    exclusions: null,
  };
}

function fakeApp(files: Array<{ path: string; ext: string }> = [], folders: string[] = []): App {
  const tfiles = files.map((f) => ({
    path: f.path,
    extension: f.ext,
    basename: f.path
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, ""),
    stat: { mtime: 1000, size: 10 },
  }));
  const folderSet = new Set(folders);
  const FsAdapter = FileSystemAdapter as unknown as new (basePath: string) => FileSystemAdapter;
  const Folder = TFolder as unknown as new (path: string) => TFolder;
  return {
    vault: {
      adapter: new FsAdapter("/vault"),
      getFiles: () => tfiles,
      getAbstractFileByPath: (p: string) => (folderSet.has(p) ? new Folder(p) : null),
      readBinary: jest.fn(async () => new ArrayBuffer(4)),
    },
  } as unknown as App;
}

beforeEach(() => {
  mockFs = memFs();
  jest.clearAllMocks();
  getPatterns.mockReturnValue(patterns());
  getClient.mockReturnValue({
    url4llm: jest.fn(async () => ({ response: "url text" })),
    youtube4llm: jest.fn(async () => ({ response: { transcript: "yt text" } })),
    docs4llm: jest.fn(async () => ({ response: "pdf text" })),
  });
});

describe("ensureProjectContextMaterialized", () => {
  it("returns the frozen empty result when the project is unknown", async () => {
    getRecord.mockReturnValue(undefined);
    const result = await ensureProjectContextMaterialized(fakeApp(), "missing", CWD);
    expect(result.additionalDirectories).toEqual([]);
    expect(result.projectContextBlock).toBeUndefined();
  });

  it("returns empty when the project has no context sources", async () => {
    getRecord.mockReturnValue(record({}));
    const result = await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);
    expect(result.additionalDirectories).toEqual([]);
    expect(result.projectContextBlock).toBeUndefined();
    expect(mockFs.files.size).toBe(0);
  });

  it("materializes a web URL into .context-cache/ and inlines it in the context block", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://example.com" }));
    const result = await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);

    expect(result.projectContextBlock).toContain("<project_context>");
    expect(result.projectContextBlock).toContain("https://example.com");
    // No manifest file is written anymore — context is inline in the prompt.
    expect(mockFs.files.has(`${CACHE_DIR}/CONTEXT.md`)).toBe(false);
    const cacheFile = [...mockFs.files.keys()].find((k) => k.includes("/web-"));
    expect(cacheFile).toBeDefined();
    expect(mockFs.files.get(cacheFile!)).toContain("url text");
  });

  it("deletes a CONTEXT.md left by a prior version", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://example.com" }));
    mockFs.files.set(`${CACHE_DIR}/CONTEXT.md`, "# stale manifest");

    await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);

    expect(mockFs.files.has(`${CACHE_DIR}/CONTEXT.md`)).toBe(false);
  });

  it("reports only out-of-cwd folder inclusions as additional directories", async () => {
    getRecord.mockReturnValue(record({ inclusions: "External,Proj/Sub" }));
    getPatterns.mockReturnValue(patterns({ folderPatterns: ["External", "Proj/Sub"] }));
    const app = fakeApp([], ["External", "Proj/Sub"]);

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    expect(result.additionalDirectories).toEqual(["/vault/External"]);
    // Both folders are listed in the block with absolute paths (add-dir is only
    // for the out-of-cwd one).
    expect(result.projectContextBlock).toContain("`/vault/External`");
    expect(result.projectContextBlock).toContain("`/vault/Proj/Sub`");
  });

  it("lists included notes by absolute path in the context block", async () => {
    getRecord.mockReturnValue(record({ inclusions: "[[Spec]]" }));
    getPatterns.mockReturnValue(patterns({ notePatterns: ["[[Spec]]"] }));
    const app = fakeApp([{ path: "Notes/Spec.md", ext: "md" }]);

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    expect(result.projectContextBlock).toContain("## Included notes");
    expect(result.projectContextBlock).toContain("`/vault/Notes/Spec.md`");
  });

  it("lists every note that shares an inclusion title (basename collision)", async () => {
    getRecord.mockReturnValue(record({ inclusions: "[[Spec]]" }));
    getPatterns.mockReturnValue(patterns({ notePatterns: ["[[Spec]]"] }));
    const app = fakeApp([
      { path: "A/Spec.md", ext: "md" },
      { path: "B/Spec.md", ext: "md" },
    ]);

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    expect(result.projectContextBlock).toContain("`/vault/A/Spec.md`");
    expect(result.projectContextBlock).toContain("`/vault/B/Spec.md`");
  });

  it("materializes in-vault PDFs but ignores markdown files", async () => {
    getRecord.mockReturnValue(record({ inclusions: "Proj" }));
    getPatterns.mockReturnValue(patterns({ folderPatterns: ["Proj"] }));
    const app = fakeApp([
      { path: "Proj/a.pdf", ext: "pdf" },
      { path: "Proj/note.md", ext: "md" },
    ]);

    await ensureProjectContextMaterialized(app, "p1", CWD);

    const client = getClient.mock.results[0].value as { docs4llm: jest.Mock };
    expect(client.docs4llm).toHaveBeenCalledTimes(1); // pdf only, never the .md
    expect([...mockFs.files.keys()].some((k) => k.includes("/file-"))).toBe(true);
  });

  it("reports resolve + per-loop progress through onProgress", async () => {
    getRecord.mockReturnValue(record({ inclusions: "Proj", webUrls: "https://example.com" }));
    getPatterns.mockReturnValue(patterns({ folderPatterns: ["Proj"] }));
    const app = fakeApp([{ path: "Proj/a.pdf", ext: "pdf" }]);

    const progress: ContextMaterializeProgress[] = [];
    await ensureProjectContextMaterialized(app, "p1", CWD, (p) => progress.push(p));

    // Resolve fires first, counting the one materialize-eligible binary file.
    expect(progress[0]).toEqual({ phase: "resolve", resolved: 1 });
    expect(progress).toContainEqual({ phase: "prefetch", done: 1, total: 1 });
    expect(progress).toContainEqual({ phase: "parse", done: 1, total: 1 });
  });

  it("never rejects when a brevilabs fetch fails", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://broken.com" }));
    getClient.mockReturnValue({
      url4llm: jest.fn(async () => {
        throw new Error("network down");
      }),
      youtube4llm: jest.fn(),
      docs4llm: jest.fn(),
    });

    const result = await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);
    // Degrades gracefully: block still built, no cache file, never throws.
    expect(result.projectContextBlock).toContain("https://broken.com");
    expect([...mockFs.files.keys()].some((k) => k.includes("/web-"))).toBe(false);
    // No manifest file is written.
    expect(mockFs.files.has(`${CACHE_DIR}/CONTEXT.md`)).toBe(false);
  });

  it("returns the frozen empty result if a filesystem write throws", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://example.com" }));
    // mkdir is awaited outside the per-source try/catch, so a hard fs failure
    // propagates to the never-reject guard and degrades to the empty result.
    mockFs.mkdirRecursive = jest.fn(async () => {
      throw new Error("EACCES");
    });

    const result = await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);
    expect(result.additionalDirectories).toEqual([]);
    expect(result.projectContextBlock).toBeUndefined();
  });
});

describe("ensureProjectContextMaterialized — single-flight", () => {
  it("dedupes concurrent calls for the same project to one run", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    const app = fakeApp();

    const [r1, r2] = await Promise.all([
      ensureProjectContextMaterialized(app, "p1", CWD),
      ensureProjectContextMaterialized(app, "p1", CWD),
    ]);

    const client = getClient.mock.results[0].value as { url4llm: jest.Mock };
    expect(client.url4llm).toHaveBeenCalledTimes(1); // fetched once, not twice
    expect(r1).toBe(r2); // both awaited the same in-flight promise
  });

  it("does not serialize across different projects", async () => {
    getRecord.mockImplementation(() => record({ webUrls: "https://a.com" }));

    await Promise.all([
      ensureProjectContextMaterialized(fakeApp(), "p1", "/vault/P1"),
      ensureProjectContextMaterialized(fakeApp(), "p2", "/vault/P2"),
    ]);

    const client = getClient.mock.results[0].value as { url4llm: jest.Mock };
    expect(client.url4llm).toHaveBeenCalledTimes(2); // one per project
  });

  it("clears the in-flight entry so a later call re-evaluates fresh state", async () => {
    const app = fakeApp();
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    await ensureProjectContextMaterialized(app, "p1", CWD);

    // After the first run settled, the source changed — a fresh call must run
    // again (not return the prior settled promise) and fetch the new URL.
    getRecord.mockReturnValue(record({ webUrls: "https://b.com" }));
    await ensureProjectContextMaterialized(app, "p1", CWD);

    const client = getClient.mock.results[0].value as { url4llm: jest.Mock };
    expect(client.url4llm).toHaveBeenCalledWith("https://b.com");
    expect(client.url4llm).toHaveBeenCalledTimes(2);
  });
});
