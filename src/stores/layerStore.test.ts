import { beforeEach, describe, expect, it } from "vitest";
import { useLayerStore, DEFAULT_LAYER_RAM_BUDGET_MB } from "./layerStore";

function resetStore() {
  useLayerStore.setState({
    layers: [{ id: "seed", name: "Layer 1", visible: true }],
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
});
