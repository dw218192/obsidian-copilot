import type { AgentProjectContextLoadState } from "@/aiParams";
import {
  buildAgentProcessingItems,
  type AgentCacheDirState,
  type AgentProcessingSource,
} from "@/components/project/agentProcessingAdapter";
import { cacheFileName, failureMarkerName } from "@/context/contextCacheStore";

const URL_A = "https://a.example.com/page";
const PDF = "docs/spec.pdf";

const webSource: AgentProcessingSource = { kind: "web", source: URL_A };
const fileSource: AgentProcessingSource = { kind: "file", source: PDF, fingerprint: "100:5" };

function entry(over: Partial<AgentProjectContextLoadState> = {}): AgentProjectContextLoadState {
  return { phase: "done", blocking: false, ...over };
}

function disk(over: Partial<AgentCacheDirState> = {}): AgentCacheDirState {
  return {
    snapshotNames: new Set(),
    markersByName: new Map(),
    fingerprintsByName: new Map(),
    ...over,
  };
}

const SAVED_ALL = new Set([`web:${URL_A}`, `file:${PDF}`]);

describe("buildAgentProcessingItems", () => {
  it("is Queued with no live entry, no disk state", () => {
    const items = buildAgentProcessingItems(
      [webSource, fileSource],
      undefined,
      undefined,
      SAVED_ALL
    );
    expect(items.map((i) => i.status)).toEqual(["pending", "pending"]);
  });

  it("is Converted when the disk snapshot exists", () => {
    const d = disk({ snapshotNames: new Set([cacheFileName("web", URL_A)]) });
    const [web] = buildAgentProcessingItems([webSource], undefined, d, SAVED_ALL);
    expect(web.status).toBe("ready");
  });

  it("downgrades a file snapshot to Queued when the file changed since conversion", () => {
    const name = cacheFileName("file", PDF);
    const d = disk({
      snapshotNames: new Set([name]),
      fingerprintsByName: new Map([[name, "100:5"]]),
    });
    const fresh = buildAgentProcessingItems([fileSource], undefined, d, SAVED_ALL)[0];
    expect(fresh.status).toBe("ready");

    const changed = buildAgentProcessingItems(
      [{ ...fileSource, fingerprint: "200:9" }],
      undefined,
      d,
      SAVED_ALL
    )[0];
    expect(changed.status).toBe("pending");
  });

  it("keeps a file snapshot Queued when its fingerprint is unknown (unreadable/old meta)", () => {
    // Snapshot file present but no stored fingerprint → can't prove it's current.
    const d = disk({ snapshotNames: new Set([cacheFileName("file", PDF)]) });
    const [file] = buildAgentProcessingItems([fileSource], undefined, d, SAVED_ALL);
    expect(file.status).toBe("pending");
  });

  it("is Failed with the persisted error when a disk failure marker exists", () => {
    const d = disk({
      markersByName: new Map([
        [
          failureMarkerName("web", URL_A),
          { source: URL_A, kind: "web" as const, error: "fetch 404", failedAt: 1 },
        ],
      ]),
    });
    const [web] = buildAgentProcessingItems([webSource], undefined, d, SAVED_ALL);
    expect(web.status).toBe("failed");
    expect(web.error).toBe("fetch 404");
  });

  it("prefers a live missing failure over a stale disk snapshot", () => {
    const d = disk({ snapshotNames: new Set([cacheFileName("web", URL_A)]) });
    const live = entry({
      failedSources: [{ path: URL_A, type: "web", error: "boom", usedStaleSnapshot: false }],
    });
    const [web] = buildAgentProcessingItems([webSource], live, d, SAVED_ALL);
    expect(web.status).toBe("failed");
    expect(web.error).toBe("boom");
  });

  it("treats a live stale-but-usable failure as Converted even without disk state", () => {
    const live = entry({
      failedSources: [{ path: URL_A, type: "web", error: "net down", usedStaleSnapshot: true }],
    });
    const [web] = buildAgentProcessingItems([webSource], live, undefined, SAVED_ALL);
    expect(web.status).toBe("ready");
  });

  it("matches live nonMd failures to file sources", () => {
    const live = entry({
      failedSources: [{ path: PDF, type: "nonMd", error: "parse", usedStaleSnapshot: false }],
    });
    const [file] = buildAgentProcessingItems([fileSource], live, undefined, SAVED_ALL);
    expect(file.status).toBe("failed");
  });

  it("shows saved sources as Converting while a run is in flight, but never unsaved drafts", () => {
    const live = entry({ phase: "prefetch", prefetch: { done: 0, total: 2 } });
    const savedOnlyFile = new Set([`file:${PDF}`]);
    const [web, file] = buildAgentProcessingItems(
      [webSource, fileSource],
      live,
      disk(),
      savedOnlyFile
    );
    expect(web.status).toBe("pending"); // draft-only URL: no run knows about it
    expect(file.status).toBe("processing");
  });

  it("distinguishes a same-URL web and youtube pair by cacheKind (matches the CAG id contract)", () => {
    // `id` is the raw URL (CAG parity → clean display + remove-by-(cacheKind,url)).
    // The two rows are still distinct items; cacheKind is what tells them apart.
    const dual: AgentProcessingSource[] = [
      { kind: "web", source: URL_A },
      { kind: "youtube", source: URL_A },
    ];
    const items = buildAgentProcessingItems(dual, undefined, undefined, new Set());
    expect(items.map((i) => i.id)).toEqual([URL_A, URL_A]);
    expect(items[0].cacheKind).toBe("web");
    expect(items[1].cacheKind).toBe("youtube");
  });

  it("maps kinds onto the panel's source/fileType model", () => {
    const items = buildAgentProcessingItems(
      [webSource, fileSource],
      undefined,
      undefined,
      SAVED_ALL
    );
    expect(items[0]).toMatchObject({ source: "url", fileType: "web", cacheKind: "web" });
    expect(items[1]).toMatchObject({ source: "file", fileType: "pdf", cacheKind: "file" });
  });
});
