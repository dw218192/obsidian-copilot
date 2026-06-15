import { agentProjectContextLoadAtom, type ProjectConfig } from "@/aiParams";
import {
  buildAgentProcessingItems,
  readAgentCacheDirState,
  type AgentCacheDirState,
  type AgentProcessingSource,
} from "@/components/project/agentProcessingAdapter";
import type { ProcessingItem } from "@/components/project/processingAdapter";
import { cacheFileName } from "@/context/contextCacheStore";
import {
  listMaterializeCandidates,
  listMaterializeContextFileSummary,
} from "@/context/materializeCandidates";
import { getCachedProjectRecordById } from "@/projects/state";
import { settingsStore } from "@/settings/model";
import { parseProjectUrls } from "@/utils/urlTagUtils";
import { useAtomValue } from "jotai";
import type { App } from "obsidian";
import { useEffect, useMemo, useState } from "react";

export interface AgentProcessingItemsState {
  items: ProcessingItem[];
  /** Matched `.md` files (no conversion needed) — for the "N skipped" note. */
  skippedMarkdownCount: number;
}

/**
 * The agent pipeline's Content Conversion read-model: synthesizes the live load
 * atom + on-disk `.context-cache` + the (possibly draft) context source into the
 * ProcessingItem[] the status UI renders, plus the skipped-markdown count.
 *
 * Extracted from AgentProcessingStatusPanel so the Edit-modal panel and the
 * standalone conversion modal share ONE data path. Reactive: a retry that
 * updates the load atom (or rewrites a snapshot) re-renders both surfaces.
 *
 * `contextSource` is passed separately from `project` so the Edit modal can feed
 * its unsaved DRAFT (newly added sources show as Queued); `project.contextSource`
 * is the saved set used to decide which sources a run can actually see.
 */
export function useAgentProcessingItems(
  app: App,
  project: ProjectConfig,
  contextSource: ProjectConfig["contextSource"]
): AgentProcessingItemsState {
  const loadStates = useAtomValue(agentProjectContextLoadAtom, { store: settingsStore });
  const liveEntry = loadStates[project.id];

  const inclusions = contextSource?.inclusions;
  const exclusions = contextSource?.exclusions;
  const summary = useMemo(
    () => listMaterializeContextFileSummary(app, { inclusions, exclusions }),
    [app, inclusions, exclusions]
  );
  const candidates = summary.candidates;

  const sources = useMemo<AgentProcessingSource[]>(() => {
    const urls = parseProjectUrls(contextSource?.webUrls || "", contextSource?.youtubeUrls || "");
    return [
      ...urls.map((u): AgentProcessingSource => ({ kind: u.type, source: u.url })),
      ...candidates.map(
        (f): AgentProcessingSource => ({
          kind: "file",
          source: f.path,
          fingerprint: `${f.stat.mtime}:${f.stat.size}`,
        })
      ),
    ];
  }, [contextSource?.webUrls, contextSource?.youtubeUrls, candidates]);

  // Sources a materialization run can actually see — i.e. the persisted config.
  // Draft-only additions are excluded so they can't show as "processing".
  const savedContextSource = project.contextSource;
  const savedKeys = useMemo(() => {
    const keys = new Set<string>();
    const urls = parseProjectUrls(
      savedContextSource?.webUrls || "",
      savedContextSource?.youtubeUrls || ""
    );
    for (const u of urls) keys.add(u.id);
    for (const f of listMaterializeCandidates(app, savedContextSource)) keys.add(`file:${f.path}`);
    return keys;
  }, [app, savedContextSource]);

  const fileSnapshotNames = useMemo(
    () => new Set(candidates.map((f) => cacheFileName("file", f.path))),
    [candidates]
  );

  const [disk, setDisk] = useState<AgentCacheDirState | undefined>(undefined);
  useEffect(() => {
    // Re-read the cache dir whenever the live atom entry changes — not just on
    // `phase`. A single-source retry rewrites snapshots / deletes a failure
    // marker while leaving phase at "done", so keying on the whole entry is what
    // lets the panel drop a now-fixed failure. The cancelled flag drops a stale read.
    const record = getCachedProjectRecordById(project.id);
    let cancelled = false;
    const read = async (): Promise<AgentCacheDirState | undefined> => {
      if (!record) return undefined;
      const slash = record.filePath.lastIndexOf("/");
      const projectFolder = slash >= 0 ? record.filePath.slice(0, slash) : "";
      return readAgentCacheDirState(app.vault.adapter, projectFolder, fileSnapshotNames);
    };
    void read().then((state) => {
      if (!cancelled) setDisk(state);
    });
    return () => {
      cancelled = true;
    };
  }, [app, project.id, fileSnapshotNames, liveEntry]);

  const items = useMemo(
    () => buildAgentProcessingItems(sources, liveEntry, disk, savedKeys),
    [sources, liveEntry, disk, savedKeys]
  );

  return { items, skippedMarkdownCount: summary.skippedMarkdownCount };
}
