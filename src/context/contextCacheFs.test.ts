import type { App } from "obsidian";
import { createVaultContextCacheFs } from "./contextCacheFs";

/** Minimal controllable vault adapter stub for the cache fs boundary. */
function makeAdapter(over: Partial<Record<string, jest.Mock>> = {}) {
  return {
    exists: jest.fn().mockResolvedValue(false),
    mkdir: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
    read: jest.fn().mockResolvedValue(""),
    write: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    ...over,
  };
}

function fsFor(adapter: ReturnType<typeof makeAdapter>) {
  const app = { vault: { adapter } } as unknown as App;
  return createVaultContextCacheFs(app);
}

describe("createVaultContextCacheFs", () => {
  it("maps exists/read/write onto the adapter with normalized paths", async () => {
    const adapter = makeAdapter({
      exists: jest.fn().mockResolvedValue(true),
      read: jest.fn().mockResolvedValue("body"),
    });
    const fs = fsFor(adapter);

    expect(await fs.exists("Proj/.context-cache/web-1.md")).toBe(true);
    expect(adapter.exists).toHaveBeenCalledWith("Proj/.context-cache/web-1.md");

    expect(await fs.readText("Proj/.context-cache/web-1.md")).toBe("body");
    await fs.writeText("Proj/.context-cache/web-1.md", "out");
    expect(adapter.write).toHaveBeenCalledWith("Proj/.context-cache/web-1.md", "out");
  });

  it("strips leading/trailing slashes before hitting the adapter", async () => {
    const adapter = makeAdapter();
    const fs = fsFor(adapter);
    await fs.writeText("/Proj/.context-cache/file-1.md/", "x");
    expect(adapter.write).toHaveBeenCalledWith("Proj/.context-cache/file-1.md", "x");
  });

  it("rejects a path with a `..` segment before touching the adapter", async () => {
    const adapter = makeAdapter();
    const fs = fsFor(adapter);
    await expect(fs.writeText("Proj/../../etc/evil", "x")).rejects.toThrow('".." segment');
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it("list returns entry basenames, not the adapter's full vault-relative paths", async () => {
    const adapter = makeAdapter({
      list: jest.fn().mockResolvedValue({
        files: ["Proj/.context-cache/web-1.md", "Proj/.context-cache/failed-web-2.json"],
        folders: ["Proj/.context-cache/nested"],
      }),
    });
    const fs = fsFor(adapter);
    expect(await fs.list("Proj/.context-cache")).toEqual([
      "web-1.md",
      "failed-web-2.json",
      "nested",
    ]);
  });

  it("list returns [] when the directory is missing", async () => {
    const adapter = makeAdapter({
      list: jest.fn().mockRejectedValue(new Error("ENOENT: no such file")),
    });
    const fs = fsFor(adapter);
    expect(await fs.list("Proj/.context-cache")).toEqual([]);
  });

  it("mkdirRecursive creates each missing ancestor segment in order", async () => {
    const adapter = makeAdapter(); // exists → false for all
    const fs = fsFor(adapter);
    await fs.mkdirRecursive("Proj/.context-cache");
    expect(adapter.mkdir.mock.calls.map((c) => String(c[0]))).toEqual([
      "Proj",
      "Proj/.context-cache",
    ]);
  });

  it("mkdirRecursive skips segments that already exist", async () => {
    const adapter = makeAdapter({
      exists: jest.fn().mockImplementation(async (p: string) => p === "Proj"),
    });
    const fs = fsFor(adapter);
    await fs.mkdirRecursive("Proj/.context-cache");
    expect(adapter.mkdir.mock.calls.map((c) => String(c[0]))).toEqual(["Proj/.context-cache"]);
  });

  it("remove swallows a missing-file error (idempotent)", async () => {
    const adapter = makeAdapter({
      remove: jest.fn().mockRejectedValue(new Error("File not found")),
    });
    const fs = fsFor(adapter);
    await expect(fs.remove("Proj/.context-cache/web-1.md")).resolves.toBeUndefined();
  });

  it("remove rethrows a non-missing error", async () => {
    const adapter = makeAdapter({
      remove: jest.fn().mockRejectedValue(new Error("EACCES: permission denied")),
    });
    const fs = fsFor(adapter);
    await expect(fs.remove("Proj/.context-cache/web-1.md")).rejects.toThrow("EACCES");
  });
});
