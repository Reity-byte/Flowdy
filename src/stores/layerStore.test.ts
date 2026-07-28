import { beforeEach, describe, expect, it } from "vitest";
import { useLayerStore, DEFAULT_LAYER_RAM_BUDGET_MB } from "./layerStore";

function resetStore() {
  useLayerStore.setState({
    layers: [{ id: "seed", name: "Layer 1", visible: true }],
    folders: [],
    activeLayerId: "seed",
    memoryBudgetMb: DEFAULT_LAYER_RAM_BUDGET_MB,
  });
}

describe("layerStore", () => {
  beforeEach(resetStore);

  it("addLayer appends a new layer and makes it active", () => {
    const ok = useLayerStore.getState().addLayer();
    expect(ok).toBe(true);

    const s = useLayerStore.getState();
    expect(s.layers.length).toBe(2);
    expect(s.activeLayerId).toBe(s.layers[1].id);
    expect(s.layers[1].name).toBe("Layer 2");
  });

  it("addLayer numbers past gaps left by a deleted layer", () => {
    const store = useLayerStore.getState();
    store.addLayer(); // Layer 2
    store.addLayer(); // Layer 3
    const layer2Id = useLayerStore.getState().layers[1].id;
    store.deleteLayer(layer2Id);
    store.addLayer();

    const names = useLayerStore.getState().layers.map((l) => l.name);
    expect(names).toEqual(["Layer 1", "Layer 3", "Layer 4"]);
  });

  it("deleteLayer falls the active layer back to the last remaining one", () => {
    const store = useLayerStore.getState();
    store.addLayer();
    const seedId = useLayerStore.getState().layers[0].id;
    store.setActiveLayer(seedId);
    store.deleteLayer(seedId);

    const s = useLayerStore.getState();
    expect(s.layers.length).toBe(1);
    expect(s.activeLayerId).toBe(s.layers[0].id);
  });

  it("moveLayer swaps with the adjacent layer", () => {
    const store = useLayerStore.getState();
    store.addLayer();
    const [first, second] = useLayerStore.getState().layers;

    store.moveLayer(first.id, "up");

    const layers = useLayerStore.getState().layers;
    expect(layers[0].id).toBe(second.id);
    expect(layers[1].id).toBe(first.id);
  });

  it("moveLayer is a no-op past the array bounds", () => {
    const store = useLayerStore.getState();
    const before = useLayerStore.getState().layers;
    store.moveLayer(before[0].id, "down");
    expect(useLayerStore.getState().layers).toEqual(before);
  });

  it("toggleVisible flips only the targeted layer", () => {
    const store = useLayerStore.getState();
    store.addLayer();
    const [first, second] = useLayerStore.getState().layers;

    store.toggleVisible(second.id);

    const layers = useLayerStore.getState().layers;
    expect(layers.find((l) => l.id === first.id)!.visible).toBe(true);
    expect(layers.find((l) => l.id === second.id)!.visible).toBe(false);
  });

  it("canAddLayer respects the memory budget at the given artboard size", () => {
    useLayerStore.setState({ memoryBudgetMb: 8 });
    // One seed layer already exists; a second 2048x2048 RGBA layer (16MB) blows an 8MB budget.
    expect(useLayerStore.getState().canAddLayer(2048, 2048)).toBe(false);
    // A small canvas easily fits.
    expect(useLayerStore.getState().canAddLayer(256, 256)).toBe(true);
  });

  it("addLayer refuses to exceed the memory budget", () => {
    useLayerStore.setState({ memoryBudgetMb: 8 });
    const ok = useLayerStore.getState().addLayer(2048, 2048);
    expect(ok).toBe(false);
    expect(useLayerStore.getState().layers.length).toBe(1);
  });

  describe("folders", () => {
    it("addFolder creates an empty, visible, expanded folder with a numbered default name", () => {
      const store = useLayerStore.getState();
      const id = store.addFolder();
      const folders = useLayerStore.getState().folders;
      expect(folders).toHaveLength(1);
      expect(folders[0]).toMatchObject({ id, name: "Folder 1", visible: true, collapsed: false });
    });

    it("addFolder numbers past gaps left by a deleted folder", () => {
      const store = useLayerStore.getState();
      const first = store.addFolder();
      store.addFolder();
      store.deleteFolder(first);
      store.addFolder();
      const names = useLayerStore.getState().folders.map((f) => f.name);
      expect(names).toEqual(["Folder 2", "Folder 3"]);
    });

    it("moveLayerTo groups a layer into a folder and keeps members contiguous", () => {
      const store = useLayerStore.getState();
      store.addLayer(); // Layer 2
      store.addLayer(); // Layer 3
      const [seed, l2, l3] = useLayerStore.getState().layers;
      const folderId = store.addFolder();

      // Group l2 and l3 into the folder, l3 landing above l2.
      store.moveLayerTo(l2.id, null, folderId);
      store.moveLayerTo(l3.id, null, folderId);

      const layers = useLayerStore.getState().layers;
      const memberIdx = layers.map((l, i) => (l.folderId === folderId ? i : -1)).filter((i) => i >= 0);
      // Contiguous: exactly two consecutive indices.
      expect(memberIdx).toEqual([memberIdx[0], memberIdx[0] + 1]);
      expect(layers.find((l) => l.id === seed.id)!.folderId ?? null).toBe(null);
    });

    it("moveLayerTo ungroups a layer back to top-level", () => {
      const store = useLayerStore.getState();
      store.addLayer();
      const [, l2] = useLayerStore.getState().layers;
      const folderId = store.addFolder();
      store.moveLayerTo(l2.id, null, folderId);
      expect(useLayerStore.getState().layers.find((l) => l.id === l2.id)!.folderId).toBe(folderId);

      store.moveLayerTo(l2.id, null, null);
      expect(useLayerStore.getState().layers.find((l) => l.id === l2.id)!.folderId).toBe(null);
    });

    it("deleteFolder ungroups members instead of deleting them", () => {
      const store = useLayerStore.getState();
      store.addLayer();
      const [, l2] = useLayerStore.getState().layers;
      const folderId = store.addFolder();
      store.moveLayerTo(l2.id, null, folderId);

      store.deleteFolder(folderId);

      const s = useLayerStore.getState();
      expect(s.folders).toHaveLength(0);
      expect(s.layers).toHaveLength(2);
      expect(s.layers.find((l) => l.id === l2.id)!.folderId).toBe(null);
    });

    it("moveFolderTo moves the whole contiguous member span as one block, preserving relative order", () => {
      const store = useLayerStore.getState();
      store.addLayer(); // Layer 2
      store.addLayer(); // Layer 3
      store.addLayer(); // Layer 4
      const [seed, l2, l3, l4] = useLayerStore.getState().layers;
      const folderId = store.addFolder();
      store.moveLayerTo(l2.id, null, folderId);
      store.moveLayerTo(l3.id, null, folderId);
      // Stack is now: seed, l4, [l2, l3] (folder members appended at the top by moveLayerTo's default).

      store.moveFolderTo(folderId, seed.id);
      // Folder's members should now sit immediately below seed (array-order "before" seed).

      const layers = useLayerStore.getState().layers;
      const ids = layers.map((l) => l.id);
      expect(ids.indexOf(l2.id)).toBe(0);
      expect(ids.indexOf(l3.id)).toBe(1);
      expect(ids.indexOf(seed.id)).toBe(2);
      expect(ids.indexOf(l4.id)).toBe(3);
    });
  });
});
