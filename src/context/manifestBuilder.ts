import { type MaterializedEntry } from "./contextCacheStore";

/**
 * Hard cap on listed context entries. Past this, the block states how many were
 * omitted and how to find them — never silently truncating (design §4.4.1).
 */
export const MAX_MANIFEST_ENTRIES = 100;

/**
 * A folder/note source resolved for the context block. `absPath` lets the agent
 * reach sources that live OUTSIDE the session cwd (the whole reason the block
 * lists absolute paths); it is absent when the pattern resolves to no on-disk
 * file/folder (e.g. a not-yet-created note, or a glob), in which case the
 * user-facing `vaultPath` is listed so the source is never dropped.
 */
export interface ManifestPathEntry {
  vaultPath: string;
  absPath?: string;
}

/**
 * The user's declared context *sources* — never the files a folder/tag expands
 * to (design §4.1). URLs/YouTube links are always listed even when their fetch
 * failed (the source is still part of the project); a materialized snapshot
 * pointer is appended only when one exists.
 */
export interface ManifestSources {
  folders: ManifestPathEntry[];
  notes: ManifestPathEntry[];
  extensions: string[];
  tags: string[];
  webUrls: string[];
  youtubeUrls: string[];
  /** Present cache files, used to resolve snapshot pointers + list file snapshots. */
  materialized: MaterializedEntry[];
}

interface ManifestLine {
  /** Section heading the line belongs under. */
  section: string;
  text: string;
}

/**
 * Render the `<project_context>` block inlined into a session's first user
 * prompt: a short, honest map of the project's context sources with absolute
 * folder/note paths so every backend can reach them (the manifest is no longer
 * written to a `.context-cache/` file — ACP backends never discovered that
 * file). Lists at most {@link MAX_MANIFEST_ENTRIES} entries and, when more
 * exist, says exactly how many were omitted so the agent never mistakes a
 * partial list for a complete one.
 */
export function buildProjectContextBlock(sources: ManifestSources): string {
  const snapshotBySource = new Map(sources.materialized.map((e) => [e.source, e.cacheFileName]));
  const withPointer = (source: string): string => {
    const cacheFile = snapshotBySource.get(source);
    return cacheFile ? `${source} → \`.context-cache/${cacheFile}\`` : source;
  };
  // Prefer the absolute path (reachable from anywhere); fall back to the vault
  // pattern when the source didn't resolve to a real on-disk path.
  const pathText = (entry: ManifestPathEntry): string => `\`${entry.absPath ?? entry.vaultPath}\``;

  const lines: ManifestLine[] = [
    ...sources.folders.map((e) => line("Included folders", pathText(e))),
    ...sources.notes.map((e) => line("Included notes", pathText(e))),
    ...sources.extensions.map((p) => line("Included file types", `\`${p}\``)),
    ...sources.tags.map((t) => line("Included tags", t)),
    ...sources.webUrls.map((u) => line("Included URLs", withPointer(u))),
    ...sources.youtubeUrls.map((u) => line("Included YouTube", withPointer(u))),
    ...sources.materialized
      .filter((e) => e.type === "file")
      .map((e) => line("Materialized files", withPointer(e.source))),
  ];

  const total = lines.length;
  const shown = lines.slice(0, MAX_MANIFEST_ENTRIES);
  const omitted = total - shown.length;

  const out: string[] = [
    "<project_context>",
    "Context sources for this project, with absolute paths. Folders and tags are",
    "listed as sources, not expanded into member files — use your own search",
    "(grep/glob/read) to enumerate them. Materialized snapshots of URLs, YouTube",
    "transcripts, and PDFs/images live in the project's `.context-cache/` directory.",
  ];

  let currentSection = "";
  for (const item of shown) {
    if (item.section !== currentSection) {
      currentSection = item.section;
      out.push("", `## ${currentSection}`);
    }
    out.push(`- ${item.text}`);
  }

  if (omitted > 0) {
    out.push(
      "",
      `> Only the first ${shown.length} of ${total} sources are listed; ${omitted} more are omitted. ` +
        `Use folder/tag search (grep/find) to find the rest.`
    );
  }
  out.push("</project_context>");
  return out.join("\n");
}

function line(section: string, text: string): ManifestLine {
  return { section, text };
}
