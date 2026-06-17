import type { AgentProjectContextLoadState, ProjectConfig } from "@/aiParams";
import * as adapter from "@/components/project/agentProcessingAdapter";
import { useAgentPersistentFailureCount } from "@/components/project/useAgentPersistentFailureCount";
import { failureMarkerName } from "@/context/contextCacheStore";
import * as projectState from "@/projects/state";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { App } from "obsidian";

jest.mock("@/context/materializeCandidates", () => ({
  listMaterializeCandidates: jest.fn(() => []),
}));

const readSpy = jest.spyOn(adapter, "readAgentCacheDirState");
jest
  .spyOn(projectState, "getCachedProjectRecordById")
  .mockReturnValue({ filePath: "Projects/p1/project.md" } as never);

const app = { vault: { adapter: {} } } as unknown as App;
const project = {
  id: "p1",
  contextSource: { webUrls: "https://a.com", youtubeUrls: "" },
} as unknown as ProjectConfig;

function entry(over: Partial<AgentProjectContextLoadState> = {}): AgentProjectContextLoadState {
  return { phase: "done", blocking: false, ...over };
}

const webMarkerDisk = {
  snapshotNames: new Set<string>(),
  markersByName: new Map([
    [
      failureMarkerName("web", "https://a.com"),
      { source: "https://a.com", kind: "web" as const, error: "boom", failedAt: 1 },
    ],
  ]),
  fingerprintsByName: new Map<string, string>(),
};

describe("useAgentPersistentFailureCount", () => {
  beforeEach(() => readSpy.mockReset());

  it("does not read disk while a run is in flight (live atom is authoritative)", () => {
    readSpy.mockResolvedValue(webMarkerDisk);
    const running = entry({ phase: "prefetch" });
    const { result } = renderHook(() =>
      useAgentPersistentFailureCount(app, project, running, true)
    );
    expect(result.current).toBe(0);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("does not read disk while a retry is in flight even at phase done", () => {
    readSpy.mockResolvedValue(webMarkerDisk);
    const retrying = entry({ retryingSources: [{ kind: "web", source: "https://a.com" }] });
    renderHook(() => useAgentPersistentFailureCount(app, project, retrying, true));
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("counts a persisted failure marker once settled", async () => {
    readSpy.mockResolvedValue(webMarkerDisk);
    const settled = entry();
    const { result } = renderHook(() =>
      useAgentPersistentFailureCount(app, project, settled, true)
    );
    await waitFor(() => expect(result.current).toBe(1));
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it("does not surface a slow read's count after the live entry changed under it", async () => {
    // staleness guard: a disk read in flight for entry A must not paint its count
    // once the hook re-renders with a different liveEntry (B) whose own read is
    // still pending — the count is keyed to the entry it was computed for.
    let resolveA!: (d: typeof webMarkerDisk) => void;
    const readA = new Promise<typeof webMarkerDisk>((r) => (resolveA = r));
    const readB = new Promise<typeof webMarkerDisk>(() => {}); // entryB's read never settles
    readSpy.mockReturnValueOnce(readA).mockReturnValueOnce(readB);

    const entryA = entry();
    const { result, rerender } = renderHook(
      ({ e }) => useAgentPersistentFailureCount(app, project, e, true),
      { initialProps: { e: entryA } }
    );

    const entryB = entry();
    rerender({ e: entryB }); // now keyed to entryB; entryB's read (readB) is pending
    await act(async () => {
      resolveA(webMarkerDisk); // the stale entryA read resolves late
    });
    // entryA's count is discarded (keyed to a now-stale entry); entryB's read is
    // still pending, so nothing is surfaced.
    expect(result.current).toBe(0);
  });

  it("invalidates an already-painted count the instant the live entry changes", async () => {
    // Directly covers the return-value freshness guard (cached count is keyed to
    // the liveEntry it was computed for): entryA paints count=1, then a rerender
    // to entryB (whose own read is still pending) must drop back to 0 immediately
    // — not keep showing entryA's stale 1.
    readSpy.mockResolvedValueOnce(webMarkerDisk); // entryA read → count 1
    const readB = new Promise<typeof webMarkerDisk>(() => {}); // entryB read pending
    const entryA = entry();
    const { result, rerender } = renderHook(
      ({ e }) => useAgentPersistentFailureCount(app, project, e, true),
      { initialProps: { e: entryA } }
    );
    await waitFor(() => expect(result.current).toBe(1));

    readSpy.mockReturnValueOnce(readB);
    const entryB = entry();
    rerender({ e: entryB });
    // entryA's cached count no longer matches the current entry → 0 at once.
    expect(result.current).toBe(0);
  });
});
