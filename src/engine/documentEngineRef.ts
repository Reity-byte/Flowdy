import type { DocumentCanvas } from "./documentCanvas";

/** Imperative handle for toolbar actions (export, undo) without prop drilling. */
export const documentEngineRef: { current: DocumentCanvas | null } = {
  current: null,
};
