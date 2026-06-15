import { AgentChatInput } from "@/agentMode/ui/AgentChatInput";
import type { AgentChatBackend } from "@/agentMode/session/AgentChatBackend";
import type { AgentInputDraftControls } from "@/agentMode/ui/hooks/useAgentInputDrafts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { App } from "obsidian";
import React from "react";

// The real ChatInput drags in Lexical + the full composer; the regression under
// test lives entirely in AgentChatInput's send flow, so a send button is enough.
jest.mock("@/components/chat-components/ChatInput", () => ({
  __esModule: true,
  default: ({ handleSendMessage }: { handleSendMessage: () => void }) => (
    <button type="button" onClick={() => handleSendMessage()}>
      send
    </button>
  ),
}));

// Mock factory names must match the real `use*` exports, so the no-hook `use`
// prefix is expected here.
/* eslint-disable @eslint-react/hooks-extra/no-unnecessary-use-prefix */
jest.mock("@/aiParams", () => ({
  useSelectedTextContexts: () => [[]],
  clearSelectedTextContexts: jest.fn(),
  removeSelectedTextContext: jest.fn(),
}));

jest.mock("@/components/chat-components/hooks/useActiveWebTabState", () => ({
  useActiveWebTabState: () => ({ activeWebTabForMentions: null }),
}));
/* eslint-enable @eslint-react/hooks-extra/no-unnecessary-use-prefix */

jest.mock("@/agentMode/session/expandCustomCommandPrefix", () => ({
  expandCustomCommandPrefix: async (text: string) => ({ text }),
}));

jest.mock("@/commands/state", () => ({
  getCachedCustomCommands: () => [],
}));

jest.mock("@/commands/customCommandManager", () => ({
  CustomCommandManager: { getInstance: () => ({ recordUsage: jest.fn() }) },
}));

jest.mock("@/services/webViewerService/activeWebTabSnapshot", () => ({
  buildWebTabsWithActiveSnapshot: () => [],
}));

const makeApp = (): App => ({ workspace: { getActiveFile: () => null } }) as unknown as App;

const makeDraft = (overrides: Partial<AgentInputDraftControls> = {}): AgentInputDraftControls => ({
  input: "hello",
  images: [],
  contextNotes: [],
  includeActiveNote: false,
  includeActiveWebTab: false,
  loading: false,
  queue: [],
  setInput: jest.fn(),
  setContextNotes: jest.fn(),
  setSelectedImages: jest.fn(),
  addImages: jest.fn(),
  setIncludeActiveNote: jest.fn(),
  setIncludeActiveWebTab: jest.fn(),
  setLoading: jest.fn(),
  setQueue: jest.fn(),
  resetCompose: jest.fn(),
  ...overrides,
});

function renderInput(backend: AgentChatBackend, draft: AgentInputDraftControls) {
  return render(
    <AgentChatInput
      backend={backend}
      sessionId="session-1"
      draft={draft}
      app={makeApp()}
      updateUserMessageHistory={jest.fn()}
      isStarting={false}
      hasPendingPlanPermission={false}
      modelPickerOverride={undefined}
      modePickerOverride={undefined}
      onCycleMode={jest.fn()}
    />
  );
}

describe("AgentChatInput turn-completion loading reset", () => {
  it("regression: clears draft.loading when the turn resolves after the composer unmounted", async () => {
    // First send from a landing: the user message lands, AgentHome flips
    // landing→conversation, and the composer remounts mid-turn. The unmounting
    // instance's runSend must still clear the shared draft's loading flag,
    // or the Thinking spinner / stop button stick forever (#stuck-thinking).
    let resolveTurn!: () => void;
    const turn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const backend = {
      sendMessage: jest.fn(() => ({ turn })),
      cancel: jest.fn(),
    } as unknown as AgentChatBackend;
    const draft = makeDraft();

    const { unmount } = renderInput(backend, draft);
    fireEvent.click(screen.getByText("send"));

    await waitFor(() => expect(draft.setLoading).toHaveBeenCalledWith(true));
    expect(backend.sendMessage).toHaveBeenCalledTimes(1);

    // The landing→conversation flip unmounts this composer instance while the
    // turn is still in flight.
    unmount();

    await act(async () => {
      resolveTurn();
      await turn;
    });

    await waitFor(() => expect(draft.setLoading).toHaveBeenCalledWith(false));
  });
});
