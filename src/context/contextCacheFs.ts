import { isMissingFileError } from "@/utils/isMissingFileError";
import { App, normalizePath } from "obsidian";

/**
 * Minimal filesystem surface the project-context materializer needs. Kept as an
 * injectable interface so the cache logic stays pure and unit-testable with an
 * in-memory fake — Obsidian's vault adapter lives only in
 * {@link createVaultContextCacheFs} at the edge.
 *
 * All paths are **vault-relative**, POSIX-separated (the adapter resolves them
 * against the vault root). Using the adapter — not `node:fs` — keeps this layer
 * free of Node builtins, consistent with the rest of the plugin's storage.
 */
export interface ContextCacheFs {
  exists(path: string): Promise<boolean>;
  mkdirRecursive(path: string): Promise<void>;
  /** Shallow directory listing (entry names only). Returns `[]` when missing. */
  list(path: string): Promise<string[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  /** Idempotent delete — a missing path is not an error. */
  remove(path: string): Promise<void>;
}

/**
 * Production {@link ContextCacheFs} backed by Obsidian's vault adapter. The store
 * wants a tiny fs-like contract, but the adapter's shape differs in three ways
 * this boundary smooths over so the store never has to know:
 *  - `mkdir` is not recursive → create each ancestor segment in turn.
 *  - `list` returns full vault-relative paths → expose entry basenames only, so
 *    the store's name-based reconcile keeps working.
 *  - `remove` rejects on a missing path → swallow that into an idempotent no-op.
 */
export function createVaultContextCacheFs(app: App): ContextCacheFs {
  const adapter = app.vault.adapter;
  return {
    async exists(path) {
      return adapter.exists(normalizeCachePath(path));
    },
    async mkdirRecursive(path) {
      const normalized = normalizeCachePath(path);
      if (!normalized) return;
      let current = "";
      for (const segment of normalized.split("/")) {
        current = current ? `${current}/${segment}` : segment;
        if (await adapter.exists(current)) continue;
        await adapter.mkdir(current);
      }
    },
    async list(path) {
      try {
        const listing = await adapter.list(normalizeCachePath(path));
        return [...listing.files, ...listing.folders].map(basename);
      } catch (error) {
        if (isMissingFileError(error)) return [];
        throw error;
      }
    },
    async readText(path) {
      return adapter.read(normalizeCachePath(path));
    },
    async writeText(path, content) {
      await adapter.write(normalizeCachePath(path), content);
    },
    async remove(path) {
      try {
        await adapter.remove(normalizeCachePath(path));
      } catch (error) {
        if (isMissingFileError(error)) return;
        throw error;
      }
    },
  };
}

/**
 * Strip leading/trailing slashes off a normalized vault-relative path, and
 * reject any `..` segment.
 *
 * Reason: every caller today passes a project-record-derived cache dir plus a
 * hash-named file, so `..` is unreachable in practice — but this is the vault
 * adapter's write/delete boundary for an explicitly injectable interface, and
 * Obsidian's `normalizePath` cleans slashes WITHOUT resolving `..`. A cheap
 * guard here keeps a future caller from escaping the cache dir into arbitrary
 * vault paths. Fails loud rather than silently rewriting, so a real traversal
 * attempt surfaces instead of landing somewhere unexpected-but-in-vault.
 */
function normalizeCachePath(path: string): string {
  const normalized = normalizePath(path).replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized.split("/").includes("..")) {
    throw new Error(`unsafe context-cache path (".." segment): ${path}`);
  }
  return normalized;
}

/** Last path segment of a vault-relative path. */
function basename(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
