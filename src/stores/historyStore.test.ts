import { beforeEach, describe, expect, it } from "vitest";
import { useHistoryStore, type DocumentSnapshot } from "./historyStore";

// Snapshots only need to be distinguishable, not real ImageData, for these tests.
function snap(tag: string): DocumentSnapshot {
  return [{ id: tag, data: { tag } as unknown as ImageData }];
}

describe("historyStore", () => {
  beforeEach(() => {
    useHistoryStore.setState({ past: [], future: [], maxDepth: 20 });
  });

  it("clear seeds a single baseline entry with nothing to undo", () => {
    useHistoryStore.getState().clear(snap("a"));
    const s = useHistoryStore.getState();
    expect(s.past).toEqual([snap("a")]);
    expect(s.future).toEqual([]);
    expect(s.canUndo()).toBe(false);
  });

  it("pushCommittedState appends to past and clears any redo branch", () => {
    const h = useHistoryStore.getState();
    h.clear(snap("a"));
    h.pushCommittedState(snap("b"));
    const s = useHistoryStore.getState();
    expect(s.past).toEqual([snap("a"), snap("b")]);
    expect(s.canUndo()).toBe(true);
  });

  it("undo returns the previous state and moves the current one into future", () => {
    const h = useHistoryStore.getState();
    h.clear(snap("a"));
    h.pushCommittedState(snap("b"));
    h.pushCommittedState(snap("c"));

    const restored = useHistoryStore.getState().undo();
    expect(restored).toEqual(snap("b"));

    const s = useHistoryStore.getState();
    expect(s.past).toEqual([snap("a"), snap("b")]);
    expect(s.future).toEqual([snap("c")]);
  });

  it("undo returns null once at the baseline", () => {
    useHistoryStore.getState().clear(snap("a"));
    expect(useHistoryStore.getState().undo()).toBeNull();
  });

  it("redo restores the most recently undone state", () => {
    const h = useHistoryStore.getState();
    h.clear(snap("a"));
    h.pushCommittedState(snap("b"));
    h.undo();

    const restored = useHistoryStore.getState().redo();
    expect(restored).toEqual(snap("b"));
    expect(useHistoryStore.getState().canRedo()).toBe(false);
  });

  it("redo returns null when there's nothing to redo", () => {
    useHistoryStore.getState().clear(snap("a"));
    expect(useHistoryStore.getState().redo()).toBeNull();
  });

  it("a new push after undo discards the redo branch", () => {
    const h = useHistoryStore.getState();
    h.clear(snap("a"));
    h.pushCommittedState(snap("b"));
    h.undo();
    h.pushCommittedState(snap("c"));

    const s = useHistoryStore.getState();
    expect(s.future).toEqual([]);
    expect(s.past).toEqual([snap("a"), snap("c")]);
  });

  it("trims past to maxDepth, dropping the oldest entries first", () => {
    useHistoryStore.setState({ past: [], future: [], maxDepth: 3 });
    const h = useHistoryStore.getState();
    h.clear(snap("0"));
    for (let i = 1; i <= 5; i++) h.pushCommittedState(snap(String(i)));

    const s = useHistoryStore.getState();
    expect(s.past.length).toBe(3);
    expect(s.past.map((entry) => (entry[0].data as unknown as { tag: string }).tag)).toEqual(["3", "4", "5"]);
  });
});
