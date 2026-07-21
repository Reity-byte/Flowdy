# Flowdy — Session Handoff TODO

This file is a self-contained work order for the next session. It exists because a
prior conversation with full context is about to be cleared. Read this file fully
before doing anything else — it should replace re-exploring the codebase.

## Ground rules for whoever picks this up (read before touching anything)

- **Do not run a broad codebase exploration.** This file names the exact files and
  functions each task touches. Read only those, only when you're about to work on
  that specific task. Do not proactively read unrelated files "to understand the
  project" — the Alpha Log and context sections below already summarize what you need.
- **Do not re-verify already-completed items** (see Alpha Log) by reading their code
  unless a *current* task explicitly depends on that code.
- **Do not re-run `cargo check`/`npm run build` speculatively.** Run it once after a
  batch of related changes, not after every file edit — the Rust build alone can take
  10+ minutes cold.
- A dev server config already exists at `.claude/launch.json` (`npm run dev`, port
  1420). Use the `preview_start`/browser tools with that config directly — don't
  recreate it.
- If you need to test live in-browser, prefer dispatching real `PointerEvent`s via
  `javascript_tool` and reading state through `documentEngineRef` / the zustand
  stores' `.getState()` — screenshots and `left_click_drag` were unreliable in this
  environment (WebGL canvas readback issue); `read_page` + `computer.left_click` on
  refs worked fine for DOM buttons.
- **The Browser pane's tab reports `document.hidden === true` / `visibilityState:
  "hidden"` for long stretches in this environment, even right after `tabs_select`
  claims to front it.** This freezes both `requestAnimationFrame` (confirmed cause
  of some earlier `javascript_tool` calls hanging/timing out when awaiting chained
  rAFs) *and* CSS transitions/Web Animations (confirmed via `el.getAnimations()`
  showing `playState: "running"` but `localTime` permanently stuck at `0` — a
  transitioning element's `getComputedStyle` will report its **pre-transition
  starting value forever**, not the target value, even seconds later, even after
  reassigning `className`). This is a real, reproducible harness quirk, not a bug
  in the app: confirmed by cloning the exact same element+className fresh into the
  same live parent, which computed correctly immediately (no transition needed to
  reach a value it started at) — the mismatch only ever appears on elements whose
  style changed *after* their initial paint, while the tab was backgrounded. If a
  computed-style check on a just-toggled/animated element looks wrong, check
  `document.hidden` and the element's `getAnimations()` before assuming it's a
  real CSS/logic bug — cross-check via a freshly-created clone with the same
  classes in the same parent, which sidesteps the frozen-transition issue entirely.
- **`window.confirm`/dialogs:** don't stub these out permanently in source — only
  override `window.confirm` transiently inside a test script when verifying a flow,
  never leave a stub in committed code.
- When a task is finished, update its checkbox below **and append a dated entry to
  the Alpha Log** — don't just delete the task, keep the log growing.
- Prefer running the pure-logic test suite (`npm test`, vitest) after logic changes
  in `brushEngine.ts` / `historyStore.ts` / `layerStore.ts` / `color.ts` — it's fast
  and already covers those.

## Project context (brief — don't re-derive this by reading source)

Flowdy is a Tauri 2 + React 19 + PixiJS 8 + Zustand digital painting app (desktop +
touch). Core files:
- `src/engine/documentCanvas.ts` — the main engine class (`DocumentCanvas`): Pixi
  setup, all pointer/keyboard input, layer runtime management, undo/redo glue,
  export.
- `src/engine/brushEngine.ts` — stroke smoothing/prediction (`HighPerformanceBrushStroke`)
  and dab rendering (`paintDab`, stamp cache).
- `src/engine/SelectionManager.ts` — the rectangular marquee select/transform tool.
- `src/stores/` — zustand stores: `appStore` (screen/project/save), `editorStore`
  (tool + brush settings + presets), `layerStore`, `historyStore`, `themeStore`.
- `src/components/` — React UI (TopBar, Toolbox, ToolPalette, ColorPicker,
  LayerPanel, Gallery, modals).

A prior session did a full correctness/polish/optimization pass (see Alpha Log —
Session 1). The codebase is currently in good shape structurally; the work below is
about tool *authenticity* (matching how Procreate/ibis Paint/Photoshop actually
behave) and visual polish, not more bug-hunting for its own sake.

---

## Alpha Log

**Session 16 — 2026-07-21.** The user asked for a bucket/fill tool and
straight + circular ruler (drawing guide) tools — new scope, not previously
implemented (Section 6.3 only listed these as candidate ideas, not built).

- **Bucket/Fill tool** (`src/engine/floodFill.ts`, new file): a stack-based
  scanline flood fill (iterative spans, not per-pixel recursion — same
  constraint the todo's Magic Wand entry calls out for the same class of
  algorithm, so it can't stack-overflow on a 2048×2048 canvas) operating
  directly on the active layer's `ImageData`. Compares every candidate pixel
  against the ORIGINAL (pre-fill) seed color, not the being-mutated buffer,
  so a fill color close to the seed can't leak past its own already-painted
  pixels. Respects Alpha Lock the same way brush painting does (only
  already-opaque pixels eligible when the active layer is locked). New
  `"fill"` `EditorTool` (`brushTypes.ts`), a `fillTolerance` (0-100, default
  20) store field + `Tolerance` slider in `ToolPalette.tsx`, a toolbox button
  (`Toolbox.tsx`, `PaintBucket` icon), and a dedicated branch in
  `DocumentCanvas.onPointerDown` (before the Select branch) that runs the
  fill on click and pushes a normal undo step via the existing
  `onStrokeCommitted` hook — no new history mechanism needed.
- **Ruler / drawing-guide tools** (`src/engine/RulerManager.ts`, new file,
  architecturally mirrors `SelectionManager`'s press-drag-release lifecycle
  and its own Pixi `container`/`Graphics` overlay): a placeable guide —
  straight edge or circle — that every paint tool's strokes snap onto once
  placed. `RulerManager` owns the geometry (`lineStart/lineEnd` or
  `center/radius`, world-space) and interaction (`startEdit`/`updateEdit`/
  `endEdit`, hit-testing endpoints/center/body with a zoom-independent
  screen-space tolerance) entirely engine-side, the same way selection rect
  geometry is engine-owned rather than store-owned. `snapPoint(x, y)`
  projects an arbitrary point onto the guide (infinite-line projection for
  straight, radial projection for circular), passing through unchanged when
  disabled/not-yet-placed/degenerate. New `"ruler"` `EditorTool`; a
  `rulerType`/`rulerEnabled` pair in `editorStore.ts` (cheap reactive UI
  state — geometry itself deliberately isn't store state, matching how
  selection is handled) that `DocumentCanvas` syncs into its `RulerManager`
  instance via a `useEditorStore.subscribe` (same pattern as the existing
  `unsubEditorTool` selection-commit-on-tool-change subscription). Toolbox
  gained a Ruler button plus a straight/circular sub-mode row (mirrors
  Select's rect/lasso row) and a Clear-ruler button (calls
  `documentEngineRef.current.clearRuler()`, the established imperative-call
  pattern TopBar's Undo/Redo already use). `DocumentCanvas` snaps the world
  point through `ruler.snapPoint()` at every `brush.down()`/`move()`/
  `flush()` call site (so the stroke's tail sits on the guide too, not just
  its body) — this applies to every paint-capable tool (brush/eraser/blur/
  smudge) uniformly, since they all funnel through the same pointer handlers.
- **Verified live**, via real dispatched `PointerEvent`s and, once a first
  test produced a confusing result, by getting a live handle on the actual
  running module singletons rather than guessing from screenshots — Vite
  dev serves ES modules by URL, so `await import('/src/stores/editorStore.ts')`
  from an injected script resolves to the SAME live module instance already
  loaded by the page (confirmed: reading `useEditorStore.getState()` this way
  matched the visible UI state exactly), which let `documentEngineRef`,
  `useHistoryStore`, and `RulerManager`'s own fields be read/driven directly
  instead of inferring engine state from pixels alone. Worth remembering for
  future sessions needing to verify non-visual engine state without relying
  on the WebGL-canvas-readback-limited screenshot tooling.
  - Fill: clicking a solid white canvas filled it entirely with the active
    color at full opacity (confirmed via screenshot + Undo becoming
    available); Undo correctly restored the blank canvas.
  - Straight ruler: dragged out a guide, then dispatched a real drag with a
    deliberately large sinusoidal wobble (40px amplitude) along a path near
    the guide — the drawn stroke came out perfectly straight, exactly on the
    guide line, despite the wildly wobbly input.
  - Circular ruler: same test shape (dragged out a circle guide, then a
    wobbly drag around it) — **first attempt showed the drawn stroke NOT
    snapping at all**, tracing the raw wobble instead. Root-caused properly
    rather than assumed: monkey-patched `RulerManager.snapPoint` to log
    every call during a real dispatch and confirmed the engine WAS calling
    it and getting correct on-circle results back — so the snapping
    mechanism itself was never broken. The actual cause was in the test
    script, not the app: synthetic `pointermove` events dispatched in a
    tight synchronous loop have near-zero real wall-clock time between them,
    and `HighPerformanceBrushStroke`'s pre-existing (unrelated to this
    session's work) velocity-based tip-prediction divides the position
    delta by that near-zero `dt`, producing an artificially huge velocity
    estimate and a wild predictive overshoot — invisible on the straight-
    ruler test only because overshoot *along* an infinite line is still on
    the line, but very visible as radial deviation off a circle. Re-ran the
    identical wobble script with a realistic ~8ms `await`-based delay
    between each dispatched `pointermove` (matching real hardware pointer
    sampling intervals) and the stroke traced a clean, tight ring exactly
    on the circular guide. **Flagging for future sessions:** any live
    `PointerEvent`-dispatch test of brush behavior should space `pointermove`
    calls with a real small delay (`await sleep(~8ms)`), not fire them all
    synchronously back-to-back — the prediction system (`predictionMs`/
    `predictionBlend` in `DEFAULT_BRUSH_TUNING`) assumes real timestamps and
    will visibly misbehave on synthetic zero-`dt` input regardless of
    whether rulers are involved at all.
- `npx tsc --noEmit` clean, `npm test` 35/35 passing throughout.

**Session 15 — 2026-07-20.** The user asked for a broad performance pass
("input lags behind rendering, strokes feel choppy") with an explicit
process (profile first, fix highest-impact first, verify pixel-identical
after each change, report) and an explicit hard constraint: don't change
any behavior that already works, and flag rather than silently apply
anything that isn't provably output-identical — Smudge and Stabilization
named specifically as off-limits for anything beyond pure performance work.

- **Profiled first, via live instrumentation, not guessing.** Used
  `documentEngineRef` to monkey-patch (own-property overrides, reversible,
  no source edits) `brush.advance`/`brush.recomposite`/the active layer's
  `sprite.texture.source.update`, plus global
  `CanvasRenderingContext2D.prototype.getImageData`/`putImageData`/
  `drawImage`/`clearRect`, then dispatched real `PointerEvent`s (not direct
  engine calls — an earlier attempt at direct calls silently missed the
  per-dab draws entirely, because `setImmediateMode`/the module-level draw
  queue in a separately-`import()`-ed copy of `brushEngine.ts` didn't share
  state with the page's already-loaded instance; real dispatched events go
  through the app's own correctly-scoped code and sidestep this) on a fresh
  2048×2048 canvas. Plain pen-brush strokes profiled as already cheap and
  NOT a bottleneck (400 `advance()` calls — includes the stabilization
  replay pass — totaling 17.5ms; 3794 `drawImage` calls totaling 8.3ms;
  `recomposite()` 2 calls/2.8ms; texture upload 2 calls/0.2ms). Two real
  bottlenecks stood out by orders of magnitude:
  1. **Smudge: ~18.7 seconds of `getImageData`+`putImageData` for one
     ordinary 150-move stroke** (4850 calls, traced via call-count
     instrumentation) — Session 14's fix (this same session's prior entry)
     correctly removed Smudge's throttle to kill the stamp-ridge artifact,
     but left every one of the now-much-more-frequent per-substep calls
     doing a full canvas/GPU round trip. This is almost certainly the
     literal, measurable cause of "choppy" whenever Smudge is used —
     confirmed by dispatching the exact same real-`PointerEvent` script
     before and after this session's fix: **20,661ms → 803ms, a 25.7×
     speedup**, on an identical stroke.
  2. **Every stroke commit does one full-canvas `getImageData`**
     (`DocumentCanvas.captureSnapshot`, for undo history — traced via a
     captured stack frame from an instrumented `getImageData`, not
     guessed) — a real hitch right when the pen lifts, present regardless
     of brush style. Roughly ~30-45ms per commit on a 2048×2048 canvas in
     this environment, with occasional worse spikes (a controlled
     synthetic write-then-read benchmark isolating just this one variable
     measured ~18ms avg with occasional 30-55ms spikes without a
     `willReadFrequently` hint on the canvas context, vs. a more
     consistent ~8ms with it — the same reasoning `preStroke`/
     `smudgeSurface` in `brushEngine.ts` already use, just never applied
     to the actual layer canvas itself).
- **Fix 1 — Smudge: `stampSmudgeDab` now reads/writes a persistent
  `Uint8ClampedArray` (`smudgeData`, full canvas size, seeded once per
  stroke) instead of calling `getImageData`/`putImageData` on the actual
  canvas every sub-step** (`src/engine/brushEngine.ts`). The canvas itself
  (`smudgeSurface`) is left untouched by every individual dab and only
  synced from `smudgeData` by a new `syncSmudgeSurface()` — via a
  dirty-rectangle `putImageData` covering only the region touched since
  the last sync, not the whole canvas — called from `recomposite()` right
  before it needs to read the surface, which was already coalesced to at
  most once per animation frame by the caller. This is a pure
  representation change: every index formula inside `stampSmudgeDab` is
  byte-for-byte unchanged from the previous version (same `rx0/ry0/rw/rh/
  offX/offY` computation, same bounds checks, same write footprint —
  **including reproducing a pre-existing footprint bug exactly, see below,
  deliberately not fixed as part of this pass**), just addressed directly
  into the persistent buffer instead of through a getImageData-returned
  copy. **Verified pixel-identical**, not just "looks the same": a
  same-script before/after comparison (this file's established
  methodology — monkey-patch the previous `stampSmudgeDab` back in as an
  instance override, run an identical deterministic multi-color,
  variable-speed, variable-pressure stroke script, compare byte-for-byte)
  came back **0 differing bytes of 16,777,216 scanned**, cross-checked
  three ways (persistent buffer vs. old-version's canvas; new canvas vs.
  old canvas; persistent buffer vs. new canvas — all zero). (An earlier,
  needlessly more complex version of this same comparison test — which
  also redundantly wrapped `down()` even though `down()`'s seeding logic
  is unchanged between old and new — showed a reproducible but tiny
  365,055-byte/max-diff-1 discrepancy; isolating each wrapper separately
  showed both were individually transparent, so the discrepancy was a
  latent bug in that unnecessarily-complicated test harness itself, not a
  real difference — the simpler, methodologically-correct test needs only
  swap `stampSmudgeDab`, and it's the one that came back clean. Recorded
  here so a future session doesn't waste time rediscovering the same
  test-harness dead end.) Also re-verified end-to-end through the real UI
  (actual Smudge tool button, real drag) — visually a clean, smooth,
  continuously-fading drag with no rope/ridge artifact, matching Session
  14's fix. `npx tsc --noEmit` clean, `npm test` 35/35 passing.
- **Fix 2 — layer canvases now use `willReadFrequently: true`**
  (`makeLayerSurface` in `src/engine/documentCanvas.ts`), matching the
  existing reasoning already applied to `preStroke`/`smudgeSurface` in
  `brushEngine.ts`. Verified this has no downside for the OTHER frequent
  consumer of the same canvas (Pixi's texture upload / `drawImage`-based
  paths): a controlled A/B on the real Pixi renderer (`Texture.from` +
  `source.update()`, and plain `drawImage`-from-canvas) showed no
  measurable difference either way (~0.04ms both cases for texture
  upload; sub-millisecond, noise-level for drawImage). Verified
  end-to-end: undo→redo round-trips restore the exact original bytes (0
  diff over the touched region), confirming `getImageData`/`putImageData`
  still work correctly with the new context flag. `npx tsc --noEmit`
  clean, `npm test` 35/35 passing.
- **Re-profiled after both fixes to confirm no regression on the already-
  cheap plain-brush path:** identical baseline script, 84ms vs. the
  original 76ms baseline — within noise, no regression.
- **Found and deliberately did NOT fix, per the user's own hard
  constraint: a pre-existing indexing bug in `stampSmudgeDab`'s footprint,
  unrelated to performance.** `offX`/`offY` are computed as `rx0-px0`/
  `ry0-py0` (should be `px0-rx0`/`py0-ry0` for the dab's own footprint to
  land where `(x,y)` actually is). Verified by pure arithmetic
  (no rendering involved, so no test-methodology risk): for a concrete
  case (dab centered at (1000,1000), size 120, a 20px drag delta →
  `pad=22`), the code's actual write footprint comes out to
  `x∈[918,1015]`/`y∈[918,1015]` — shifted `-pad` (toward the canvas
  origin, in BOTH axes, regardless of actual drag direction — even a
  purely horizontal drag would spuriously shift the footprint vertically
  too, since `pad` is derived from `max(|dx|,|dy|)` applied to both axes
  unconditionally) and undersized to `size-pad` (98px) instead of the
  intended, centered `[940,1059]` (full 120px). Effect scales with
  per-substep drag distance (`pad`), so worse on fast strokes / large
  brushes relative to slow careful smudging. This is exactly the kind of
  behavior-changing fix the user's own instructions said to flag and ask
  about rather than silently apply during a performance pass, and it's
  the same code Session 14 explicitly called "recently fixed" and
  off-limits for anything but pure performance work — **left exactly
  as-is, reproduced bug-for-bug in this session's faster rewrite** (see
  Fix 1 above). Worth a dedicated follow-up session if the user wants it
  fixed — likely a real, if probably subtle-at-typical-speeds, "smudge
  trails slightly up-left of the cursor" effect.

**Session 14 — 2026-07-20.** The user rejected Session 13's "audit only,
already correct" conclusion on Smudge, with a specific, correct rebuttal:
every Session 13 test checked for introduced HUE, which is a different
claim than "not a stamp loop." The user's screenshot showed gray (so
every color test would call it clean) rope/tentacle shapes with a
lighter core and a periodic ridged texture — the signature of discrete
overlapping soft-falloff stamps composited along the path, not
continuous pixel relocation. The user asked, before writing any fix, to
check git history for an earlier session's first-attempt implementation
that reportedly worked correctly, rather than re-deriving from scratch.

- **Git history check — the earlier working version is not recoverable.**
  `git log --oneline -- src/engine/brushEngine.ts` shows only 4 commits,
  and `git show <HEAD>:src/engine/brushEngine.ts | grep -c smudge` returns
  `0` — Smudge has never existed in any committed snapshot of this repo.
  Every session's smudge work described in this file (Sessions 7-13) has
  only ever existed in the uncommitted working tree; nothing to `git
  diff`/`git log` against. Confirmed and moved on to rebuilding per the
  user's own fallback instruction (sample-and-drag model, not patched
  stamp spacing) rather than spending more time hunting for something
  that structurally can't be found this way.
- **Re-examined the Session 12 code the user was actually pointing at and
  confirmed the critique is right.** `stampSmudgeDab` was throttled to
  fire only every ~30% of dab size traveled (`lastSmudgeProcessPos`
  distance gate), and each firing re-applied a fixed soft round mask
  against a separately-carried `smudgeAccum` patch. That is a stamp loop
  by any honest reading, regardless of whether it uses canvas composite
  calls or an explicit per-pixel lerp (Session 12's own improvement was
  real — removing composite-mode stacking — but didn't address the
  spacing/independent-carried-shape issue at all, which is a structurally
  separate axis of the same "no brush-stamp" requirement).
- **Rebuilt `stampSmudgeDab` (`src/engine/brushEngine.ts`) around
  continuous backward-sampling, with no throttle and no carried patch.**
  Removed `smudgeAccum` (the `Float32Array` carried patch) and
  `lastSmudgeProcessPos` (the throttle gate) entirely. The replacement,
  `smudgeLastPos`, tracks the real motion vector only — every sub-step the
  shared stamping loop calls (`stampAlongSegment`/`stampAlongQuadratic`,
  ~5% of brush size apart, no skipping) computes `dx, dy` since the
  previous call and, for every pixel under the dab's soft round mask,
  blends the live `smudgeSurface` toward a bilinear sample of itself
  taken one step *behind* (`pixel - (dx, dy)`), read from an immutable
  per-call snapshot of the region so results don't depend on pixel visit
  order. There is no second buffer with its own shape being reapplied at
  intervals — the surface is the only memory, continuously advected
  forward by the stroke's own real motion. `smudgeMaskWeights` (the
  brush's own round falloff) is unchanged and still used, but only as the
  footprint's edge shape, the same role any paint brush's mask plays, not
  as an independently-persisting patch. Dab geometry is still fixed for
  the whole stroke (Session 12's reasoning for that is unaffected by this
  change).
- **Found and fixed a second, related bug this change would otherwise have
  introduced: the post-stroke stabilization replay.** `flush()`'s
  stabilization pass (Session 11/12/13) replays the whole stroke a second
  time along a smoothed path via `beginReplayPass()` + `advance()`, and
  applies to every brush style including Smudge — `stabilization`
  defaults to 4 (not 0), so in practice nearly every real Smudge stroke
  already goes through this. `beginReplayPass()` clears `wetBuffer` but
  never touched Smudge's separate `smudgeSurface`/state, so (a) the raw
  pass's already-smudged result was never discarded, meaning the replay
  would smudge a second time on top of it instead of redrawing from
  scratch (pre-existing since Session 11, just never exercised by any
  Smudge-specific test until this session), and (b) with this session's
  new delta-based dragging, the replay's first sub-step would have
  computed its drag vector from the raw pass's LAST position (near the
  stroke's end) to the replay's actual start (near the stroke's
  beginning) — a huge, wrong single jump. Fixed by having
  `beginReplayPass()` reseed `smudgeSurface` from `preStroke` (the true
  pre-stroke snapshot) and reset `smudgeLastPos`, mirroring what `down()`
  already does — the replay now redraws Smudge from a clean slate along
  the smoothed path, consistent with how every other brush style's replay
  already worked.
- **Verified with the exact test the user prescribed — brightness
  oscillation over real content, not color.** Live, via
  `documentEngineRef`/direct `brush.down()/move()/flush()` calls (a fresh
  1920×1080 canvas, a grayscale radial-gradient blob, a deterministic
  straight drag script): sampled the brightness profile along the stroke,
  detrended it with a wide moving average, and measured the residual's
  stddev (a direct "how periodic/bumpy is this, after removing the real
  intended fade" metric). Then, per this file's own established
  methodology, monkey-patched `stampSmudgeDab`/`down()` back to a faithful
  reconstruction of the exact pre-this-session (throttled-stamp +
  `smudgeAccum`) code as an instance-level override, re-ran the identical
  script, and compared: **old 4.85 → new 0.95, a 5.1x reduction.** The old
  profile visibly jitters sample-to-sample (218, 224, 218, 209, 216, 211,
  200...); the new one transitions smoothly with no periodic bumps (234,
  234, 218, 198, 178, 158, 138, 134, 134, 134...). Also confirmed: (1) the
  stabilization-replay fix doesn't crash and produces a real, non-degenerate
  result with `stabilization: 4` (the real default) and a deliberately
  wobbly input path; (2) a chromatic regression scan (red/green/blue
  corners + a black square, curved variable-pressure drag through the
  black square and empty space only) came back with **0 anomalies of
  223,200 scanned pixels, max channel spread 0** — the rewrite didn't
  reintroduce any hue issue; (3) a real end-to-end check through the
  actual UI — real `PointerEvent`s dispatched on the actual canvas element
  with the Smudge tool selected via a real click, default tool settings —
  produced a clean, continuously-fading drag trail with no rope shape, no
  ridge texture, no lighter centerline, matching what dragging a finger
  through wet paint should look like. `npx tsc --noEmit` clean, `npm test`
  (vitest) 35/35 passing throughout.
- **This closes the smudge stamp-artifact bug** with the specific test the
  user asked for, not a re-assertion of the previous (color-only) evidence.
  If a future session finds a new Smudge complaint, re-read this entry
  first — the architecture is now: no accum, no throttle, continuous
  backward-sample per sub-step, replay reseeds from `preStroke`.

**Session 13 — 2026-07-20.** The user sent a screenshot showing new
squiggle/ripple texture along smoothly-drawn curved lines at Stabilization
10 ("if it wasnt squiggly in the original but there shouldnt be any
squiggles in a sharp line") — Session 12's arc-length fix had solved the
shortening/collapse bugs but introduced a different one. Separately, the
user pasted a detailed third-party explanation of how a real smudge tool
should conceptually work (sample-drag-blend, no independent color, single
color space, no brush-stamp reuse) with the framing "you still dont
understand concept of smudge" — this turned out to already match Session
12's rebuilt architecture point-for-point, so this session's job was to
prove that with fresh evidence rather than just assert it.

- **Stabilization squiggle — root-caused and fixed, with a direct before/
  after measurement isolating the actual cause.** Session 12's arc-length
  window fix (endpoint-anchored, radius tapering near the ends) was
  correct for the shortening/collapse bugs, but its *inner* averaging was
  still a flat, unweighted mean of whichever raw samples fell inside the
  arc-length window. Two compounding problems, both inherent to that
  design: (1) real pointer events fire per browser tick, not per fixed
  distance, so a slow-moving stretch of a natural, varying-speed curve
  packs many samples into a short arc length while a fast stretch covers
  the same length with few — counting every sample equally over-weights
  slow/dense stretches, visibly pulling the smoothed curve toward wherever
  the hand happened to slow down; (2) a flat box average has sidelobes in
  its frequency response — it doesn't just blur, it can invert certain
  frequency components, reading as new small oscillations on top of the
  smoothed path. Both are exactly what a squiggle riding a smooth
  intentional curve looks like, and neither is something the arc-length
  radius fix touched. **Fix:** weight each contributing raw sample by its
  own local arc-length "share" (half the gap to each neighbor, so the
  average approximates a true continuous integral instead of a sample-
  count average) AND replace the flat box weighting with a Gaussian
  falloff (`sigma = effectiveRadius/2`) — smooth, no sidelobes, no
  ringing. The endpoint-anchoring/radius-tapering from Session 12 is
  unchanged. **Verified with a direct, isolated before/after comparison**
  (live prototype monkey-patch swapping just this one method, same
  deterministic stroke script both times, per this file's established
  methodology): reproduced the bug first — a smooth circular arc traced
  with deliberately uneven sample density (dense/slow first half, sparse/
  fast second half, zero random jitter, so any measured roughness is
  purely a smoothing artifact, not real input noise) showed the OLD
  (flat-box) implementation's roughness (mean second-difference of the
  drawn centerline) actually *increasing* with stabilization — 2.10 → 2.14
  → 2.37 from level 0 to 6 to 10, i.e. more squiggle at higher
  stabilization, exactly the reported bug — while the NEW (Gaussian +
  arc-share-weighted) implementation on the identical stroke stayed flat
  to slightly improved: 2.09 → 2.10 → 2.06. Re-confirmed the Session 12
  fixes weren't lost in the process: stroke length still preserved across
  stabilization 0/5/10 for both medium (762→752→746px) and short (206→
  224→224px) strokes — no reintroduced shortening/collapse. `npx tsc
  --noEmit` clean, `npm test` 35/35 passing.
- **Smudge — audited against an explicit, correct description of the
  algorithm, with fresh live evidence rather than a bare "yes I already do
  this."** Went through the pasted critique's own checklist against the
  actual Session 12 code, one item at a time: (1) "no independent alpha/
  color of its own" — confirmed by reading `stampSmudgeDab`: it never
  reads `settings.color`/`wetColor`, its only two inputs are
  `smudgeSurface` pixels (real canvas content) and `smudgeAccum` (seeded
  from real canvas content at `down()`); (2) "lerp should happen in the
  same color space consistently" — confirmed: every blend operates
  directly on raw sRGB byte values from `getImageData`, no linear-space
  conversion anywhere in the path; (3) "a running buffer that's easy to
  get subtly wrong" (stale/uninitialized) — confirmed `smudgeAccum` is
  freshly allocated and immediately seeded from real pixels on every
  single `down()`, so it can never carry over stale content from an
  earlier unrelated stroke or start as literal garbage; (4) "no brush-
  stamp call" — confirmed `getMaskWeights` extracts only the ALPHA
  channel (a pure spatial falloff weight, 0-1 numbers) from `getStamp`'s
  cached gradient canvas, never its color — `stampSmudgeDab` has no path
  that paints the stroke's own color at all. All four already held before
  this session touched anything; this was a verification pass, not a
  rewrite. Then generated fresh live evidence rather than resting on that
  reading: a pure-grayscale scrub-loop torture test (the exact
  methodology this file has used for the historic red-tint report since
  Session 8 — wild pressure/velocity variation, straddling a black-circle
  edge for 500 dabs) came back with **0 non-gray pixels of 32,400
  scanned** (threshold as low as a 3-value RGB spread); a multi-color
  regression scene (red/green/blue corners, black square, curved variable-
  pressure drag) came back with **0 anomalies of 315,000 scanned**; a
  stroke deliberately started at the canvas corner (0,0) — the one case
  where `smudgeAccum`'s initial seed necessarily clips and leaves part of
  the patch at its zero-initialized default — then dragged across a black
  shape came back with **0 anomalies of 302,500 scanned**, confirming the
  clipped-edge-seed case (a real, narrow gap, left as-is: alpha=0 there
  just means less-opaque deposit, not a wrong hue) isn't a practical
  problem either. `npx tsc --noEmit` clean, `npm test` 35/35 passing
  (no code change to smudge this session — audit only).

**Session 12 — 2026-07-20.** The user reported Session 11's post-stroke
stabilization was badly broken ("10 just makes the line shorter... sometimes
it just deletes half the line and sometimes it just completely messes up
the line you make"), asked for it to be documented + actually researched
rather than guess-patched again, and separately asked for Smudge to be
rebuilt using a genuinely different approach than any prior attempt, plus a
general optimization pass. This entry covers all three, in the order
tackled.

- **Stabilization bug — root cause found by reading the algorithm's own
  math, not by guessing.** `buildSmoothedSamples()` (Session 11) windowed
  by raw SAMPLE COUNT: `radius = round(stabilization)`, clamped only to
  `(n-1)/2`. Two structural failures fall directly out of that design,
  both matching the user's exact reports:
  1. **"Makes the line shorter."** Near either end of the recorded path,
     the window can't extend past index 0 or n-1, so it silently became
     LOPSIDED — `[0, i+radius]` at the start, `[i-radius, n-1]` at the
     end — averaging the first point with up to 10 points *ahead* of it
     (and nothing behind), dragging the drawn start inward, with the
     mirror image at the end. The visible stroke started later and ended
     earlier than the actual gesture.
  2. **"Deletes half the line" / "completely messes up the line."** Raw
     sample count has no relationship to physical distance — a quick short
     stroke might generate only 6-10 samples. The `(n-1)/2` clamp still
     permitted a window covering the ENTIRE stroke for every sample on
     short strokes even at high stabilization, so every smoothed point
     became the same global average of the whole path — the stroke
     collapsing toward its own centroid, which reads exactly like
     "deleted" or "messed up," not smoothed.
  - **Research note, logged honestly:** the plan was to ground the fix in
    how production apps (Krita's open-source "Stabilizer," Procreate-style
    smoothing, the general "one euro filter" literature) actually handle
    this, via `WebSearch`. That tool hit its session rate limit before any
    query returned (three attempts, all rejected — resets on a timer, not
    something a retry-loop should chase). The fix below is grounded in
    first-principles signal-processing reasoning instead (a moving-average
    box filter's well-known boundary-bias and window-vs-signal-length
    failure modes), not external sources — flagging this explicitly rather
    than implying real research happened. **If picked up again and a truly
    external-prior-art-grounded design is wanted, retry `WebSearch` for:
    "Krita stabilizer algorithm," "stroke smoothing moving average vs
    spline endpoints," "one euro filter pointer input smoothing" — the
    exact queries attempted this session, unrun.**
  - **Fix:** window by ARC LENGTH (real pixels along the path) instead of
    sample count, and shrink that window automatically as a sample nears
    either true endpoint: `effectiveRadius(i) = min(desiredRadius,
    distanceFromStart(i), distanceToEnd(i))`. Both endpoints sit at
    distance 0 from themselves, so their effective radius is always
    exactly 0 — the true start/end pixel is now *never* touched by
    construction, which is what actually stops the "shorter line" failure
    (not a tuning tweak, a structural guarantee). The same clamp means a
    short stroke (total length < `2 * desiredRadius`) can never have any
    sample's window reach more than half the stroke, so the centroid-
    collapse failure mode is also structurally impossible now, regardless
    of how many raw samples happen to fall inside that length.
    `desiredRadius = stabilization * 8px` — real screen pixels, not brush
    size or sample count, so correction feels consistent across brush
    sizes and drawing speeds (a real, separate inconsistency the old
    sample-count design also had: a fast flick generates fewer samples
    over the same distance than a slow careful stroke, so the same
    stabilization value smoothed them by different effective amounts).
  - **Verified live**, via real `PointerEvent` drags dispatched through the
    actual UI slider (not direct engine calls): (1) stroke LENGTH measured
    before/after for both a ~700px stroke and a deliberately short ~150px
    stroke (the collapse-prone case) at stabilization 0/5/10 — medium:
    762px → 742px → 740px; short: 206px → 218px → 218px. Both stay within
    natural brush-cap variation, neither shortens progressively nor
    collapses — the reported bug is gone. (2) Smoothing still genuinely
    works: a realistic broadband-jitter stroke (deterministic pseudo-random
    per-sample offset, not a pure sine — a pure sine hit box-filter sinc-
    response sidelobes and gave a misleadingly non-monotonic result on the
    first measurement attempt, corrected by switching to jitter that
    resembles real hand tremor) measured roughness (mean consecutive-
    center delta) of 5.6 at stabilization 0 falling monotonically to 2.8 at
    stabilization 10 — a real, substantial, monotonic smoothing effect,
    now without the endpoint/collapse bugs. `npx tsc --noEmit` clean,
    `npm test` 35/35 passing.

- **Smudge rebuilt — deliberately NOT via canvas composite operations this
  time**, per the user's explicit "without going the same route as
  before." Every prior attempt (Sessions 7-10) was built from stacked
  Canvas 2D composite calls (`destination-out`/`source-over` layering),
  and each one produced a different hard-to-reason-about artifact from
  that same source: a light centerline (dab-overlap saturation), an
  infinite "soliton" trail (a capture-window/deposit-footprint mismatch),
  8-bit rounding stalls in repeated low-alpha composites. All three took a
  full session each to even understand, because several stacked alpha-
  blending operations interacting is genuinely hard to reason about by
  inspection. This session's version (`src/engine/brushEngine.ts`) keeps
  the parts of the architecture Session 10 validated as conceptually
  correct by direct measurement (a live self-referential working surface;
  a masked LERP deposit, not brush-like alpha accumulation; a partial-
  blend recapture for real carry distance instead of instant local
  diffusion; throttled dab spacing — processing a step only every ~30% of
  dab size traveled, since a soft mask this wide at the shared stamping
  loop's normal ~5% spacing overlaps its own preceding dabs ~10+ times
  before moving on, which overwhelms any per-dab tuning) but replaces the
  MECHANISM entirely:
  - Reads/writes raw `ImageData`/`Uint8ClampedArray` pixel data directly
    via `getImageData`/`putImageData`, with the deposit-then-recapture
    lerp computed as one explicit numeric formula per pixel
    (`dest = dest*(1-w) + accum*w`, then `accum = accum*(1-rate) +
    dest'*rate`) — no composite-mode stacking to reason about at all, and
    the two steps are merged into a single pass over each dab's pixels
    (an optimization: half the loop iterations of the first working
    version, same math).
  - The carried patch (`smudgeAccum`) is a plain `Float32Array`, not a
    canvas — it stays in full float precision across the whole stroke
    instead of round-tripping through 8-bit canvas storage every dab,
    directly removing the specific mechanism (repeated 8-bit rounding in
    canvas composites) suspected as a source of gradual hue drift in every
    earlier version.
  - Dab geometry (mask size, and therefore the accum/weight array
    dimensions) is fixed for the whole stroke, decided once in `down()` —
    taper/pressure modulate blend *strength* per dab, not the footprint.
    This removes an entire class of bug every earlier version had to
    handle (resampling a fixed-size carried patch into each dab's own
    differently-sized mask, and getting that resampling right was itself a
    repeated source of edge/aliasing artifacts) — with geometry fixed,
    mask and accum always match exactly, so there's nothing to resample.
  - The soft round mask weight array (`getMaskWeights`) is extracted once
    from `getStamp()`'s own already-cached gradient canvas (via its alpha
    channel), memoized per stamp canvas in a `WeakMap` — reuses the exact
    same falloff every other brush style renders instead of computing a
    second copy of the same gradient math by hand, and pays the one-time
    `getImageData` extraction cost once per unique dab size, not once per
    dab.
  - `recomposite()` still needs a small dedicated branch for Smudge (its
    result IS the live `smudgeSurface`, not `wetBuffer`) — same as every
    prior version, unavoidable given how Flow/Opacity/Alpha-Lock apply.
  - Type plumbing (`"smudge"` in `EditorTool`/`BrushStyle`,
    `smudgeStrength` in `BrushSettings`), UI (`Toolbox.tsx`'s tool button,
    `ToolPalette.tsx`'s Smudge Strength slider), and store wiring
    (`editorStore.ts`'s `smudgeMemory`/`defaultSmudge`/
    `setSmudgeStrength`/`PAINT_TOOL_MEMORY_KEY` entry) were all restored
    to exactly the shape they had before Session 11's deletion.
  - **Verified live**, both via direct engine calls and real `PointerEvent`
    drags through the actual UI with the Smudge tool selected: (1)
    genuine strength-tunable color transport over real distance (a
    black-circle-into-white drag at strengths 0.3/0.5/0.7/0.9 showed
    consistently graded, progressively-longer-carrying trails, not a
    plateau-then-cliff and not an un-fading solid block); (2) no
    centerline inversion at any tested strength (cross-profile center
    always ≤ flank brightness, i.e. darkest at center, the physically
    correct shape); (3) 0 chromatic anomalies across 125,000 scanned
    pixels on a multi-color regression scene; (4) a real drag dispatched
    on the actual canvas through the actual Smudge tool button produced a
    genuinely graded trail (47→80 and climbing, not solid or blank).
    `npx tsc --noEmit` clean, `npm test` 35/35 passing.
  - **Known, honest limitation carried over from the architecture, not
    hidden:** dab geometry fixed per stroke means a single stroke can't
    smoothly vary its own smudge radius with pressure the way a normal
    paint brush does. This was a deliberate trade for removing the
    resampling-artifact bug class entirely; revisit only if it turns out
    to matter in practice.
- **Optimization pass:** scoped to the engine code this session actually
  touched, not a full-codebase audit (that would be a much larger,
  separate effort, and re-scanning unrelated code for its own sake wasn't
  asked for). Concrete change: merged Smudge's deposit and recapture pixel
  loops (originally two full passes over each dab's region) into one —
  same math, half the per-dab iteration count, verified to produce
  identical output before/after (re-ran the strength-sweep transport test
  and got the same profile values). Scanned `documentCanvas.ts` for
  per-pointer-event costs (the main other hot path in this codebase) and
  found one minor, low-priority one worth naming rather than silently
  leaving: `getBrushSettings()` does a linear `layers.find()` over the
  active layer list on every pointer-down/move — genuinely trivial at
  realistic layer counts (a handful to a few dozen), so left as-is rather
  than added complexity for no measurable benefit; noting it here so it's
  a documented, deliberate non-fix rather than an overlooked one.

**Session 11 — 2026-07-20.** After Session 10's throttled-partial-blend
smudge rework, the user made a call on the whole feature rather than asking
for another fix: rip it out entirely ("delete smudge as a whole ... so we
can then come back to it with a clean slate") rather than keep iterating
live, since four sessions of "fix, ship, still wrong" had made it a net
negative for how the app feels to use. Also asked for two unrelated things
in the same message: stabilization should be a POST-stroke recalculation
(average the recorded path once the pointer lifts and redraw the corrected
result), not a real-time per-move filter — their own reasoning being that
continuous real-time smoothing cost more while actively drawing — exposed
as an integer 0-10 ("0 no correction, 10 max") rather than a percentage.

- **Smudge removed entirely**, not disabled or hidden — every trace of it,
  per the explicit ask for a genuinely clean slate to rebuild from later.
  Removed from: `src/engine/brushTypes.ts` (`"smudge"` out of `EditorTool`/
  `BrushStyle`, `smudgeStrength` out of `BrushSettings`); `src/engine/
  brushEngine.ts` (`SMUDGE_PICKUP_RATE`, the `smudgeSurface`/`carriedPatch`/
  `smudgeScratch`/`lastSmudgeProcessPos` fields, `captureSmudgePatch()`,
  `stampSmudgeDab()`, the smudge branches in `recomposite()`/
  `makeDabPainter()`/`down()`); `src/stores/editorStore.ts`
  (`smudgeMemory`/`defaultSmudge`/`setSmudgeStrength`/the `smudge` entry in
  `PAINT_TOOL_MEMORY_KEY`, and `smudgeStrength` out of every `BRUSH_PRESETS`
  entry and `ToolSettings`); `src/components/Toolbox.tsx` (the Smudge tool
  button); `src/components/ToolPalette.tsx` (the Smudge Strength slider and
  its `brushStyle === "smudge"` branches); `src/engine/documentCanvas.ts`
  (`smudgeStrength` out of `getBrushSettings()`); `src/engine/
  brushEngine.test.ts` (out of the test fixture). Verified: `grep -ri
  smudge src` returns nothing, `npx tsc --noEmit` clean, `npm test` 35/35.
  **If a future session picks this back up:** the Session 8-10 Alpha Log
  entries below are still the real, hard-won history of what was tried —
  wetBuffer-accumulator (centerline artifact), live-surface full-replace
  (reads as local diffusion, not transport), and throttled partial-blend
  (the last state, which the user found still wrong in practice despite
  passing every pixel-level regression check this file's own verification
  discipline could devise) — worth reading before re-attempting, but don't
  assume the last approach was "almost right"; the user's real-world
  judgment after actually painting with it is the standard that matters
  here, not another round of synthetic pixel metrics.
- **Stabilization reworked from a real-time filter to a post-stroke
  recalculation**, per the user's explicit design (`src/engine/
  brushEngine.ts`, `HighPerformanceBrushStroke`). Previously,
  `tuning.stabilization` (0-0.95) drove an exponential "follow" lerp inside
  `move()` — the drawn position continuously chased the raw pointer sample
  with a lag proportional to the setting, every single move event. Now:
  `move()`'s real-time path tracks the raw sample directly (zero added
  lag — `this.smooth.x = sample.x`, not a lerp), so live drawing has no
  stabilization-related cost or latency at all. Every raw sample (`down()`'s
  and each `move()`'s) is recorded into a new `rawSamples` array; `flush()`
  finishes the raw stroke exactly as before (so if stabilization is 0,
  nothing further happens), then — if `tuning.stabilization > 0` and at
  least 3 samples were recorded — calls a new `buildSmoothedSamples()`
  (a symmetric moving-average box filter over x/y only, window radius in
  SAMPLES equal to `round(stabilization)`, i.e. the literal 0-10 scale the
  user asked for, capped to what the recorded path can support) and REPLAYS
  the whole stroke against that smoothed path: a new `beginReplayPass()`
  resets per-stroke rendering state the same way `down()` does but
  deliberately does NOT re-snapshot `preStroke` from `ctx` (which at that
  point holds the just-drawn RAW stroke, not the true pre-stroke layer) —
  `preStroke` was already captured once, correctly, by the real `down()` at
  gesture start, and is reused as-is; only `wetBuffer` is cleared. The
  replay then drives the exact same per-dab stamping logic as live drawing
  (extracted `move()`'s body into a new private `advance()`, called
  directly — bypassing `move()`'s own down()-triggering guard and its
  `rawSamples`-recording, both of which would be wrong for synthetic replay
  samples) for each smoothed sample, and finishes by calling `flush()`
  itself again for the tail — reusing all of its existing end-taper/short-
  tap logic instead of duplicating it — guarded by a new `replaying` flag so
  that recursive call can't trigger a second round of stabilization on
  itself. `src/stores/editorStore.ts`'s `stabilization` field changed from a
  0-1 float to a 0-10 integer scale (default 4); `src/components/
  ToolPalette.tsx`'s slider changed from a 0-95%-with-`/100`-conversion
  control to a plain 0-10 integer slider (no suffix).
- **Verified live**, not just by reading the diff: real `PointerEvent`
  drags dispatched on the actual canvas through the actual UI (not direct
  engine calls) with a strong artificial hand-wobble (a 40px-amplitude sine
  wave perpendicular to the stroke direction, matching what a real shaky
  hand would look like at an exaggerated scale) — at Stabilization 0, the
  resulting stroke's measured vertical center-line wobble was stddev ≈30.1
  (tracking the raw sine input); at Stabilization 10, the exact same input
  path produced a stroke with stddev ≈0.98 — visually and numerically
  almost perfectly straight, the sine wobble averaged away almost entirely,
  confirming the post-release recalculation genuinely fires and genuinely
  corrects the path, driven through the real slider (a native `input`/
  `change` event dispatch, read back via the displayed label re-rendering
  from live store state, not a stale DOM value) rather than only a direct
  API call. Also confirmed a degenerate single-tap stroke (`pointerdown`
  immediately followed by `pointerup`, zero `move()`s, i.e. fewer than the
  3 raw samples `buildSmoothedSamples()` requires) neither crashes nor
  fails to paint — it falls through the `< 3 samples` guard and skips the
  replay entirely, leaving the tap's own dot as the (correct, already-final)
  result. `npx tsc --noEmit` clean, `npm test` 35/35 passing throughout.

**Session 10 — 2026-07-20.** The user reported that the previous session's
"fixed" smudge (the live working-surface architecture below) still wasn't
right — correctly, and specifically: "it isn't a brush in a common sense it
works as a distortion normal smudge is like when you pick your finger and
smear/smudge it with that said color somewhere." This was a real,
substantive miss by the prior session's verification, not a duplicate
report — that session's pixel-level checks (fade monotonicity, centerline
symmetry, chromatic scan) all genuinely passed, but none of them actually
tested for DIRECTIONAL COLOR TRANSPORT over a real distance, which is the
one thing a smudge tool is fundamentally for. Root-caused properly this
time, fixed, and re-verified with a test that specifically targets what was
missing before. Also fixed two small requested items while in the area:
the Focus Mode button overlapping Undo/Redo, and added a Stabilization
slider (previously tunable only in code, never exposed in the UI).

- **Smudge: found why the "fixed" version still read as distortion, not
  smearing — a real architectural gap, not a tuning miss.** Live-tested a
  long drag of solid black across white at strengths 0.3/0.5/0.7/0.9 (the
  literal user-described repro: does color visibly *carry* a real distance,
  fading gracefully, the way dragging a finger through wet paint does) and
  found: 0.3 plateaued at a constant mid-gray (153) instead of fading, and
  0.5/0.7/0.9 stayed **fully opaque solid black for the entire 700px drag**
  — the "carry" wasn't a smear at all, it was a rigid, undecaying block
  moving with the cursor. **Root cause:** dabs land every ~5% of brush
  diameter (`stampAlongSegment`'s existing spacing, shared by every brush
  style), but each smudge dab's soft mask is a full brush-radius wide — so
  any given canvas pixel gets re-touched by the SAME dab's deposit
  ~10+ times in a row before the mask ever moves past it (radius ÷ spacing
  ≈ 10). Each of those re-touches independently lerps that pixel toward the
  carried patch, and — critically — the very same pixel is what
  `captureSmudgePatch`'s live-surface recapture immediately samples back
  into the patch. With ~10 compounding lerps per pixel before the mask
  moves on, the "fresh" content the recapture picks up is never actually
  fresh original canvas — it's overwhelmingly the tool's OWN just-deposited
  output from the previous few dabs, because genuinely untouched canvas is
  only a thin crescent at the very leading edge of a mask this wide at this
  spacing. No pickup-rate or decay constant can fix this: the self-
  reinforcement happens through 10+ compounding applications of the SAME
  per-dab strength, which overwhelms any single-dab decay tuning long before
  it can express itself. This is a distinct bug from anything found last
  session (which all tested single-dab-scale effects: centerline shape,
  chromatic bleed, short-range fade) — it only shows up when checking
  transport over a realistic drag distance, which nothing in the last
  session's verification battery did.
- **Fix:** added a throttle to `stampSmudgeDab` (`src/engine/brushEngine.ts`)
  — track the position of the last dab actually PROCESSED for smudge
  purposes (`lastSmudgeProcessPos`, reset in `reset()`), and skip the
  deposit+recapture entirely unless the pointer has moved at least ~30% of
  the current effective brush size since then. This is deliberately scoped
  to smudge only (doesn't touch `stampAlongSegment`'s shared spacing, which
  is still right for every other style's fine-grained taper/pressure
  response) — it just makes smudge itself react to a coarser subset of the
  same dab stream. Coarser spacing means each pixel is only re-touched ~2-3
  times before the mask passes on, not 10+, which is what actually lets a
  meaningful fraction of genuinely fresh canvas reach the recapture. Restored
  `captureSmudgePatch` to a partial blend (`SMUDGE_PICKUP_RATE = 0.2`,
  matching the classic algorithm's real memory mechanic — see its own doc
  comment for the two wrong designs this went through and why, both measured
  before landing here) rather than the full-replace variant from earlier
  this session, since with the self-reinforcement problem solved by the
  throttle, partial blend is what gives Smudge Strength continuous control
  over carry distance (higher strength = slower decay = longer smear) instead
  of a binary "some carry / no carry."
- **Verified live, specifically re-running the test that would have caught
  this last session:** long drag across white at strengths 0.3/0.5/0.7/0.9
  now shows genuine, monotonically-graded smearing — e.g. strength 0.5's
  profile at 30px steps: 56 → 92 → 138 → 166 → 171 → 178 → 182 → 194 → 216 →
  233 → 237…, a real gradual fade over hundreds of pixels, not a plateau and
  not a rigid block; strength 0.9 correctly carries much further (still
  dark at 40, fading only past ~500px) while strength 0.3 fades faster (near
  white by ~150px) — Smudge Strength now controls smear DISTANCE the way a
  user would expect, not just deposit opacity. Re-ran every previous
  regression check to confirm the throttle didn't reopen anything: centerline
  cross-profile still darkest-at-center at every strength tested (no
  inversion); white-into-black carry still a smooth gradient (213→139→109→
  100→55→6); chromatic scan still 0 anomalies of 125,000 scanned pixels on
  the multi-color regression scene; the 25-loop tight-scrub-near-an-edge
  torture test still shows 0% dark contamination and stddev 26 (down from the
  original bug's ~47, in line with last session's fix). `npx tsc --noEmit`
  clean, `npm test` 35/35 passing.
- **Focus Mode button overlapping Undo/Redo — fixed by removing the
  overlap-prone architecture, not by nudging coordinates.** Root cause: the
  floating Focus toggle was `absolute`-positioned at a fixed `right-24`
  offset that had been tuned for an old TopBar layout; once TopBar's actual
  Undo/Redo buttons (with their icon+label content) reached that same
  horizontal band, the floating button silently started sitting on top of
  them — confirmed live via `getBoundingClientRect()`: Focus spanned
  x:1101.5-1184, Undo x:1069-1165.6, a real, measurable overlap, not a
  visual coincidence. **Fix:** moved the Focus toggle to be a normal flex
  item inside `TopBar.tsx`'s own right-hand button group (after Redo) for
  the entire time TopBar is actually visible, so it can never collide with
  siblings it shares a flex row with — no magic-number position to go stale
  again. The old floating `absolute` button in `App.tsx` is now only
  rendered at all while Focus Mode is ACTIVE (i.e., exactly when TopBar
  itself is faded out and there'd otherwise be nothing to click to exit) —
  `TopBar` gained an `onEnterFocusMode` prop, `App.tsx` only renders the
  floating "Show UI" exit button conditionally on `isFocusMode`. Verified
  live: `getBoundingClientRect()` on Focus/Undo/Redo post-fix shows zero
  overlap (a plain `overlap()` rectangle-intersection check on all three
  pairs returns false); clicking TopBar's Focus button correctly enters
  Focus Mode (confirmed via the resulting className including `opacity-0`
  on TopBar's wrapper — this environment's known frozen-CSS-transition
  quirk, see ground rules, made the *computed* opacity read stale as `1`,
  but the actual applied className proves the logic fired correctly, the
  established way this file's ground rules say to resolve that quirk);
  clicking the resulting floating "Show UI" button correctly exits, after
  which it unmounts and TopBar's own Focus button reappears with zero
  overlap versus Undo/Redo, unchanged from before entering Focus Mode.
- **New Stabilization slider** — this control existed in the engine
  (`BrushEngineTuning.stabilization`, used by `HighPerformanceBrushStroke`'s
  own smoothing math) since early in the project but was never exposed in
  the UI; every session's brush work tuned it in code only. Added
  `stabilization` + `setStabilization` to `src/stores/editorStore.ts` as a
  **global** setting (default 0.35, matching `DEFAULT_BRUSH_TUNING`) —
  deliberately NOT part of `ToolSettings`/the per-tool memory system like
  size/hardness/etc., since it's an input-smoothing feel preference that
  should stay put across tool switches, not a paint parameter. New
  `DocumentCanvas.syncBrushTuning()` (`src/engine/documentCanvas.ts`) pushes
  the store's value into `this.brush.setTuning({ stabilization })`, called
  once on every pointer-down (cheap — `setTuning` just merges into the
  running tuning without resetting stroke state). New Slider in
  `ToolPalette.tsx`, placed in the always-visible group right after Flow
  (not buried in Advanced) since it's as fundamental to stroke feel as
  Hardness, which this file's own established reasoning already keeps
  visible for the same reason. Range 0-95% (not 0-100) to match the engine's
  own hard clamp (`Math.min(0.95, ...)`) exactly, so the slider has no dead
  zone at its own top end. **Verified live, end-to-end, not just that the
  slider renders:** opened the real Brush Settings overlay, confirmed the
  default reads 35% (matching the store default), dragged it to 80% via a
  real `input`/`change` event dispatch, confirmed the store's value actually
  changed (the displayed "80%" label re-rendered from live store state, not
  a stale DOM value) and, going one step further, confirmed the value
  actually reaches the engine: called the live `DocumentCanvas` instance's
  own `syncBrushTuning()` (the same private method `onPointerDown` calls)
  via `documentEngineRef` and read back `brush.tuning.stabilization` — `0.8`,
  matching the slider exactly. `npx tsc --noEmit` clean, `npm test` 35/35
  passing.

**Session 9 (cont'd) — 2026-07-20.** The user reported Smudge still broken
after the depletion-grid work below, with a NEW, precise symptom: a
light/white line running down the center of every smudge stroke, plus the
recurring color-bleed report — and correctly diagnosed the shape of the
problem themselves ("behaving like it's laying down a brush stroke with its
own color/opacity along the stroke path"). This session root-caused the
centerline (measured, not guessed), then ended up replacing the entire
smudge deposit architecture. Everything below was measured live via the
established `documentEngineRef` + direct `brush.down()/move()/flush()`
method; every intermediate attempt was verified by pixel measurement before
being kept or reverted.

- **Centerline root cause, proven by measurement:** the Session-8 erase disc
  (a full-alpha `destination-out` punched along the exact stroke path to
  fight wet-buffer alpha saturation) caps accumulated alpha at the
  centerline at what ~3 post-erase dabs can rebuild, while the flanks —
  outside the small erase radius — accumulate over ~20 overlapping dabs.
  Measured perpendicular profile at strength 0.25: flanks 60-66,
  centerline 89-95 — a light line, exactly the user's screenshot. The
  deeper diagnosis (matching the user's own): smudge was structurally
  *brush-like alpha deposition into an accumulator* (stamp → saturate →
  erase-hack), when a real smudge must lerp the actual surface.
- **Rework: live working-surface architecture** (`src/engine/
  brushEngine.ts`): a full-layer `smudgeSurface` copied from the layer at
  `down()`; each dab per-pixel lerps it toward the carried patch —
  `surface = surface·(1−s·mask) + carried·s·mask`, built from two
  matched-alpha composites (`destination-out` of the mask at alpha s, then
  `source-over` of the masked patch at alpha s) — and the patch is
  recaptured from the live surface. `recomposite()` gained a smudge branch
  presenting `preStroke` + surface at Opacity (Alpha Lock respected).
  wetBuffer, the erase disc, `SMUDGE_PICKUP_RATE`, and the depletion grid
  are all GONE for smudge — repeated overlapping dabs relax toward the
  carried content instead of accumulating, so there is nothing to
  erase-hack around.
- **Four measured dead ends on the way to the final fix, recorded because
  each refutes a "reasonable" idea a future session might retry:** (1) the
  bare rework produced trails that settled into a translation-invariant
  constant-gray band persisting 6+ brush-widths (a "soliton" — at ~5% dab
  spacing the patch center only ever re-samples its own deposits); (2) a
  continuous per-dab lookahead pickup killed the soliton but stalled in
  8-bit compositing at exactly the predicted quantization boundaries
  (measured flat tails at 251/221 — `(255−221)·0.015 ≈ 0.5` rounds to
  zero forever; note this stall mechanism is ALSO a real, measured
  candidate for the historic red-tint reports, since per-channel stall
  levels differ, leaving permanent residual tint); (3) chunked
  gradient-weighted pickups fixed the fade but injected white along the
  centerline (inverted cross profile, center 206 vs flank 130 — the
  lookahead sample is pure white dead ahead on the stroke axis); (4) a
  crescent-clip "deposit exactly once" scheme deposited nothing at all
  (with a soft mask at 5% spacing, the previous dab's disc excludes
  everything but the mask rim, where falloff alpha ≈ 0).
- **The actual fix, found by re-examining the soliton's engine:** the
  carried patch was captured at a FIXED seed size (~2× the
  pressure-scaled dab) while deposits went out at the dab's own size — the
  capture window's outer ring read surface *outside* the deposited area
  (old trail history) and the deposit's down-scaling folded that history
  back into the next dab's core. That size mismatch, not
  recapture-after-deposit per se, was the feedback loop sustaining
  infinite tails. Fix: `captureSmudgePatch` now samples exactly the
  depositing dab's mask footprint (scaled into the fixed patch canvas).
  With capture matched to deposit, the patch↔surface loop contracts
  naturally and every artificial decay mechanism became unnecessary and
  was deleted. Final code is *simpler* than what preceded it: seed copy +
  masked lerp + matched-footprint recapture, no tuning constants at all.
- **Verified live, full battery:** (1) centerline: cross profiles now
  darkest-at-center at every strength (e.g. s0.7: 255→162→109→70→93→111→
  182→255, symmetric taper; the s0.25 inversion case that read center 246
  vs flank 233 pre-fix now reads non-inverted) — the reported artifact is
  gone; (2) fade family: monotonic in strength — 28px smear at 0.25,
  68-72px gradual fades at 0.5-0.6, long drag at 0.75-0.9, infinite
  finger-painting carry at 1.0 (correct Photoshop semantics), all lower
  strengths fading fully to background (a faint bounded ~243 tail at 0.75
  noted as acceptable); (3) white-into-black: 255→170→36…36→24 — strong
  gradual carry preserved; (4) chromatic: 0 anomalous pixels of 125,000
  scanned on the multi-color regression scene; (5) extended scrub (25
  tight loops over a source edge): dark contamination 0.38% vs 4.3% at
  the original bug level, smooth streak-free scan. `npx tsc --noEmit`
  clean, `npm test` 35/35 throughout. (Screenshots still unreliable in
  this environment per ground rules; all verification is direct pixel
  measurement.)

**Session 9 — 2026-07-20.** Picked up per the user's direct request to tackle
"the bigger rework of smudge" — Session 8's Alpha Log entry had already
identified the remaining "ugly lines during extended scrubbing" sub-issue of
10.1 as architectural (a single global carried-patch-with-decay doesn't
cleanly handle a tight loop re-crossing a source edge) and recommended
"spatially-local decay instead of one global per-stroke carried patch" as the
likely real fix. This session implemented that, but only after a first
attempt was tried, measured, and found to make things worse — recorded in
full since the negative result is itself real signal for any future session
tempted to try the same thing.

- **First attempt (reverted): make `captureSmudgePatch` read the stroke's own
  live `wetBuffer`, not just frozen `preStroke`.** Reasoning: real smudge
  tools are self-referential — dragging back over the same spot should blend
  toward what's already been smudged there, not keep re-grabbing the original
  pixels. Implemented as a new `composeLivePatch()` compositing a small
  (`w`×`h`, dab-sized) `preStroke + wetBuffer*opacity` view for each capture,
  matching `recomposite()`'s own compositing rules (respecting `alphaLocked`).
  `npx tsc --noEmit` clean, `npm test` 35/35 passing — looked done.
  **Verified live before trusting it, per this file's established rule, and
  it failed verification:** reproduced Session 8's exact scenario (a tight
  circular scrub straddling a black-circle-on-white edge, live via
  `documentEngineRef` + direct `brush.down()`/`move()`/`flush()` calls, real
  variable pressure) and measured a roughness/reversal metric (sum of
  horizontal-gradient magnitude + directional sign-change count) over the
  scrubbed region, comparing the live-feedback version against the original
  preStroke-only version via a live prototype monkey-patch (swap
  `composeLivePatch`, rerun on a freshly-repainted canvas, swap back) so both
  ran the exact same deterministic stroke script. Across three different
  parameter configs (varying scrub radius, brush size/hardness, strength,
  loop count, pressure frequency), the live-feedback version was **worse in
  every single config**: roughness +19% to +48%, reversals +6% to +134%
  (e.g. config 1: 95,980 → 124,420 roughness, 51 → 54 reversals; config 3:
  55,559 → 67,679 roughness, 32 → 75 reversals). **Root cause of why the
  reasonable-sounding idea backfired:** `wetBuffer` carries this same
  stroke's own hard-edged `destination-out` erase-disc artifacts (the
  small-radius erase step from Session 8's "acts like a brush" fix, still
  needed and still correct on its own). Reading `wetBuffer` back into the
  capture doesn't just carry the intended *content*, it also carries those
  compositing artifacts forward, and every subsequent dab that samples from
  that spot compounds them further — a genuine feedback-noise-amplification
  loop, structurally the same class of problem Sessions 3-4 already knew to
  avoid for Blur/Color Mix (their own doc comments explicitly warn against
  reading live self-modified content mid-stroke), just not obviously
  applicable to Smudge until actually measured. **Reverted** — removed
  `composeLivePatch` and the `liveScratch` scratch canvas entirely, restored
  `captureSmudgePatch` to read only `preStroke` as before.
- **Second attempt (kept): a per-stroke spatially-local "depletion" grid,
  decaying the *pickup rate* rather than reading pixel content back.**
  Design: `HighPerformanceBrushStroke` gained a coarse (8px-cell)
  `Float32Array` grid (`depletionGrid`), reset to all-zero in `down()` (only
  allocated/reset for Smudge strokes), storing a `[0,1]` "how worked-over is
  this area, this stroke" value per cell. `depletionAt(x,y)` reads it (0 if
  no grid or out of bounds); `depleteAt(x,y,radius,amount)` raises it within
  a radius with linear falloff, capped at 1. `captureSmudgePatch()` now
  multiplies `SMUDGE_PICKUP_RATE` by `(1 - depletionAt(x,y))` before using it
  (both the `destination-out`-clear alpha and the fresh-sample alpha, kept
  equal as before), and `stampSmudgeDab()` calls `depleteAt(x, y, w/2, 0.12)`
  after every dab (0.12/visit saturates a spot to ~1, i.e. ~zero further
  pickup, after roughly 8 revisits within one stroke — tuned to survive a
  normal single pass untouched while still meaningfully damping a tight,
  many-times-looped scrub). Crucially, this never reads any actual pixel
  content back — it only ever scales a blend-rate scalar — so it structurally
  cannot compound compositing noise the way the first attempt did.
- **Verification, this time with a metric actually targeted at the reported
  symptom** (the generic roughness/reversals metric above turned out to be
  dominated by the stamp-and-drag algorithm's own inherent ring texture —
  present regardless of any fix — and was *not* a good proxy for "dark
  streaks reappearing in a spot that already faded toward white"; it even
  scored the depletion-grid version as slightly "rougher" by that same crude
  metric, which would have been a false negative if trusted at face value).
  Switched to measuring, in the originally-*white* area the scrub actually
  reached (outside the source circle's radius, within the scrub's reach):
  brightness mean/stddev and the fraction of pixels still notably dark
  (`<100`, i.e. never properly faded — the direct proxy for the reported
  bug). Same three configs, same before/after monkey-patch methodology (this
  time toggling `depleteAt` to a no-op to reproduce the pre-fix behavior on
  an identical stroke script): **dark-contamination fraction dropped from
  ~4.1-4.3% to exactly 0% in all three configs**, and brightness stddev in
  that region dropped ~35% (e.g. config 1: 47.29 → 30.50) in all three,
  while mean brightness barely moved (232.74 → 232.71, i.e. overall fade
  depth/character preserved, not over-corrected). Then checked for
  regressions against the two previously-fixed sub-issues, since depletion
  only ever accumulates after repeat visits and should be a no-op on a
  single pass: (a) re-ran the exact white-into-black straight-drag repro —
  brightness came back `231 → 173 → 128 → 98 → 78 → 24`, a smooth monotonic
  fade with no plateau and no cliff, matching Session 8's fixed behavior
  exactly; (b) re-ran the multi-color chromatic regression test (red/green/
  blue corners + a black square, smudge dragged only through the black
  square and empty space) — zero R/G/B channel anomalies across 125,000
  scanned pixels, confirming no interaction with the (separate, still
  unreproduced) red-tint sub-issue. `npx tsc --noEmit` clean, `npm test`
  35/35 passing throughout both attempts.
- **This closes the "ugly lines during extended scrubbing" sub-issue of
  10.1** with a real, measured fix — not a guess, and not the first idea
  that came to mind either (that one was tried, measured, and rejected on
  its own merits before this one replaced it). The red-tint sub-issue
  remains open exactly as Session 8 left it: still unreproduced after three
  sessions of code-level investigation, still needs a concrete repro from
  the user (actual project file or exact reproduction steps) rather than a
  fourth round of synthetic attempts.

**Session 8 — 2026-07-19.** Picked up per this file's own instructions,
starting with Section 10.1 (the explicit "do this first" bug) per the
Execution Order section.

- **Section 10.1 (smudge red-tint bug) — investigated again, still not
  reproduced; leading hypothesis now refuted, not just re-guessed.**
  Reused Session 7's `documentEngineRef` + direct `brush.down()`/`move()`/
  `flush()` live-testing method (real production code path, avoids this
  environment's synthetic-PointerEvent timing issues), but went further than
  Session 7's constant-velocity test: three separate scenarios, each with
  strong pressure variation (0.02–1.0, non-monotonic) and strong speed
  variation (6–96ms between samples), specifically designed to force
  `effSize` to swing wildly relative to `carriedPatch`'s fixed captured size
  — the exact condition Session 7's hypothesis 1 (stale RGB under near-zero
  alpha, revealed when `drawImage` rescales the patch) needed and Session
  7's own constant-velocity test hadn't exercised. (1) Opaque black circle
  on opaque white — a smudge stroke through this can never have any
  low-alpha pixels, confirming the test setup first. (2) Transparent
  background with only a black circle painted, stroke straddling
  fully-opaque-to-fully-transparent repeatedly — dumped `carriedPatch`'s raw
  `getImageData` afterward: **9,604 of 9,604 patch pixels were non-fully-
  opaque, zero had any stray RGB above 8 at any alpha level** — directly
  showing the browser's canvas storage already zeroes RGB at low alpha
  (premultiplied-alpha storage), refuting the hypothesis at the CPU-canvas
  level. (3) A deliberate multi-color canvas (red/green/blue/black squares in
  separate corners) with a long, wide (220px), 400-dab smudge drag through
  *only* the black square and empty transparent space, kept entirely clear
  of the colored squares — scanned both the CPU canvas (`ctx.getImageData`)
  and, going one step further than Session 7, the actual **GPU-rendered
  output** via `app.renderer.extract.pixels(sprite)` (ruling out a
  Pixi/WebGL-side texture-upload or premultiply issue that CPU-side canvas
  inspection alone couldn't catch) — both came back with **zero pixels**
  showing any R/G/B channel divergence anywhere in the smudge-touched region
  (480,000 pixels scanned). (An initial pass of this same test scanned the
  *whole* 2048×2048 canvas including the untouched red/green/blue squares
  and wrongly flagged them as "anomalies" — caught and corrected by
  re-scoping the scan to only the region the smudge drag actually passed
  through, which came back clean.)
- **Conclusion:** two independent sessions, using different methodologies
  (constant-velocity vs. deliberately extreme variable-velocity/pressure;
  CPU-only vs. CPU+GPU pixel inspection), have both failed to reproduce any
  chromatic corruption from the current Smudge implementation. This is
  meaningfully stronger evidence than "we tried once and it didn't happen" —
  the specific mechanism Session 7 flagged as most likely has now been
  directly measured and ruled out at both the canvas-storage and
  GPU-texture level. Per this file's own instruction not to guess-fix,
  **no code change was made** — see the new "Next step" note added to
  Section 10.1 below recommending the next session get a concrete repro
  (the actual project file, or exact reproduction steps) from the user
  rather than attempting a third round of synthetic reproduction, since
  Session 7's own Alpha Log already flagged a plausible non-bug explanation
  (leftover test content from live-testing sessions, off-screen or
  layer-hidden, being correctly dragged by an otherwise-working smudge tool).
- **Section 11 (panel layout rework) — DONE**, after checking in with the
  user on the decision point that section explicitly flagged (docked
  sidebars vs. on-demand overlay panels). User chose **option 2, overlay
  panels** — the bigger, more ibis-Paint-faithful rework, not the safer
  default. Implemented:
  - **New `src/stores/uiStore.ts`:** ephemeral UI-chrome state only
    (`leftOverlay: 'brush' | null`, `rightOverlay: 'color' | 'layers' |
    null`), deliberately separate from `editorStore` (tool/brush *values*)
    and `appStore` (project/screen state) — this store holds no data that
    needs to survive a reload or affects the document.
  - **New `src/components/OverlayPanel.tsx`:** a solidly-opaque
    (`bg-shell-panel`, no glass/blur — matches the user's explicit "more
    solid than ibis Paint itself" direction) floating sheet, `position:
    absolute` inside the canvas row rather than docked in normal flex flow.
    This was the key structural decision: because it's absolutely
    positioned, opening/closing it **never changes the canvas host's own
    box size** — confirmed live (see below), which sidesteps the entire bug
    class Section 10.2 had to root-cause and fix for the old docked
    sidebars. No `forceResize()` wiring needed for overlay open/close at
    all, unlike the old `Drawer`-collapse case.
  - **`src/components/Toolbox.tsx` restructured into an always-visible
    vertical tool rail** (Brush/Eraser/Select/Blur/Smudge as one-tap icon
    buttons, `IconButton`-based, 44×44px) instead of living inside a
    collapsible "Tools" drawer — matches the user's own framing that
    switching tools is too frequent an action to hide behind a sheet tap,
    and doubles as a first pass at Section 14's touch-target sizing note
    (44px meets the ~44×44px guideline that section calls out) without
    waiting for that section specifically.
  - **`src/App.tsx` rewritten:** the old `w-64`/`w-80` docked `aside`
    columns (each wrapping two `Drawer`s) are replaced with two slim
    `w-16` rails. Left rail: `Toolbox` (tool switcher) + a "Brush Settings"
    toggle icon (opens `ToolPalette` as a left-anchored `OverlayPanel`).
    Right rail: an always-visible **current-color swatch button** (its own
    background *is* the live current color, doubling as the quick-glance
    status strip the section asked for) that opens `ColorPicker` as a
    right-anchored overlay, plus a "Layers" toggle icon that opens
    `LayerPanel` the same way. The unused `Drawer` function (no longer
    referenced anywhere) was deleted rather than left dead in the file.
    Overlays close automatically when Focus Mode is toggled on (an open
    sheet over a canvas-only view made no sense) via a one-line addition to
    the existing Focus Mode effect. The floating Focus-mode toggle button's
    position was retuned (`right-[280px]` → `right-24`) to clear the new,
    much-narrower right rail instead of the old 320px sidebar.
  - **Verified live**, not just by reading code: opened the dev server,
    navigated into a real project, and — after hitting and correctly
    diagnosing this environment's known frozen-transition/`document.hidden`
    quirk again (see this file's ground rules; resolved the same way as
    Session 7 by forcing `getAnimations()` to finish rather than trusting
    `getBoundingClientRect()` mid-transition) — confirmed via
    `documentEngineRef`: (1) the canvas host's `clientWidth`/`clientHeight`
    stayed **exactly** 800×763 with zero overlays open, with the Brush
    Settings overlay open, and with Brush Settings + Layers open
    *simultaneously* on opposite rails (no overlap: left panel ended at
    x=381, right panel started at x=575) — direct proof overlays truly
    don't affect canvas sizing, the core claim behind choosing this
    architecture; (2) each overlay's actual content rendered correctly
    (Brush Settings showed real slider/preset controls, Layers showed the
    real layer list with working "Add New Layer"/opacity/blend-mode
    content, not a blank shell); (3) toggling the same-side overlay
    (Color→Layers) correctly replaced rather than stacked, while
    opposite-side overlays coexist, matching the intended one-per-side
    model; (4) Focus Mode still works exactly as Session 7 last measured it
    (952×859 expanded, 800×763 restored) and now additionally auto-closes
    any open overlay; (5) zero console errors from the app itself
    throughout (one stale historical Vite HMR error for `LayerPanel.tsx`
    persisted in the console buffer from earlier in this dev-server's
    uptime — confirmed non-blocking: a hard navigate + fresh render showed
    real, correct `LayerPanel` content inside its overlay, and `tsc`/`npm
    test` were both clean, so this was leftover buffer noise, not a live
    defect).
  - `npx tsc --noEmit` clean, `npm test` 35/35 passing.
- **Section 12 (Brush Settings panel) — DONE.** User said to continue with
  the rest of the file after the Section 11 check-in and the 10.1 follow-up
  fix (see below), so this session kept going into Sections 12-14 rather
  than stopping.
  - **12.1 (visual redesign):** no separate work needed — `ToolPalette`
    already inherited the opaque, professional `OverlayPanel` treatment
    from Section 11. Left the tabbed Basic/Fade/Shape/Jitter/Type/Dynamic
    grouping the plan described from ibis Paint's own UI as future scope,
    exactly as the plan itself framed it ("once there are more parameters
    to organize") — the panel still fits comfortably as one scrollable
    list with the existing Advanced collapsible.
  - **12.2 (brush type must be a real algorithm, not a preset):** added one
    genuinely new `BrushStyle`, `'textured'` (`src/engine/brushTypes.ts`),
    picked from the plan's own candidate list as the most self-contained to
    start with. `src/engine/brushEngine.ts`'s `getStamp()` gained a
    dedicated branch: same soft radial-falloff base as `round`/`pen`, then
    a seeded-PRNG set of thin radial "bristle" strokes are cut out of it via
    `destination-out`, so the edge reads as grainy/irregular instead of a
    perfectly smooth gradient — a real per-pixel difference in the stamp
    itself, not a parameter tweak on the same renderer (the user's exact
    complaint about `round` vs `pen` being pixel-identical today). The seed
    is derived from the stamp's own size/hardness/color so a given brush
    always regenerates the same bristle pattern (no flicker across cache
    evictions). No dispatch changes needed in `makeDabPainter()` — it
    already falls through to the shared `paintDab`-based closure for any
    style that isn't `blur`/`smudge`, so `'textured'` is automatically
    routed through the real stroke pipeline (taper, Flow, Alpha Lock, all
    of it) for free. Added a new "Textured Bristle" entry to
    `BRUSH_PRESETS` (`src/stores/editorStore.ts`) so it's actually
    reachable from the UI.
  - **12.3 (brush previews):** new exported `renderBrushPreview()`
    (`src/engine/brushEngine.ts`) renders a small thumbnail along a fixed
    wavy path using the real `paintDab`/`getStamp` path (temporarily
    flipping the module's existing `immediateMode` flag so the dabs draw
    synchronously instead of batching into next frame) — so a preview can
    never be misleading about how the brush actually renders, per the
    plan's own "buildable approach" note. `ToolPalette.tsx`: each preset row
    in the dropdown now shows a static thumbnail of that preset's own fixed
    settings (`PresetThumbnail`, memoized per preset — presets never
    change, so no reason to regenerate); a second, always-visible strip at
    the top of the panel re-renders (debounced 60ms) from the *live*
    current settings as sliders change — the stretch goal the plan called
    out explicitly. Skipped for Blur/Smudge (content-dependent tools with
    no presets in this picker anyway, so there's nothing meaningful to
    preview against an empty canvas).
  - **Verified live**, not just by reading code: opened the dev server,
    confirmed all 5 preset thumbnails (including the new Textured Bristle)
    render as real PNG `data:` URLs in the dropdown, and the live top-strip
    preview canvas renders inside the Brush Settings overlay. Hit and
    correctly diagnosed a real testing-harness gotcha while verifying the
    textured stamp actually differs from round: driving `dc.brush` (the
    live app instance) through a full `down()`/`move()`/`flush()`/
    `recomposite()` stroke from a *freshly re-imported* `brushEngine.ts`
    module gave two different code realities at once — `dc.brush`'s
    methods close over the module instance that was live when `dc` was
    constructed, while a fresh `import()` in the same session can return a
    **different** module instance (this is the same disconnected-module
    problem the Alpha Log already flagged for zustand stores after
    mid-session edits — turns out it applies to plain ES modules with
    internal mutable state too, like `brushEngine.ts`'s module-level
    `immediateMode`/`drawQueue`). Toggling `setImmediateMode` on the fresh
    import silently did nothing to the *actual* queued draws sitting in the
    old module's queue, so nothing appeared until real `requestAnimationFrame`
    ticks were awaited instead of relying on the flag. Once that was
    understood, dropped to a lower-level, harness-proof check instead:
    called `paintDab()` directly (same function, no module-identity
    ambiguity since it was imported and used in the same call) for `round`
    vs `textured` at identical settings/position and diffed the two
    resulting stamps pixel-by-pixel — **3,963 of 78,400 bytes differed**,
    directly confirming the textured stamp is a real, substantially
    different rendering, not a no-op. `npx tsc --noEmit` clean, `npm test`
    35/35 passing.
- **Section 13 (Color Picker wheel) — DONE.** Followed the plan's own
  recommended order: tried `@uiw/react-color`'s `Wheel` first rather than
  defaulting to a custom build. `npm view` confirmed registry access, then
  installed `@uiw/react-color` (`package.json`) — pulls in
  `@uiw/react-color-wheel` as a dependency, imported directly
  (`import Wheel from "@uiw/react-color-wheel"`) rather than going through
  the umbrella package, keeping the added surface area minimal.
  `src/components/ColorPicker.tsx`: replaced the linear H/S sliders with
  the `Wheel` (168×168, bound to the existing `hsv` state, `onChange` reuses
  the existing `updateColorFromHsv` — no new color-math needed, the
  component's `ColorResult.hsv` matches this app's own `src/lib/color.ts`
  convention exactly, h:0-360 / s,v:0-100). Kept a plain Brightness/Value
  slider underneath (the `Wheel` component itself only encodes hue+
  saturation via 2D position — value needs a separate control in every
  real implementation of this pattern, not just this app's), and per the
  user's explicit instruction, kept the HEX input, eyedropper, swatches,
  and RGB sliders exactly as they were — only the redundant linear H/S
  sliders were removed. No new custom drag/geometry code was needed at all,
  confirming the plan's own risk assessment (Low-Moderate for the library
  path).
  - **Verified live**, not just by reading code: opened the dev server,
    confirmed the wheel renders in the Color Picker overlay at the correct
    size. Hit a real interaction-testing gotcha and diagnosed it from the
    library's own source rather than guessing: an initial synthetic
    `PointerEvent`-based click didn't move the color at all — read
    `@uiw/react-color-wheel`'s and its `@uiw/react-drag-event-interactive`
    dependency's actual source (`node_modules`) and found it listens for
    plain `onMouseDown`/`onTouchStart` React handlers, not Pointer Events at
    all. Switched to dispatching a real `MouseEvent('mousedown', {buttons:
    1, ...})` at a point offset from the wheel's center — the color
    genuinely changed (`#1a1a1a` → `#081a1a`), confirmed three independent
    ways: the always-visible rail swatch's background color, the overlay's
    own preview swatch, and the HEX input's live value all updated in sync.
    Also confirmed the eyedropper button and all 12 quick-pick swatches are
    still present and unchanged. `npx tsc --noEmit` clean, `npm test` 35/35
    passing.
- **Brush preview invisible on dark theme — found and fixed.** The live
  brush-preview strip (Section 12.3) and each preset's thumbnail (also
  12.3) both drew on a themed `bg-shell-bg` background — invisible
  whenever the drawn stroke color was also dark (the default brush color
  is near-black `#1a1a1a`), and the preset thumbnails specifically used a
  *light gray* stroke color (`#e8e8ef`) on that same themed background,
  which would have been just as invisible in light theme (light-on-light)
  as it was in dark theme (this session's actual report was dark-on-dark).
  Fixed both to use a fixed white background (`bg-white`, not a theme
  token) — brush strokes can be any color, so the preview needs a
  guaranteed-contrasting background regardless of the app's theme, the
  same reasoning a real canvas swatch would use. Preset thumbnails also
  switched from the light-gray stroke color to a fixed dark
  (`#1a1a1a`) stroke to match. Verified live: both the live preview strip
  and its container now compute `rgb(255, 255, 255)` background.
  `npx tsc --noEmit` clean.
- **Smudge: further investigation into "problems after a lot of smudging
  in one place" and "small ugly lines."** Tested several concrete
  hypotheses with live pixel measurement rather than guessing:
  - **Ruled out: Textured Bristle brush texture as the cause.** The
    screenshot's small starburst shapes are genuinely from that brush
    (matches its radiating-line stamp exactly), so tested smudging
    Textured-Bristle-painted content vs. plain-round-brush-painted content
    under identical smudge settings — both produced **statistically
    identical** roughness in the output (24 reversals each, same values).
    Brush texture is not the differentiator.
  - **Found and fixed a real, separate issue: the small "prevent local
    saturation" erase mask's own soft edge could interfere with itself
    across overlapping dabs.** Switched the erase step
    (`stampSmudgeDab()`) from a scaled-down copy of the dab's own soft
    (hardness-falloff) stamp to a hard-edged, uniformly-opaque disc drawn
    directly via `ctx.arc()` — a soft-edged shape repeated at every dab
    position (they overlap heavily) can interfere with its own previous
    application in a moiré-like way; a hard uniform disc can't. This is a
    real correctness improvement (the erase step's only job is "clear a
    small area," which a soft gradient was never the right tool for), but
    it did **not** measurably change the fine-grained roughness metric
    when re-tested (171 vs. 175 reversals, within noise) — kept anyway on
    principle, and because it did not make anything worse.
  - **Found the likely real cause of "ugly lines"/"problems after a lot of
    smudging": tight scrubbing/looping motion near a source edge.**
    Reproduced by simulating a realistic "blend this edge" scrub gesture
    (a tight circular motion straddling the boundary of a painted shape,
    repeated for many loops) — found genuine, visible dark streaks
    reappearing after the color had already faded toward white nearby
    (e.g. one scan: …12, 136, **250, 255, 65**, 224, 254… — a real dip back
    to near-black right after reaching near-white, not sub-pixel noise).
    **Tried raising `SMUDGE_PICKUP_RATE`** (0.05 → 0.12, roughly the
    geometric middle between the original 0.35 and this session's earlier
    0.05) on the theory that slower dilution was letting the carried patch
    stay dark for too long during scrubbing — measured **no improvement**
    (streak count went from 7 to 8, i.e. not better) while straight-line
    carry distance got measurably worse. **Reverted to 0.05** — it's the
    value verified to satisfy the user's own explicit white-into-black
    test, and the streaking during tight loops appears to be a separate,
    deeper issue than the pickup rate: a scrub loop that straddles a
    source edge re-samples that source fresh on every single revolution
    (`captureSmudgePatch` correctly reads only the frozen pre-stroke
    canvas, never the evolving smudge result), so tight repeated loops
    near an edge keep "refilling" with full-strength source content in a
    way a single carried-patch-with-decay model doesn't smoothly resolve —
    likely a genuine architectural limit of the current stamp-and-drag
    design, not a parameter to tune away. **Not fixed this session** —
    flagging honestly rather than guessing further, per this file's own
    established rule for this exact tool. If this keeps being disruptive
    in practice, the real fix is probably architectural (e.g. spatially-
    local decay instead of one global per-stroke carried patch), which is
    a bigger change than a follow-up tweak.
  - `npx tsc --noEmit` clean, `npm test` 35/35 passing throughout (only the
    erase-shape change persisted; the pickup-rate experiment was reverted).

- **LayerPanel rework, requested after Section 14 — user flagged being
  "skeptical" about layers; asked to narrow down what specifically via
  `AskUserQuestion` rather than guessing at a redesign, and the user
  picked "Visual design" + "Cramped controls."** Addressed both together
  rather than as separate passes, since they're the same root cause (the
  main row crammed 4 icon buttons + the layer name into ~280px):
  - **New `DocumentCanvas.getLayerThumbnail(id, size)`**
    (`src/engine/documentCanvas.ts`) — reads the layer's real runtime
    canvas directly (never a stale/cached copy) and returns a scaled data
    URL. `LayerPanel.tsx`'s new `LayerThumbnail` sub-component calls it in
    a `useEffect` keyed on layer id + a cheap `refreshKey` (layer count +
    `useHistoryStore`'s `past.length`, which changes on every committed
    stroke and on undo/redo) — regenerating a `toDataURL()` per layer on
    every render would be wasteful for a panel that re-renders for
    unrelated reasons (e.g. typing a rename), so it only recomputes when
    content actually might have changed. Each layer row now shows a real
    36×36 preview of its own pixels over a checkerboard (transparency
    reads correctly) instead of just a name — directly answers the
    "visual design" feedback with the single highest-leverage change for a
    layers panel specifically (matches Photoshop/Procreate/ibis Paint).
  - **Row decluttering ("cramped controls"):** Move Up/Move Down/Delete —
    3 of the 4 icon buttons that didn't fit — moved into the already-
    expandable Properties panel (same progressive-disclosure pattern this
    app already uses for Advanced brush settings and the rest of this very
    panel), now as labeled `Move Up`/`Move Down` buttons plus a `Delete`
    icon button in a row at the very top of Properties, above Opacity.
    The main row is now just: thumbnail, visibility toggle, name,
    Properties toggle — reordering and deleting are real but less
    frequent actions than selecting/toggling a layer, so hiding them one
    tap deeper is a reasonable trade, not a functionality cut.
  - **Verified live**, not just by reading code: painted real content
    directly onto a layer's canvas, opened the real Layers overlay, and
    confirmed the thumbnail rendered as an actual PNG `data:` URL matching
    the painted content (not a placeholder) — on both a freshly-added
    second layer too, confirming per-layer thumbnails are independent, not
    shared/stale. Confirmed the main row is down to exactly 3 buttons
    (Hide, name, Properties) via DOM inspection. Expanded Properties and
    confirmed Move Up/Move Down/Delete render with correct enabled/disabled
    state matching the layer's actual position (top layer: Move Up
    disabled, Move Down/Delete enabled) and that every other existing
    Properties control (Opacity, Blend Mode + description, Alpha Lock,
    Duplicate, Clip to Layer Below, Merge Up/Down) still renders unchanged.
    Zero console errors throughout. `npx tsc --noEmit` clean, `npm test`
    35/35 passing.

- **Section 14 (overall layout & professionalism pass) — DONE.**
  - **Consistent visual language:** nothing further needed — Sections
    11-13's new surfaces (`OverlayPanel`, the rails, the color wheel) all
    already reuse Session 9's `Button`/`IconButton`/design-token system
    rather than introducing a new one, exactly as this section asked.
  - **Touch-target audit — the concrete item, done for real:** measured
    (not guessed) the two spots this section named as most likely to be
    hard to hit on a tablet, live in the browser. `LayerPanel.tsx`'s
    visibility/Up/Down/Properties/Delete row: was ~26-28px per button
    (`IconButton`'s default `p-1.5`); bumped via explicit `className`
    overrides (`p-2`, and the visibility toggle to `w-9`) to a measured
    **33-36px**, with the whole row still fitting in 282px of the 320px
    overlay with no wrap or overflow (measured via `getBoundingClientRect`
    after opening the real Layers overlay). Didn't push all the way to the
    full ~44px guideline here — five buttons plus the layer name genuinely
    don't fit at 44px each in this row's available width, so this is a
    real, meaningful improvement (roughly +30% per side) rather than a
    complete fix; a full fix would need restructuring the row itself
    (e.g. moving some actions into the already-expandable Properties
    panel), left as a future call rather than done reflexively this
    session. `ColorPicker.tsx`'s swatch grid: was **27.5×27.5px** per
    swatch (measured), because 6 columns in this panel's width left too
    little room per cell — changed to a 4-column grid (one extra row for
    12 swatches), remeasured at **45.25×45.25px**, clearing the ~44px
    guideline outright, not just improved.
  - **Both input modes:** the two structural changes this session are
    inherently input-mode-relevant, not something bolted on after the
    fact — Section 11's overlay panels/rails were verified with real
    `MouseEvent`/click-based interaction throughout Sections 11-13, and
    the touch-target bump above directly targets the tablet/touch case.
    Did not have physical touch hardware to test against (this
    environment's browser tooling has no touch-input simulation beyond
    dispatching synthetic events, already used elsewhere this session);
    noting this as a real gap rather than claiming full touch verification
    that didn't happen.
  - `npx tsc --noEmit` clean, `npm test` 35/35 passing throughout. **This
    completes every section of this file's Session 7/8 backlog (10.1's
    "acts like a brush" sub-issue, 10.2, 11, 12, 13, 14)** — 10.1's
    red-tint sub-issue remains open pending a concrete repro from the user
    (see that section), and Section 6.3 (magic wand etc., an intentionally
    unscoped candidate menu) remains for a future pass if ever requested.
- **Follow-up on Section 10.1, same session:** after seeing Section 11 live,
  the user shared a fresh screenshot showing Smudge painting solid,
  brush-like opaque black instead of a fading drag. This turned out to be a
  real, distinct bug from the red-tint issue investigated earlier this
  session (which remains unreproduced) — root-caused and fixed via direct
  pixel measurement (dab-overlap alpha compositing was saturating to full
  opacity within a handful of overlapping dabs, regardless of Smudge
  Strength). See Section 10.1 below for the full root-cause writeup and
  live verification. `npx tsc --noEmit` clean, `npm test` 35/35 passing.
- **Second follow-up on Section 10.1, still same session:** after trying
  the fix above live, the user caught that it had over-corrected — Smudge
  no longer carried color any real distance at all (e.g. dragging white
  into a black shape didn't lighten it). Root-caused as two compounding
  causes (the first fix's erase step was too large-radius, and a
  pre-existing per-dab dilution rate was far too aggressive once that
  erase step stopped masking it) and fixed both, confirmed via the user's
  own suggested repro (white dragged into black). See Section 10.1 below.
  `npx tsc --noEmit` clean, `npm test` 35/35 passing.

**Session 7 (cont'd, 4) — 2026-07-19.** User reported two bugs with a
screenshot (smudge introducing a red tint with no source in the artwork,
shown as a large red blob under a black smudge trail) and a large follow-up
redesign request for Brush Settings/Color Picker/Layers/Tools, then asked
for all of it to be written into this file so the conversation could be
cleared — this session investigated both bugs (fixing one, confirming the
other by root cause) before writing the redesign request into new Sections
10-14 below, per the user's explicit priority order.

- **Bug 1.2 (canvas shrinks/animates when a sidebar panel collapses) — DONE,
  root-caused and fixed, not guessed.** Measured the actual live layout
  before/during/after collapsing the Brush Settings drawer: the canvas
  host's `clientHeight` dropped from 810px to 488px (a 322px shrink) and
  `clientWidth` shifted by ~15px (a scrollbar appearing/disappearing as
  sidebar content height changed). Walked the full ancestor chain from the
  canvas host up to the app root and found *every single ancestor* shrank
  together, including the outermost `<div className="h-full w-full ...">` —
  which ruled out a local flexbox-sizing bug in one component and pointed at
  something wrong with how the page's overall height chain resolves.
  Confirmed the actual browser viewport (`window.innerHeight`,
  `document.documentElement.clientHeight`, `visualViewport.height`) stayed
  perfectly constant throughout (910px), which ruled out a harness/viewport
  artifact and confirmed it was a genuine CSS bug. **Root cause:**
  `src/index.css` set `#root { height: 100% }` but never gave `html`/`body`
  an explicit height — and CSS percentage heights only resolve against the
  real viewport if *every* ancestor up the chain also has a non-`auto`
  height; otherwise they silently fall back to being sized by their own
  content. The app "looked" viewport-filling by coincidence (normal content
  was tall enough to reach the viewport size), but the instant any content
  got shorter — collapsing a Drawer, this session's new "Advanced" section,
  anything — the entire unanchored chain shrank to match, including the
  canvas frame several levels up, even though nothing about the canvas
  itself changed. This is a latent bug in the app's base layout (not
  something Session 7's earlier Collapsible work introduced), just one this
  session's new collapsible surfaces made far more likely to trigger.
  **Fix:** added `html, body { height: 100%; }` to `index.css`. **Verified
  live**, not just by reasoning: re-ran the exact same before/during/after
  measurement — canvas host `clientWidth`/`clientHeight` now stay
  *perfectly* constant (344×763px) through collapsing the Brush Settings
  drawer, the Layers drawer, and the new Advanced sub-section. Also
  confirmed Focus Mode's *intentional* canvas resize (sidebars/TopBar
  actually hiding) still works correctly and still restores exactly
  (344×763 → 952×859 → 344×763) — the fix only removed the *unintended*
  coupling, not real resize behavior. `npx tsc --noEmit` clean, `npm test`
  35/35 passing.
- **Bug 1.1 (smudge introduces color with no source, e.g. red near black) —
  investigated, NOT fixed, root cause not confirmed.** Attempted direct
  reproduction matching the user's screenshot's exact settings (size 60px,
  hardness 70%, opacity 100%, flow 100%) on a clean canvas: painted a solid
  black circle on white, ran a long smudge stroke straddling the edge for
  ~488 dabs (8 back-and-forth passes — a lot more than a normal short
  stroke), then scanned every pixel along the stroke for any R/G/B channel
  divergence (the circle+background are pure grayscale, so *any* channel
  imbalance would be the bug). **Found zero anomalies** — the stroke stayed
  perfectly grayscale throughout. Also swept the entire current canvas for
  stray non-grayscale pixel clusters in case this session's own extensive
  live-testing (Sections 7-9 painted many test patches directly via `ctx.
  fillRect` — red/blue/orange/purple/green — while verifying blur/smudge/
  clipping/lasso, explicitly never saved but never fully cleared either) was
  contaminating whatever artwork the user was testing on and being dragged
  in from just outside their screenshot's crop — found none on the current
  canvas, but this doesn't rule it out for whatever project the user was
  actually using, since it could be a different saved project. **Ranked,
  unconfirmed hypotheses for the next session to check, most to least
  likely, all grounded in the actual `stampSmudgeDab`/`captureSmudgePatch`
  code in `src/engine/brushEngine.ts`:**
  1. **Stale/undefined RGB under transparent alpha, revealed by resampling.**
     `captureSmudgePatch()`'s non-`replace` branch (added *this session*,
     replacing the old full-`clearRect`-then-`drawImage` approach) uses
     `destination-out` at `SMUDGE_PICKUP_RATE` alpha to partially erase the
     carried patch, then `source-over`s a fresh sample on top. Browsers
     aren't required to zero a pixel's color channels when its alpha drops
     via `destination-out` — if any stale color survives under alpha≈0,
     `stampSmudgeDab()`'s `drawImage(carriedPatch, ...)` call (which scales
     the *fixed-size* carried patch to fit the *current dab's* mask
     dimensions — these differ whenever `effSize` varies with
     pressure/velocity/taper, which barely happened in my constant-speed
     synthetic test but would constantly happen with real, variable-velocity
     pointer input) uses the browser's default bilinear image smoothing,
     which would blend that stale hidden color into visible, partially-
     transparent edge pixels. This is the strongest lead specifically
     *because* it's new to this session's rewrite (the old full-replace
     approach cleanly zeroed everything every time) and specifically
     depends on real pressure/velocity variation my synthetic test didn't
     exercise much of.
  2. **Premultiplied-alpha rounding drift** from many repeated low-alpha
     canvas composite operations. Checked empirically in the 488-dab test
     described above and found no evidence — deprioritized, but not fully
     ruled out for even longer real strokes (a real tablet stroke over many
     seconds could be several times longer than this test).
  3. Some interaction specific to real `PointerEvent` timing/smoothing
     (`HighPerformanceBrushStroke`'s stabilization/prediction math in
     `move()`) that a direct `down()`/`move()`/`flush()` call sequence with
     synthetic constant-velocity samples wouldn't reproduce.
  **Recommended next steps, in order:** (a) try to reproduce on a verified-
  fresh, newly-created canvas with *real* pointer-driven strokes (not
  synthetic) at varying speed/pressure, since hypothesis 1 specifically
  depends on that; (b) if reproduced, dump `carriedPatch`'s raw pixel data
  via `getImageData` mid-stroke and check for non-zero RGB at alpha=0
  pixels — this would directly confirm/refute hypothesis 1; (c) if
  confirmed, the fix is likely to explicitly zero color channels after the
  `destination-out` step (not achievable via a pure canvas 2D compositing
  call — would need a `getImageData`/`putImageData` pass, or switching the
  persistence mechanism away from blending the patch's own alpha entirely,
  e.g. tracking a separate opacity multiplier per dab instead of degrading
  the patch's actual pixels). **Do not guess-fix this one** — the user was
  explicit about wanting root cause first, and this session's attempt to
  reproduce came up empty, so a blind fix risks papering over the real
  mechanism.
- Sections 10-14 below capture the user's full redesign request (panel
  layout, Brush Settings, Color Picker, overall professionalism pass),
  written from a fresh, faithful transcription of their ask, grounded in the
  actual current architecture wherever this session already had deep
  context (brush styles, the `makeDabPainter` dispatch mechanism, the new
  `Button`/`Collapsible` components from Section 9), plus a little targeted
  research on ibis Paint's actual brush-settings tab structure and color
  wheel, and on available React color-wheel packages, so the next session
  isn't starting from zero. **Nothing in Sections 10.1 (10.2 is done), 11,
  12, 13, 14 has been implemented.**

**Session 7 (cont'd) — 2026-07-19.** User feedback after the Section 7/9.1
work above: (1) Blur and Smudge shouldn't be brush presets — they should be
their own tools, like Brush/Eraser/Select; (2) Blur's actual output was
wrong — it read as "coloring with the nearest color," not blurring. Fixed
both:

- **Blur algorithm root-cause fix** (`src/engine/brushEngine.ts`): the
  original implementation (this session, above) sampled one alpha-weighted
  *average* color per dab (`sampleAreaColor`, the Color Mix helper) and
  flat-filled a soft gradient stamp with it via `paintDab`. That's
  structurally "paint with the average color found here," not blurring — a
  real blur has to vary *per pixel* (soften edges, not replace a whole
  neighborhood with one flat tone), which a single sampled value can never
  produce, however small the dab. Root-caused correctly on the first look
  this time (no dead ends) because the user's description — "colors with
  the closest color... should blur what's already drawn, not add to it" —
  pointed straight at the flat-fill mechanism. Replaced with
  `stampBlurDab()`, modeled structurally on Smudge's patch-stamp mechanism
  (same round-stamp masking via `destination-in`) but self-referential
  instead of drag-carrying: captures the patch already at the dab's own
  position from `preStroke` (same feedback-avoidance rule as Smudge — never
  reads `wetBuffer`), draws it through Canvas 2D's native `filter:
  blur(Npx)` (a real per-pixel box/gaussian blur, not a manual convolution —
  supported in both Tauri's WebView2 and WKWebView backends), masks to the
  stamp shape, then composites onto `wetBuffer` at `intensity * taper`
  alpha — so it still flows through the existing Flow/Opacity/Alpha-Lock
  pipeline like every other style, unchanged. `makeDabPainter()`'s blur
  branch now just calls this instead of the old sample+paintDab pair;
  `sampleAreaColor` itself is untouched and still used by Color Mix.
  **Verified live** with a fine 10px red/yellow striped pattern (the
  strongest possible test — a flat-fill bug is invisible on a flat color,
  but immediately obvious on periodic detail): one blur pass showed the
  green channel oscillating smoothly through the original stripe period
  (9 → 159 → 96 → 159 → 96...) — a real softened wave tracking the source
  pattern, not a flat constant. Three more passes over the same area
  collapsed the interior to a near-uniform ~127-130 while the stroke's
  edges (less fully covered) retained more gradient — exactly the
  "progressively homogenize with repeated strokes" behavior the original
  plan called for, now actually delivered.
- **Blur/Smudge moved to standalone tools** (not brush presets):
  `src/engine/brushTypes.ts`'s `EditorTool` gained `"blur" | "smudge"`.
  `src/stores/editorStore.ts` — removed the `"blur-tool"`/`"smudge-tool"`
  entries from `BRUSH_PRESETS` (presets are Brush-only again, exactly the 4
  original ones), added `defaultBlur`/`defaultSmudge` + `blurMemory`/
  `smudgeMemory` state slots, and generalized `setTool`'s save/restore logic
  from a brush/eraser-only if-chain to a small `PAINT_TOOL_MEMORY_KEY` map
  covering all four paint-capable tools (Select still excluded — it doesn't
  paint, doesn't need memory). `src/components/Toolbox.tsx` — added Blur
  (`Droplet` icon) and Smudge (`Fingerprint` icon) to the main tool grid
  alongside Brush/Eraser/Select (3-column grid now wraps 5 items into two
  rows, confirmed via computed `getBoundingClientRect()` — clean, no
  overlap). `src/components/ToolPalette.tsx` — the preset dropdown already
  only rendered for `tool === "brush"`, so it now correctly excludes
  Blur/Smudge automatically (verified live: the dropdown's actual options
  are exactly the 4 real presets, no leftover Blur/Smudge entries); the
  Color-Mix-vs-Smudge-Strength slider swap now also hides both for the Blur
  tool (irrelevant to it) rather than showing Color Mix by default.
  `src/engine/documentCanvas.ts`'s `getBrushSettings()` — the old
  `select`-only `safeTool` guard (`tool === "select" ? "brush" : tool`)
  would have mistyped Blur/Smudge as valid `BrushSettings.isEraser` inputs
  incorrectly; simplified to "only `eraser` erases, everything else (brush/
  blur/smudge; select never reaches this code) behaves like brush" — more
  correct *and* shorter. No changes needed in `documentCanvas.ts`'s pointer
  handlers themselves — the only tool-specific branch there is the
  `tool === "select"` early-return, so Blur/Smudge already fell through to
  the normal paint path once `getBrushSettings()` returned the right
  `brushStyle`.
- `npx tsc --noEmit` clean, `npm test` 35/35 passing throughout.

**Session 7 (cont'd, 3) — 2026-07-19.** Finished the rest of Section 9 (UI
professional pass) as promised at the end of the previous entry: 9.2 (design
tokens / shared Button component), 9.3 (typography), 9.4 (depth/motion).

- **9.3 Typography:** added `@fontsource/inter` (self-hosted, matches the
  app's offline-friendly Tauri nature — no external font request), importing
  the 4 weights the app actually uses (400/500/600/700, confirmed via grep
  for every `font-*` utility in `src/`, not guessed). Registered it as
  Tailwind's `fontFamily.sans` default in `tailwind.config.js` and applied
  `font-sans` + a slightly tightened `-0.011em` letter-spacing on `body` in
  `index.css` (matches how Figma/Linear set Inter at UI sizes — the plan's
  own note that the "Inter is AI-slop" critique is about marketing pages,
  not dense tool UIs, holds up). Verified live via `document.fonts` (all 4
  weights registered, `700` confirmed actually loaded) and computed
  `font-family`/`letter-spacing` on `document.body`.
- **9.2 Design tokens / shared Button component:** new
  `src/components/Button.tsx` exporting `Button` (variants: `primary`/
  `secondary`/`ghost`/`danger`/`warning`, a `pressed` prop that forces the
  accent-filled "selected" look regardless of variant — replacing the
  inconsistent per-toggle hand-rolled active states the audit found, some of
  which had `shadow-inner` and some didn't — and an `elevated` prop for the
  two genuinely-floating buttons) and `IconButton` (compact ghost variant
  with a `danger` tint option, replacing `LayerPanel`'s local `IconBtn`).
  Deliberately keeps color/border/radius/transition inside the component and
  leaves padding/width/text-size to each call site's `className`, so there's
  no Tailwind cascade-order fight between the two (verified this really is
  a risk, not theoretical, before committing to the split — Tailwind's
  utility precedence is stylesheet-order, not class-string order, so two
  classes setting the *same* property from different sources is genuinely
  unsafe; component vs. caller never target the same property here, so
  plain string concatenation is fine). Ran a dedicated cataloging pass
  (via a research subagent, to keep this session's own context small) over
  every `<button>` in `App.tsx`, `TopBar.tsx`, `LayerPanel.tsx`,
  `ToolPalette.tsx`, `ExportModal.tsx`, `NewCanvasModal.tsx`, `Toolbox.tsx`,
  `ColorPicker.tsx` — 40+ buttons cataloged with their current classes and
  look — then migrated essentially all of them (deliberately left as plain
  `<button>`: the `Drawer` header toggle and `CanvasStage`'s pill-shaped
  "Done" FAB, both because they need a *different* border-radius than
  Button's fixed `rounded-lg` and forcing an override would hit the same
  cascade-order risk; color swatches, preset/context-menu list items, and
  the Gallery card patterns, all of which are chips/menu-items/cards, not
  buttons in the variant-recipe sense). **Concrete bugs fixed along the
  way, not just cosmetic recomposition:** (1) `ToolPalette.tsx`'s size
  slider used `accent-blue-500` — a literal hardcoded color, the exact same
  bug class Session 3 believed it had fully swept for buttons, just missed
  on this one range input; every other slider in the app already used
  `accent-shell-accent`. (2) `NewCanvasModal.tsx`'s "Create" button used
  bare `rounded` while every sibling button in the same file used
  `rounded-lg` — normalized. (3) Modal-dialog corner radius was split
  between `rounded-xl` (`Gallery.tsx`'s rename modal, `NewCanvasModal.tsx`)
  and `rounded-2xl` (`App.tsx`'s Settings modal, `ExportModal.tsx`) for the
  *same kind of element* — standardized every true modal dialog on
  `rounded-2xl`, leaving `rounded-xl` for in-flow panels/cards (Drawer,
  canvas frame, Gallery project cards) as the plan's radius rule asks.
  Verified via `npx tsc --noEmit` (clean) and a live grep sweep confirming
  only the intentional plain-`<button>` exceptions remain, plus spot-checked
  computed `border-radius`/`background-color`/`font-family` on rendered
  buttons in both the Gallery and Editor screens to confirm the tokens
  actually apply (not just that the classes are present in source).
- **9.4 Depth/motion/canvas-first chrome:** (1) softened internal-only
  dividers (the `Drawer` header/content seam, a layer's Properties-panel
  seam, the Gallery project-card image/title seam, the Gallery context
  menu's Rename/Delete seam, the custom-theme color-input seam) from full
  `border-shell-border` to a `color-mix(in srgb, var(--shell-border),
  transparent 55%)` arbitrary-value class — confirmed Tailwind's normal
  `/50`-style opacity modifier syntax does *not* work on these
  custom-property-backed color tokens (tested empirically: it silently fell
  back to Tailwind's preflight default gray, not an error, which would have
  been easy to miss) and that `color-mix()` does, before rolling it out to
  all five spots; left genuinely-structural boundaries (`TopBar`'s bottom
  edge, `Gallery`'s page header) at full strength, since those separate
  major layout regions, not sections within one panel. (2) Progressive
  disclosure in `ToolPalette.tsx`: Start Taper/End Taper/Color Mix
  (Smudge Strength when relevant) now live behind a collapsed-by-default
  "Advanced" toggle, leaving Size/Hardness/Opacity/Flow as the always-visible
  defaults — kept Hardness visible despite the plan's summary line naming
  only "Size/Opacity/Flow," since its own more specific bullet only proposed
  moving Taper/Color-Mix and Hardness is too fundamental a brush property to
  bury (Procreate/Photoshop never hide it). (3) New
  `src/components/Collapsible.tsx` — the `grid-template-rows: 0fr → 1fr`
  auto-height animation trick the plan called for (plain `transition-all`
  can't animate to/from `height: auto`, and JS height-measurement would add
  layout thrashing) — applied to `Drawer` (App.tsx), the layer Properties
  panel (`LayerPanel.tsx`), and the new Advanced section
  (`ToolPalette.tsx`), replacing three separate `{condition && <div>}`
  instant-snap instances with one shared 200ms-eased component.
  **Verification note, itself a useful finding:** computed-style checks on
  freshly-toggled elements initially looked broken (colors/heights stuck at
  their pre-transition starting values) — root-caused to the Browser pane's
  tab reporting `document.hidden === true` for extended stretches in this
  environment, which freezes the CSS transition/Web Animations timeline
  (confirmed via `el.getAnimations()`: `playState: "running"` but
  `localTime` permanently stuck at `0`). Verified the *actual* implementation
  was correct three ways that don't depend on the frozen timeline: (a) the
  element's className/grid-template-rows target value was confirmed correct
  even while stuck, proving the React/Tailwind logic fired correctly; (b) an
  identical class string on a freshly-created element (never animated, no
  transition needed) computed correctly immediately; (c) calling
  `anims.forEach(a => a.finish())` to force the stuck animation to its end
  state directly (bypassing the frozen automatic timeline) produced the
  correct final layout (e.g. a Properties panel growing from `0` to its true
  `395.75px` content height). Documented this whole diagnostic path in this
  file's ground rules above so a future session doesn't have to
  re-discover it from scratch.
- `npx tsc --noEmit` clean, `npm test` 35/35 passing throughout. **This
  completes every section of Session 6's backlog (6.1, 6.2, 7, 8, 9.1-9.4)**
  — 6.3 (magic wand etc.) remains the intentionally-unscoped candidate menu
  for a future pass, not part of this backlog.

**Session 7 — 2026-07-19.** Started work on the Section 6-9 backlog planned in
Session 6, in the suggested order. Implemented Section 6.2 (shift-key 1:1
aspect-ratio-locked resize):

- **File:** `src/engine/SelectionManager.ts` — `updateSelection()` now takes a
  `shiftKey` parameter (default `false`, so all other call sites compile
  unchanged). `src/engine/documentCanvas.ts`'s `onPointerMove` now passes
  `e.shiftKey` through at its one call site.
- **Math:** when shift is held during a corner-resize drag, after computing
  the raw `nw`/`nh` from the drag delta (existing local-space logic
  unchanged), a new block computes `scale = max(|nw|/|w0|, |nh|/|h0|)` (the
  more dominant of the two deltas drives the result, matching the todo's
  "whichever changed less gets rescaled to match" — same effect, framed as a
  uniform scale factor instead), rescales both `nw`/`nh` by that scale
  preserving their sign, then recomputes `nx`/`ny` from the corner opposite
  the one being dragged (fixed at its Session-3 `initialRectPos` position) so
  that corner stays anchored — one `if/else if` per handle (`tl`/`tr`/`bl`/
  `br`), mirroring the existing per-handle branch just above it.
- **Verified live**, not just by reading code: opened the dev server, used
  `import('/src/engine/documentEngineRef.ts')` from the browser console to
  grab the live `DocumentCanvas` instance (module singleton, not on
  `window` by default — this trick is worth remembering for future sessions,
  cheaper than screenshots for this WebGL canvas), dispatched real
  `PointerEvent`s at the canvas element to cut a non-square marquee (289×356
  world px, ratio 0.81180), then dragged the `br` handle with
  `shiftKey: true` toward a deliberately non-matching delta — resulting rect
  was 600.11×739.24, ratio 0.81180 (exact match to 13 significant figures)
  with the anchor corner (`x:44,y:113`, the initial top-left) unchanged.
  Immediately after, dragged the `tl` handle **without** shift and confirmed
  the ratio changed freely (0.812 → 0.702) — confirming the shift path is
  correctly gated and the no-shift path has zero regression.
- `npx tsc --noEmit` clean, `npm test` 35/35 passing.

Also implemented Section 8 (clipping layers / clipping masks) — Pixi-native
sprite masking as the todo specified, not canvas-2D clipping:

- **File:** `src/stores/layerStore.ts` — added `clippedToLayerBelow?: boolean`
  to `LayerMeta` (optional, defaults falsy for old saves — same pattern as
  `alphaLocked`/`opacity`/`blendMode`) and a `toggleClipping(id)` action.
- **File:** `src/engine/documentCanvas.ts` — `syncLayers()` now does a second
  pass while building `layerRoot`'s children (bottom-of-stack to top, which is
  `metas`' actual order — confirmed by reading `addLayer`/`moveLayer` in
  `layerStore.ts`, new layers push to the end/top): tracks a `baseSprite`
  variable, updated to the current sprite whenever a non-clipped layer is
  seen, and assigns `rt.sprite.mask = baseSprite` for clipped layers (`null`
  if no base has been seen yet — the bottom-of-stack-with-nothing-below case).
  A run of consecutive clipped layers all mask to the *same* base, not a
  chain, matching the todo's spec exactly.
- **File:** `src/components/CanvasStage.tsx` — important addition beyond the
  original plan sketch: `syncLayers()` is only re-run when a memoized
  `layerSignature` string changes (an existing optimization so renaming/
  selecting a layer doesn't rebuild the whole Pixi display list). That
  signature only hashed `id + visible` — so toggling `clippedToLayerBelow`
  alone would never have triggered a resync and the mask would never appear
  until some unrelated layer-list change happened to fire one. Added the clip
  bit to the signature (opacity/blendMode/alphaLocked deliberately excluded —
  they're self-contained and already have their own instant live-update
  methods that don't need a full rebuild; clipping isn't self-contained since
  it depends on neighboring layers, so a full `syncLayers()` pass is the
  correct mechanism here, not a special case to avoid).
- **File:** `src/components/LayerPanel.tsx` — added a "↳ Clip to Layer Below"
  toggle in the Properties panel (disabled when the layer is already at the
  bottom of the stack — nothing to clip to), plus a small "↳" glyph + indent
  on the main row for clipped layers so the parent/clipped relationship reads
  at a glance in the collapsed list too, per the todo's Procreate-parity note.
- **Verified live**, not just by reading code: reused the
  `documentEngineRef` dynamic-import trick from the 6.2 verification above
  (worth noting: this only works reliably for modules *not* edited during the
  current session — `layerStore.ts` had been edited, and a fresh
  `import('/src/stores/layerStore.ts')` after that returned an entirely
  separate, disconnected zustand instance rather than the app's real one,
  causing confusing "layer not found" errors until this was recognized;
  worked around it by driving all layer-list mutations through real UI button
  clicks instead, only using `documentEngineRef` — unedited this session — for
  low-level pixel inspection). Drew a red 500×500 square directly onto a base
  layer's canvas and a larger blue 900×900 square onto a second layer on top
  (both via direct `ctx.fillRect` + `sprite.texture.source.update()`, bypassing
  the brush engine for a deterministic test), then used
  `renderer.extract.pixels()` to read the actual GPU-composited output.
  Unclipped: blue fully covered its whole box, including well outside the red
  square. Clicked the real "↳ Clip to Layer Below" button in the UI: the exact
  same extraction now showed transparent pixels everywhere blue extended past
  red's bounds, and solid blue only where the two overlapped — the mask is
  keying off the base layer's actual alpha, not a static copy. Then tested the
  two edge cases the todo explicitly calls for: (1) moved the clipped layer to
  the bottom of the stack via the real "Down" button — no console errors, and
  a re-extraction confirmed it rendered fully unclipped again (silent
  deactivation, matching Procreate); (2) moved it back on top of the base and
  deleted the base layer via the real "Delete" button — again no console
  errors, layer count dropped to 1, and the remaining (still
  `clippedToLayerBelow: true`) layer rendered normally. Did not save this test
  session's destructive edits back to the persisted "Artwork 6487" project —
  no autosave exists in `appStore.ts` (confirmed by grep), and Save was never
  clicked, so navigating back to the gallery left the stored project
  untouched.
- `npx tsc --noEmit` clean, `npm test` 35/35 passing.

Also implemented Section 6.1 (freehand lasso select), reusing the rectangle
tool's move/resize/rotate/commit machinery exactly as the plan called for —
only the extraction step needed new code:

- **File:** `src/stores/editorStore.ts` — added `selectMode: 'rect' | 'lasso'`
  (default `'rect'`) and `setSelectMode()`. Deliberately a separate field from
  `tool` — it's a sub-mode of the Select tool, not a new tool.
- **File:** `src/engine/SelectionManager.ts` — added `mode` (synced by the
  caller before each `startSelection()`, since editing an already-cut
  selection is shape-agnostic — see its doc comment) and `lassoPoints:
  {x,y}[]`. `startSelection()`'s "begin new selection" branch seeds
  `lassoPoints` when in lasso mode; `updateSelection()` gained a lasso branch
  that appends points (skipping near-duplicates under `1/zoom` world units,
  so a stationary pointer still firing move events doesn't spam degenerate
  segments) instead of recomputing an axis-aligned rect; `draw()` renders the
  raw traced polyline during an in-progress lasso drag instead of the rect
  outline (no handles yet — those only apply post-cut). New
  `extractLassoPixels()`: computes the integer-rounded bbox of `lassoPoints`
  (same rounding discipline as the rect path, for the same subpixel-blur
  reason), builds two `Path2D`s from the same points — one in bbox-local
  space, one in the layer's absolute space — copies the bbox region into
  `tempCanvas` same as the rect path, then punches it down to the lasso's
  actual outline via `destination-in` + the local path, and clears the source
  layer via `ctx.clip(absPath)` + `clearRect` (so only the lasso'd pixels are
  removed, not the whole bbox, exactly per the plan). Both extraction methods
  now share a new `installFloatingTexture()` tail (texture swap + rotation
  reset + `updateFloatingTransform()` + `hasSelection = true`) that used to be
  duplicated inline in `extractPixels()` alone.
- **File:** `src/engine/documentCanvas.ts` — one line in `onPointerDown`'s
  select-tool branch syncs `this.selection.mode` from the store immediately
  before calling `startSelection()`.
- **File:** `src/components/Toolbox.tsx` — added a Rectangle/Lasso two-button
  switch, shown only while the Select tool is active (mirrors Photoshop's
  marquee-shape options-bar pattern per the plan).
- **Verified live**, not just by reading code: filled a 900×900 region on a
  layer, switched to Lasso mode via the real UI button (confirmed via the
  button's active-state class, not a store read — `editorStore.ts` was edited
  this session, and re-hit the same disconnected-dynamic-import-module
  problem noted in the Section 8 entry above; DOM inspection sidesteps it
  cleanly), then dispatched a real pointer-drag tracing an L-shaped hexagon
  (deliberately non-convex, so its bounding box includes a "notch" the shape
  itself excludes — the strongest possible proof extraction isn't secretly
  just a rect). After the cut: the bbox was exactly the L's 800×800 bounding
  box as expected, but pixel-sampling `tempCanvas` showed the notch
  fully transparent (0,0,0,0) while both legs of the L were still opaque
  (0,128,0,255) — and sampling the source layer showed the exact inverse
  (notch still green/untouched, the L's interior cleared) — confirming both
  the extraction clip and the source-layer clip independently followed the
  actual traced polygon, not the bbox. Then dragged the `br` resize handle
  (800×800 → 888.9×888.9, anchored correctly) and committed by clicking
  outside, with zero console errors throughout — confirming the "no changes
  needed" claim about the existing rect-based move/resize/rotate/commit code
  actually held in practice, not just in theory. Did not save the test
  session's edits back to the persisted project (same reasoning as the
  Section 8 entry above).
- `npx tsc --noEmit` clean, `npm test` 35/35 passing.

Also implemented Section 7 (Blur and Smudge brushes) — the most reuse-heavy
item in the whole plan for Blur, and the one place this session where the
plan's literal wording needed a deliberate correction to actually work, for
Smudge:

- **Files:** `src/engine/brushTypes.ts` (`BrushStyle` gained `'blur' |
  'smudge'`; `BrushSettings` gained `smudgeStrength: number`),
  `src/stores/editorStore.ts` (`smudgeStrength` threaded through
  `ToolSettings`/defaults/`setTool`'s memory-swap/`loadPreset`, plus two new
  `BRUSH_PRESETS` entries — "Blur" and "Smudge" — since brush style in this
  app is chosen entirely via presets, there's no free-standing style picker),
  `src/engine/documentCanvas.ts` (`getBrushSettings()` reads
  `smudgeStrength` from the store), `src/components/ToolPalette.tsx` (a
  "Smudge Strength" slider swaps in for "Color Mix" specifically when
  `brushStyle === 'smudge'` — the two settings are mutually irrelevant to
  each other's style, no reason to show both).
- **Core refactor enabling both** (`src/engine/brushEngine.ts`):
  `stampAlongSegment`/`stampAlongQuadratic` used to hardcode a call to
  `paintDab(ctx, x, y, settings, sizeMul*taper, 1, wetColor)` at each
  computed dab position — replaced with a `DabPainter` callback parameter
  so the exact same spacing/taper/curve-following math (unchanged) can drive
  three different per-dab behaviors. `HighPerformanceBrushStroke` gained
  `makeDabPainter(settings)`, returning: the original paintDab-with-wetColor
  closure for every existing style; a Blur closure for `'blur'`; a
  Smudge closure for `'smudge'`. Built once per `move()`/`flush()` call and
  passed through — `flush()`'s three previously-direct `paintDab`/
  `stampAlongSegment` call sites were also switched to go through the same
  `drawDab`, so blur/smudge get taper and short-tap handling for free too,
  not just the main stroke body.
- **7.1 Blur** — the closure re-samples `sampleAreaColor()` (Session 4's
  existing color-mix helper, reading from the pre-stroke snapshot so a
  stroke can't sample its own already-blurred pixels) at *every* dab
  position instead of once per `move()` call, and paints that as the dab's
  color via the existing `paintDab`. That's the entire diff — no new
  drawing primitive needed, exactly as scoped. Verified with direct
  `brush.down()`/`move()`/`flush()` calls (see verification note below) over
  a hard red/blue boundary: the boundary pixel blended to `[155, 0, 101]`
  (a real average, not either pure color) after a few back-and-forth passes,
  while pixels several brush-radii away from the stroke path stayed
  untouched — confirms the effect is a genuine local blend, not a global
  color shift or a no-op.
- **7.2 Smudge** — added `carriedPatch`/`carriedCtx` (the dragged content)
  and `smudgeScratch`/`smudgeScratchCtx` (a reusable canvas for masking the
  patch to a soft round falloff before stamping, via `destination-in` with
  the same cached hardness-gradient stamp every other style uses).
  `down()` seeds the patch under the pointer at stroke start.
  `stampSmudgeDab()` paints the *currently* carried patch, then re-captures
  at the new position for the next dab — deliberately synchronous, not
  routed through `enqueueDraw`'s RAF batching like `paintDab`, because
  capture and paint both mutate/read the same pooled canvas in a specific
  order; deferring either step would let a later dab's capture race an
  earlier dab's still-pending paint. The carried patch is captured at one
  *fixed* size for the whole stroke (set once in `down()`) rather than
  resized to match each dab's own taper/pressure-scaled size — painting
  always scales the fixed patch to fit the current dab's mask via
  `drawImage`'s source/dest rects. **Found via live testing, not
  anticipated from the plan:** an early version matched the todo's literal
  algorithm description ("stamp the carried patch, then recapture a fresh
  one") by having each recapture *fully replace* the patch — this made the
  drag vanish within about one dab of leaving the source pixels, since a
  full replace at a position with nothing under it just makes the carried
  patch blank, with zero memory of what it held a moment before. Fixed by
  blending only `SMUDGE_PICKUP_RATE` (0.35) of each recapture in — via
  `destination-out` at that alpha to make room, then a matching-alpha
  `source-over` draw of the fresh sample, a manual per-pixel lerp since
  canvas 2D has no native blend-toward-transparent operation — so paint now
  persists and fades gradually over several dabs as it's dragged away from
  its source, instead of disappearing instantly. This is standard practice
  in real smudge-tool implementations; the plan's wording just undersold how
  literally to take "recapture a fresh patch."
- **Verification method note:** real `PointerEvent` dispatch through the
  full `DocumentCanvas` pointer pipeline proved unreliable for this specific
  test in this environment — rapid zero-delay synthetic dispatch produces
  near-zero timestamp deltas (`pointerSample()` stamps `t: performance.now()`
  per event), which spikes the engine's velocity estimate and, through the
  existing (pre-Session-7) prediction/thinning math, throws dab positions
  and sizes off; adding realistic per-event delays via `setTimeout` to
  compensate then hit this environment's background-tab timer throttling
  and left one test stroke stuck mid-drag (`dc.drawing` stayed `true` until
  manually finished with a synthetic `pointerup` — cleaned up correctly,
  confirmed via `dc.drawing === false` after). Switched to calling
  `dc.brush.down()`/`move()`/`flush()` directly with realistic, explicit
  16ms-spaced timestamps instead — these are the exact same methods
  `DocumentCanvas`'s pointer handlers call, so this exercises the real
  production code, just without the unreliable synthetic-event layer on
  top. All the pixel-level results above (and Smudge's bug-and-fix) came
  from that route. No console errors at any point, including after the
  stuck-stroke cleanup.
- `npx tsc --noEmit` clean, `npm test` 35/35 passing (updated
  `brushEngine.test.ts`'s `BrushSettings` fixture for the new
  `smudgeStrength` field, same pattern as Session 4's `alphaLocked`).
Also implemented Section 9.1 (replace emoji-as-icons with `lucide-react`) —
exactly as the plan scoped it: highest-value, lowest-risk, do first:

- **File:** `package.json` — added `lucide-react` (confirmed every icon name
  used below actually exists in the installed package via a quick Node
  `require` check before touching any component, rather than assuming).
- **Files touched:** `App.tsx`, `TopBar.tsx`, `Toolbox.tsx`,
  `ToolPalette.tsx`, `CanvasStage.tsx`, `LayerPanel.tsx`, `Gallery.tsx` — a
  full sweep, not just the files the plan's own grep happened to sample.
  Ran a fresh grep myself first (via a research subagent, to keep this
  session's own context small) covering every `.tsx` under `src/`, which
  caught two the plan's illustrative list didn't name: the drawer
  expand/collapse chevrons (▼/▶) in `App.tsx`'s `Drawer` component, and the
  plain `+` text glyph on Gallery's "New Canvas" tile — not technically an
  emoji, but the same "raw glyph standing in for an icon" pattern, swapped
  to `Plus` for consistency with the new `Plus` used on "Add New Layer".
  Left two things alone on purpose: the `✅` inside transient toast-notification
  strings in `ExportModal.tsx` (that's message copy, not persistent UI
  chrome — the plan's own exception for "genuinely decorative/expressive"
  content) and the `°`/`×` typographic symbols in `ColorPicker.tsx`/`App.tsx`
  (degree sign on a hue value, multiplication sign in "2048×2048px" — units,
  not icons).
- **Pattern used throughout:** icon components sized 13–24px depending on
  context (small inline glyphs like the clip-indicator vs. large 22px tool
  buttons), `strokeWidth` 1.75–2.5 (heavier on tiny/high-signal icons like
  Delete's trash can and the rotate/commit checkmark so they don't
  disappear at small size), always paired with the existing text label
  (icon + word, not icon-only) except where a title-only icon button already
  existed before this pass (delete/up/down in `LayerPanel`'s `IconBtn`) —
  didn't change that established pattern. `Drawer` and `ThemeBtn` in
  `App.tsx` gained an `icon: ComponentType<...>` prop (previously just took
  a `title`/`label` string with the emoji baked in) so every call site now
  passes a real icon component alongside plain text.
- Some icon choices worth noting since they're not 1:1 obvious from the
  old emoji: Select tool → `MousePointer2` (was ⬚, a generic "empty rect"
  glyph) with the Rectangle/Lasso sub-mode buttons using `Square`/`Lasso`
  instead so the marquee-shape metaphor lives on the sub-mode toggle, not
  the parent tool; the layer-clip indicator/toggle → `CornerDownRight`
  (closest real match to the existing ↳ glyph, same visual metaphor);
  Merge Up/Down → `ChevronsUp`/`ChevronsDown` (double chevron) specifically
  chosen to read as visually distinct from the single-chevron Up/Down
  reorder buttons directly above them in the same row group, since ⇧/⇩ vs
  ↑/↓ were already visually distinct in the old emoji set and a careless
  icon swap could have collapsed that distinction.
- **Verified live**, not just by reading code: `npx tsc --noEmit` clean
  first (confirms every icon import/prop-typing is valid), then opened the
  dev server and walked the whole app — Gallery (Settings button, New
  Canvas tile), the New Canvas size-picker modal, the full Editor screen
  (TopBar, Brush Settings drawer, Color Picker drawer, Layers drawer
  including a layer with Properties expanded and Clipping active so the
  clip-indicator/toggle icons were actually on screen, Tools drawer with
  Select active so the Rectangle/Lasso sub-mode row was visible), and the
  Theme Settings modal (Pink/Dark/Light/Custom buttons). Confirmed via a
  mix of screenshots (where they didn't hit this environment's
  known WebGL-canvas/screenshot flakiness — see this file's ground rules)
  and `read_page` DOM dumps (a reliable fallback when a screenshot call
  timed out, e.g. for the Theme Settings modal) — zero emoji remained
  anywhere in the rendered UI, zero console errors at any point, and a
  final `grep` for the full glyph set across `src/components/` and
  `App.tsx` returned no matches. Did not save any of this session's test
  artifacts back to a persisted project.
- `npx tsc --noEmit` clean, `npm test` 35/35 passing throughout (this
  section touched only presentation, not engine logic, so the existing
  suite wasn't expected to catch anything here — it's there as a
  no-regression check).
- **Not done this session:** 9.2 (design tokens/shared Button component),
  9.3 (typography/custom font), 9.4 (depth/motion polish) — all three
  remain open, per Section 9's own framing as several independently
  shippable passes rather than one big-bang change. 9.1 was explicitly the
  one to do first; the other three are larger and more subjective
  (`9.2`/`9.3` in particular add more new dependencies and touch nearly
  every component file again) and are left for a following session.

**Session 5 — 2026-07-19.** User feedback after Session 4: (1) general request
to boost engine performance ("search online or try stuff out"), (2) the new
layer Properties overlay wasn't self-explanatory, (3) blend modes from "Add
(Linear Dodge)" downward in the dropdown didn't visibly do anything.

- **Root-caused the broken blend modes (two stacked bugs, both fixed):**
  researched PixiJS v8's blend mode architecture. First: v8 only wires up a
  small GPU-native set (normal/add/multiply/screen/erase/subtract) by
  default — everything else (overlay/darken/lighten/difference/color/
  luminosity/etc.) is implemented as a *filter* and needs
  `import "pixi.js/advanced-blend-modes"` registered somewhere, which
  `documentCanvas.ts` never did — added it. Second, after adding that import,
  live-testing still showed no effect and the console had been silently
  logging (session-long) `"Blend filter requires backBuffer on WebGL
  renderer to be enabled. Set useBackBuffer: true..."` — these filter-based
  blend modes need to render to an offscreen texture first (so the filter can
  sample what's already drawn, which plain WebGL blending can't do), and that
  requires `useBackBuffer: true` in the `Application.init()` render options,
  which also wasn't set. Added both. Verified live with a red/blue two-layer
  test: Difference blend now correctly shows yellow where blue overlaps white
  background and magenta where blue overlaps red (exact Difference-blend
  math), confirming the whole chain works now, not just "Add" and below —
  Overlay was silently broken too, just not called out specifically.
- **Engine performance pass:** researched and implemented two real fixes
  rather than speculative ones:
  1. **RAF-coalesced recomposite** (`brushEngine.ts` + `documentCanvas.ts`):
     `HighPerformanceBrushStroke.recomposite()` (a full-layer-canvas
     `clearRect`+two`drawImage` calls) was running, followed by a full GPU
     texture re-upload via `updateCanvasTexture()`, on *every single*
     `pointermove` event — high-poll-rate mice/tablets can fire well past
     display refresh rate, so most of those re-uploads (up to ~16MB each for
     a 2048×2048 RGBA layer) were being thrown away unseen. Moved the
     recomposite+texture-upload out of `move()` into a new
     `DocumentCanvas.scheduleRecomposite()` that coalesces to at most one per
     animation frame via `requestAnimationFrame`, replacing the pending
     ctx/settings with the latest on each call. `flush()`'s own synchronous
     recomposite (the stroke's final, must-be-immediate result) is
     unaffected — `onPointerUp` cancels any still-pending scheduled one first
     so it can't fire afterward and clobber the finished stroke.
  2. **`willReadFrequently: true`** on the brush engine's `preStroke`
     snapshot canvas (`brushEngine.ts`'s `ensureBuffers()`): researched the
     tradeoff — this hint keeps a canvas software-backed to avoid a GPU→CPU
     sync stall on `getImageData()`, at the cost of slower GPU-accelerated
     writes. `preStroke` is written once per stroke but read many times per
     stroke (via `sampleAreaColor()` for Color Mix), so it's a clear win;
     left the write-heavy `wetBuffer`/real layer canvases on default GPU
     acceleration since they're rarely or never read via `getImageData`.
  Verified live: painted a fast 30-point wavy stroke — rendered as a
  complete, smooth curve with no dropped segments or visible stutter, same
  correctness as before the change (RAF-coalescing only throttles *how often*
  the result is pushed to the GPU, never *what* gets drawn into the buffers).
- **Layer Properties panel clarity** (`LayerPanel.tsx`): added a one-line
  intro ("How this layer looks and combines with the layers below it."), a
  plain-language sub-label on the Opacity slider ("how see-through this layer
  is"), a one-line description under the Blend Mode dropdown that updates
  live as you change the selection (`BLEND_MODE_DESCRIPTIONS`, one per mode —
  e.g. Difference: "Shows how much this layer and what's below differ —
  identical colors turn black."), and a one-line description under the Alpha
  Lock/Duplicate row explaining what Alpha Lock does in plain terms. This is
  separate from the blend-mode bug fix above — even once the modes actually
  work, the panel gave no hint what any of them mean, which was the literal
  complaint.
- `npx tsc --noEmit` clean, `npm test` 35/35 passing throughout.

**Session 6 — 2026-07-19.** User asked for new tools (lasso select, shift-key
1:1 resize on the existing rectangle select, and "other tools from very
popular programs"), new brushes (blur and others, ibis Paint as reference),
clipping layers, and a genuinely professional-looking UI remake — then
explicitly asked for all of it to be written into this file, researched
online first, **before implementing anything**, since the conversation was
about to be cleared. This session was planning-only: researched each area
(Photoshop/Illustrator lasso mechanics and point-in-polygon vs. Canvas2D
Path2D/clip() approaches, flood-fill magic-wand algorithms, the classic
sample-and-drag smudge-tool algorithm, ibis Paint's actual tool/brush list,
Procreate's documented clipping-mask behavior and its Alpha-Lock-vs-clipping-
mask distinction, the Shift-key-constrains-proportions convention's universality
across Photoshop/Illustrator/Adobe XD, and current UI-design-critique guidance
on what reads as generic/"AI-generated" in tool interfaces vs. genuine
professional creative-tool UI patterns) and wrote the results into new
**Sections 6-9** below, each grounded in this codebase's actual current
architecture (exact files/functions to touch, what to reuse vs. build fresh,
explicit risk callouts) rather than generic advice. See each section for
sourcing/reasoning. **Nothing in Sections 6-9 is implemented — verify nothing
by reading code, this really is plan-only, same as Session 2 was for
Section 1.** No `tsc`/test runs this session since no code changed.

**Session 4 — 2026-07-19.** User feedback after Session 3: Color Mix looked much
worse when strokes were drawn quickly than slowly (understandable but needed
fixing), plus a fresh feature batch — Alpha Lock, image import to layers, more
ibis-Paint-style layer options, and a fix for the HEX box overflowing its own
Color Picker panel. Implemented all of it:

- **Color Mix quality-at-speed fix** (`src/engine/brushEngine.ts`): root cause
  was the old ~80ms *time*-based sampling throttle — a fast stroke covers far
  more distance per sample than a slow one, so it rode a stale sampled color
  over a much longer stretch before the next sample landed, looking patchy/late
  compared to a slow stroke over the same ground. Switched to *distance*-based
  sampling (`lastColorSamplePos` + `sampleEvery = max(3, size*0.25)`), so
  sampling density per pixel of travel is now speed-independent. Also replaced
  the single noisy sampled pixel with a new `sampleAreaColor()` helper — an
  alpha-weighted average over a small neighborhood (radius up to 16px,
  clamped to brush size) — matching the user's description of ibis Paint
  "taking what's on its sides and underneath," and incidentally fixing
  straddled-edge noise too. Retuned `mixRate` scale and the restore-toward-base
  rate to fit the new sampling cadence. Verified live: painted two identical
  yellow patches, dragged one fast (~4ms between samples) and one slow (~60ms)
  with a 100%-Color-Mix blue brush — both now blend to green smoothly and
  consistently along their whole length, no patchiness in the fast one.
- **Alpha Lock** (ibis Paint/Photoshop "Lock Transparent Pixels"): added
  `alphaLocked?: boolean` to `LayerMeta` (`layerStore.ts`, with a
  `toggleAlphaLock` action) and `alphaLocked: boolean` to `BrushSettings`
  (`brushTypes.ts`, threaded through from the active layer's meta in
  `documentCanvas.ts`'s `getBrushSettings()`). `HighPerformanceBrushStroke
  .recomposite()` now uses `'source-atop'` instead of `'source-over'` for the
  final paint composite when alpha-locked, which clips new paint to pixels the
  layer already has — erasing is deliberately left unaffected (removing alpha
  is allowed; only *adding* alpha to blank areas is locked, matching real
  apps). Verified live: with alpha lock on, a wide stroke dragged clean across
  the whole canvas only showed up inside an existing painted shape; the same
  stroke with alpha lock off painted a full solid bar as expected.
- **Import image as a new layer**: added a Rust command
  `read_image_base64` (`src-tauri/src/lib.rs`, mirrors the existing
  `save_image_base64`) since the frontend has no direct filesystem access in
  Tauri; `src/lib/importImage.ts`'s `pickImageDataUrl()` uses the native
  `open()` file dialog + that command in Tauri, or a plain `<input
  type=file>`/`FileReader` in browser dev mode. `DocumentCanvas
  .importImageAsLayer()` adds a new layer, scales the image to fit the
  artboard (preserving aspect ratio, centered), and renames the layer
  "Imported Image". Wired to a new "🖼 Import Image" button in
  `LayerPanel.tsx`. Verified live (via directly invoking
  `importImageAsLayer()` with a generated test image, since a real OS file
  dialog can't be driven from the browser tooling) — image appeared correctly
  scaled/centered on its own new layer.
- **More layer options**: added `opacity?: number` and `blendMode?: BlendMode`
  to `LayerMeta`, plus `setLayerOpacity`/`setLayerBlendMode` actions and a
  `duplicateLayerMeta` action (inserts metadata directly above the source,
  memory-budget-checked, same pattern as `addLayer`). `DocumentCanvas` applies
  `sprite.alpha`/`sprite.blendMode` in `syncLayers()` (covers project load)
  plus new `setLayerOpacity()`/`setLayerBlendMode()` methods for instant
  slider/dropdown feedback without a full resync, and a `duplicateLayer()`
  method that copies the source canvas's pixels into the new runtime.
  `LayerPanel.tsx`'s layer rows gained a "⚙ Properties" toggle that expands an
  inline panel per layer: Opacity slider, Blend Mode dropdown (Normal,
  Multiply, Screen, Overlay, Add, Darken, Lighten, Difference, Color,
  Luminosity — Pixi v8's `BLEND_MODES` are plain strings, no shader work
  needed), Alpha Lock toggle, Duplicate, and the existing Merge Up/Down
  (moved out of the always-visible icon row to keep it from getting
  overcrowded). All three new fields are optional on `LayerMeta` so old saved
  projects load fine (consumers default `opacity ?? 1`, `blendMode ??
  "normal"`, `alphaLocked` falsy). Verified live end-to-end including a
  save → gallery → reload round trip: opacity 65%, blend mode Screen, and
  alpha lock all survived exactly.
- **HEX box overflow fix** (`ColorPicker.tsx`): classic flexbox bug — a
  `flex-1` text `<input>` doesn't actually shrink below its default
  browser-intrinsic content width unless given `min-width: 0`, so it was
  pushing past the Color Picker panel's right edge in the narrow sidebar.
  Added `min-w-0` alongside `flex-1`. Confirmed fixed via screenshot.
  Did not do a broader menu-layout rework — the rest of the panel already
  reads as intentional/clean, this was the one concrete overflow bug.
- **General engine/usability pass** (per explicit request at the end): checked
  eraser+Alpha-Lock interaction (correctly unaffected), `duplicateLayer`'s
  memory-budget gating (uses the same `canAddLayer` check as `addLayer`),
  `sampleAreaColor`'s out-of-canvas-bounds behavior (safe — `getImageData`
  returns transparent for out-of-range regions, no exceptions), and the new
  per-move `sampleAreaColor` call's cost (reads a small 2D-canvas region —
  cheap, not a GPU-readback stall like the Pixi/WebGL canvas would be).
  Nothing else stood out as a correctness or performance regression from this
  session's changes; the previously-flagged full dirty-rect optimization for
  `recomposite()` (Session 3's Section 2 perf note) remains the one known,
  deliberately-deferred performance item, unchanged by this session.
- `npx tsc --noEmit` clean and `cargo check` clean throughout; `npm test`
  35/35 passing after every change (updated `brushEngine.test.ts`'s
  `BrushSettings` fixture for the new `alphaLocked` field).

<!-- Add new dated entries above this line as work completes. -->

**Session 1 — 2026-07-19.** Full audit + fix pass across the whole app (5-category
audit: correctness, unfinished work, polish, optimization, misc). ~46 items
identified, all implemented and verified (type-check, full build, live browser
testing, 35-test vitest suite added). Highlights: fixed brush hardness gradient
inversion, undo-history memory blowup (structural sharing), spurious two-finger-pinch
undo, floating-selection data loss on save/export, stale-history-after-layer-merge,
project-rename-overwritten-on-save, several GPU/event-listener leaks, doubled
prediction-blend math, edge-of-canvas stroke smearing. Wired up native Tauri save
dialog + JPG/transparent-PNG export. Renamed leftover `ProCreate`/`procreate_mvp_lib`
Rust branding to `flowdy`/`flowdy_lib`. Added unsaved-work protection, Tauri-safe
confirm/rename dialogs replacing `window.prompt`/`confirm`, gallery thumbnail
downscaling, IndexedDB connection caching, and a vitest suite. Verified with
`npm run tauri build` (release build succeeded, produced working MSI/NSIS
installers). Full diff still uncommitted in git at end of session.

**Session 3 (cont'd, 6) — 2026-07-19.** Implemented Section 5 (engine
robustness — done last, per explicit user instruction). **5a (spiral
overshoot):** `HighPerformanceBrushStroke` now tracks `prevDir`, the unit
velocity direction from the previous `move()`. Each `move()` computes the dot
product between the current and previous direction (1 = straight, ≤0 = a
90°+ turn) and multiplies `predictionBlend` by `max(0, dot)` before computing
`drawTip` — so linear velocity extrapolation (a tangent-line guess) is used at
full strength on straight runs, where it's accurate, and damped to ~0 through
a sharp turn, where the real path curves away from that tangent and a stray
line would otherwise jut out. **5b (post-lift overshoot):** `flush()` no
longer sizes the end-taper from `smoothedSpeed` (an exponentially-smoothed,
laggy metric that hadn't decayed yet on an abrupt stop even though the true
speed at lift was ~0) — it now computes `finalSpeed` from the true
displacement/time between the last recorded raw sample and the final lift
sample, and uses that for both the `endTaper` gate and the `actualTail`
length. A gradual slowdown still measures a nonzero final speed and keeps its
taper; a dead stop measures ~0 and gets little/no tail. Verified live with
Felt Tip Pen + End Taper cranked to 120px: (1) an abrupt "fast movement then
dead stop at the same point" stroke ended bluntly right at the stop point,
not a long tail continuing past it; (2) a gradual-slowdown stroke (same
preset) was compared as a control; (3) a tight 3-loop tightening spiral
(dispatched via ~40 synthetic `pointermove`s along a shrinking-radius path)
rendered as a clean coiled blob with no stray straight-line segment jutting
out of the curve. No console errors in any case. `npx tsc --noEmit` clean,
`npm test` 35/35 passing. **This completes every section of this todo except
the deferred remainder of 4c** (the full shared-Button-component/
corner-radius-padding-shadow consistency pass, explicitly left as open
follow-up scope, not a bug).

**Session 3 (cont'd, 5) — 2026-07-19.** Implemented Section 4b + the mechanical
part of 4c (visual/professional cleanup). `themeStore.ts`'s default
`activeTheme` changed from `"pink"` to `"dark"`; pink/light/custom remain
selectable in Settings. `index.css`'s dark palette retuned from the
Catppuccin-derived purple-tinted set (`#11111b`/`#181825`/`#89b4fa`/`#313244`)
to a neutral near-black/gray set (`#18181b`/`#232327`/`#3b82f6`/`#3a3a40`,
text `#f4f4f5`) closer to Procreate's actual look — confirmed
`tailwind.config.js` already registers `shell-accent` etc. as real Tailwind
color tokens, so no config change was needed there. Swept all 12 hardcoded
`bg-blue-*`/`hover:bg-blue-*`/`text-blue-*`/`border-blue-*` occurrences (grep
confirmed 0 remain) across `App.tsx`, `ExportModal.tsx`, `LayerPanel.tsx`,
`Toolbox.tsx`, `TopBar.tsx`, `ToolPalette.tsx` — replaced with
`bg-shell-accent`/`border-shell-accent`/`hover:brightness-110` equivalents so
Save/active-tool/active-layer/preset-menu/theme-picker buttons all actually
follow the active theme instead of staying fixed blue. Did **not** do the
broader "single shared Button component + full corner-radius/padding/shadow
consistency pass" from the todo's 4c — that's a larger, more subjective design
pass; this session fixed the concrete theme-inconsistency bug (the part
grep-verifiable and testable) and left the aesthetic-consistency sweep as
follow-up scope. Verified live in both themes: cleared persisted theme
storage, confirmed dark loads by default with the new neutral palette and a
consistent blue accent on Save/active-Brush-tool/active-layer border; manually
set `data-theme="pink"` and confirmed the same elements pick up the pink
accent instead of staying blue. `npx tsc --noEmit` clean, `npm test` 35/35
passing.

**Session 3 (cont'd, 4) — 2026-07-19.** Implemented Section 1.3 (touch gestures +
Done button). `documentCanvas.ts`'s existing 2-pointer-down handler now checks,
before setting up canvas pinch/zoom state, whether the gesture's midpoint falls
inside an active floating selection (`selection.hasSelection &&
selection.isPointInside(...)`); if so it sets a new `selectionGesture` flag
instead of `isPinching` and records the starting pinch distance/angle plus the
selection's rect/rotation at grab time. The matching `onPointerMove` branch
computes `scale`/`rotDelta` from the two fingers' current distance/angle and
calls a new `SelectionManager.setTransform(rect, rotation, zoom)` method (which
just assigns `currentRect`/`rotation` and refreshes the sprite + outline — the
same sync `updateFloatingTransform()` already did for the single-handle drags
added in 1.2). `onPointerUp`/`onLostPointerCapture` reset the gesture flag once
both fingers lift; since `isPinching` is never set during a selection gesture,
the existing two-finger-tap-undo logic is naturally unaffected. Mouse-native
equivalent (corner-drag resize + rotate handle) already existed from 1.2, so no
extra mouse path was needed. Added a `DocumentCanvas.isSelectionActive()` getter
and a `CanvasStage.tsx` rAF poll (selection state is imperative
engine/SelectionManager state, not app data in a store, so polling a cheap
boolean was simpler than plumbing a new store) driving a floating "✓ Done"
button (bottom-right of the canvas, `bg-shell-accent`) that calls
`commitActiveSelection()` — additive alongside the existing click-outside-to-
commit. Verified live: cutting a selection shows the Done button; clicking it
commits and hides the button. Simulated a real two-finger pinch+twist gesture
(via dispatched `touch`-type `PointerEvent`s) starting inside a floating
selection — the selection visibly scaled up and rotated while the canvas's own
zoom/pan/rotation (checkable via the artboard border staying the same size)
was untouched, confirming the redirect. `npx tsc --noEmit` clean, `npm test`
35/35 passing. **All of Section 1 (select tool) is now done.** Section 4
(visual/professional cleanup) is next per execution order; Section 5 (stroke
prediction/overshoot) stays last per explicit user instruction.

**Session 3 (cont'd, 3) — 2026-07-19.** Implemented Section 1.2 (rotate handle) in
`SelectionManager.ts`: added a `rotation` field, a `'rotate'` member to
`activeHandle`'s union, and a `toLocal()` helper that un-rotates a world point into
the rect's own frame around its center — used by `getHitHandle()` (now also tests
a rotate-handle hotspot 30 world-units above top-center) and `isPointInside()`
(so dragging inside a rotated selection still works). Corner-resize dragging now
converts the pointer delta into the rect's local axes (around the *initial*
center, fixed for the drag's duration) before applying it, so resizing a rotated
selection still resizes along its own edges instead of the screen's. `draw()`
now renders a rotated quad (via `moveTo`/`lineTo` instead of the old axis-aligned
`rect()`) plus a circular rotate handle with a stem line above top-center.
`floatingSprite` switched to anchor (0.5, 0.5) so `sprite.rotation` (native Pixi
support) can drive the live preview; a new `updateFloatingTransform()` helper
centralizes position/size/rotation sync and replaced several duplicated manual
`position.set()` call sites. `commitSelection()` now paints rotated content via
`ctx.translate/rotate/drawImage` when `rotation !== 0`, axis-aligned `drawImage`
otherwise. Verified live: cut an asymmetric L-shaped selection, dragged the
rotate handle (visible circle+stem above the selection) — selection outline,
corner handles, and the floating content all rotated together live; committed by
clicking outside — the rotated pixels pasted cleanly into the layer with no
residue at the original position and no blur. `npx tsc --noEmit` clean,
`npm test` 35/35 passing. 1.3 (touch/gesture redirection + Done button) not yet
done — next up per execution order.

**Session 3 (cont'd, 2) — 2026-07-19.** Implemented Section 3 (Color Mix / Mixbox
rework): installed `mixbox` (2.0.0, CC BY-NC, self-contained/synchronous, no async
init — confirmed by reading the package source directly), added an ambient
`src/lib/mixbox.d.ts` module declaration (package ships no types), and replaced
the naive RGB-lerp mixing in `brushEngine.ts`'s `move()` colorMix block with
`mixbox.lerp(this.wetColor, sampledPixel, mixRate)`. Kept the existing ~80ms
throttled-sampling structure (full per-footprint smear flagged as a future
stretch goal, not done). Retuned `mixRate`'s scale from `colorMix * 0.15` to
`colorMix * 0.35` — the old constant was tuned to compensate for the
pre-Section-2 unbounded-Flow behavior and felt too weak once that was fixed.
Restore-toward-base-color path (no pixel underneath) left as plain RGB lerp —
it's just decay toward an exact known color, not simulating pigment mixing, so
Mixbox doesn't apply there. Verified live: painted a yellow patch, then a blue
stroke with Color Mix at 100% over it — result blended into a vibrant green
(matching Mixbox's Kubelka-Munk pigment model), not the muddy gray/brown a plain
RGB lerp would have produced. `npx tsc --noEmit` clean, `npm test` 35/35 passing.

**Session 3 (cont'd) — 2026-07-19.** Implemented Section 2 (Flow/Opacity rework):
`HighPerformanceBrushStroke` now owns a pooled pair of per-stroke scratch canvases
(`preStroke` snapshot + `wetBuffer`). `down()` snapshots the real layer into
`preStroke` and clears `wetBuffer`; all dab-stamping in `move()`/`flush()` now
targets `wetBuffer` at Flow (`intensity`) strength (uncapped, compounding as
before — that's correct, it's the buildup rate); a new `recomposite()` step runs
after each batch of dabs and redraws the real layer as `preStroke, then wetBuffer
at globalAlpha = opacity`, so a stroke's visible strength can never exceed the
Opacity slider regardless of overlap. `paintDab`'s `dabOpacity` no longer
multiplies by `settings.opacity` (that's now applied once, at recomposite, not
per-dab). Eraser dabs also now build an alpha mask in `wetBuffer` via
`source-over` (previously punched `destination-out` into the real layer per-dab,
uncapped) and the mask is applied via `destination-out` at `globalAlpha = opacity`
during recomposite — same ceiling behavior as paint. Color-mix sampling
(`this.preCtx!.getImageData`) now reads the pre-stroke snapshot instead of the
live layer, so it can't sample the current stroke's own paint. Verified live:
50%-opacity brush scribbled ~40 heavily overlapping dabs over the same spot
rendered as a uniform mid-gray, not compounding toward black; undo cleanly
reverted the whole stroke. `npx tsc --noEmit` clean, `npm test` 35/35 passing.
Section 3 (Color Mix) should be re-tested against this fix before further tuning,
per the plan's own note that it may resolve mostly as a side effect.

**Session 3 — 2026-07-19.** Implemented Section 1.1 (select-tool self-collapse fix):
removed the `bakeFloatingSelection()` call from `captureSnapshot()` in
`documentCanvas.ts`, added `dc.commitActiveSelection()` at the top of
`saveCurrentProject()` in `appStore.ts` so save still flattens floating pixels, and
rounded `nx/ny/nw/nh` to integers in `SelectionManager.extractPixels()` to kill the
subpixel-resample blur. Verified live in-browser via dispatched `PointerEvent`s: cut
a selection, dragged it to a new position (stayed floating, didn't snap back),
resized via corner handle (still floating, handles tracked correctly), committed by
clicking outside (clean commit, no blur), then undo restored the pre-commit floating
state correctly. `npx tsc --noEmit` clean, `npm test` 35/35 passing. Section 1.1 is
done; 1.2/1.3 (rotate handle, gestures) intentionally deferred per execution order —
Section 2 (Flow/Opacity) is next.

**Session 2 — 2026-07-19.** User reported the Select tool doesn't work (selection
"doesn't stay on", gets blurry, can't resize), Flow/Intensity doesn't behave like a
real Flow control, and Color Mix doesn't mix colors convincingly. Investigated live
in-browser and **root-caused the select-tool bug with certainty** (see Task 1.1 below
— confirmed via direct API test, not guesswork). Researched Photoshop/Procreate's
real Flow-vs-Opacity model and ibis Paint's selection/transform gesture model, and
production wet-mixing approaches (Mixbox pigment mixing vs naive RGB lerp) to ground
the rework plan. User confirmed: (a) selection tool should get ibis-Paint-style
gestures (pinch/rotate) *in addition to* mouse handles, with a future note about
mesh/node-based inner-warp (not to be built yet, just don't design against it); (b)
Mixbox is fine to use (project is personal/non-commercial, license is CC BY-NC); (c)
Procreate is the reference app for the tool-authenticity audit, and the default theme
should change from pink to a new professional/neutral one (pink kept as an option).
This file is the resulting plan. **Nothing in Sections 1-5 below has been
implemented yet** — this session only investigated and planned.

<!-- Add new dated entries above this line as work completes. -->

---

## Execution order

1. Section 1.1 (select-tool bug fix) — small, high-confidence, unblocks everything
   else about that tool.
2. Section 2 (Flow/Opacity rework) — also unblocks Section 3.
3. Section 3 (Color Mix / Mixbox).
4. Section 1.2 → 1.3 (select rotate handle, then gesture support) — build on the
   now-fixed foundation.
5. Section 4 (visual/professional cleanup — theme + buttons).
6. Section 5 (engine robustness — stroke prediction/overshoot) — **do this last**,
   after everything above, per explicit user instruction.

**Sections 1-5 above are all done as of Session 5 — see the Alpha Log.** Sections
6-9 below are new, added in Session 6, and are **planning only — nothing in them
has been implemented yet.** Suggested order for whoever picks them up:

7. Section 6.2 (shift-key 1:1 resize) — trivial, do it first, no reason not to.
8. Section 8 (clipping layers) — foundational for how layers relate to each
   other; do before brushes/lasso so later work doesn't have to retrofit
   around it.
9. Section 6.1 (lasso select) — meaningfully-sized, self-contained.
10. Section 7 (new brushes — blur, smudge) — self-contained, can slot in
    anywhere after Section 8 if the brush needs to respect Alpha Lock/clipping.
11. Section 9 (UI professional pass) — do last; it touches nearly every
    component file, so doing it after the functional additions above avoids
    restyling things twice.
12. Section 6.3 (other popular tools — magic wand, etc.) is intentionally
    **not** in this order — it's a menu of candidates for a *future* pass, not
    scoped work for the immediate next session. Pick from it only if the user
    asks for a specific one.

**Sections 1-9 are all done as of Session 7 — see the Alpha Log.** Sections
10-14 below are new, added at the end of Session 7, and are **planning
only** except 10.2, which is already done — nothing else in them has been
implemented yet. This is the user's own explicit priority order (given
verbatim, not reordered):

13. Section 10.1 (smudge color-regression bug) — fix this first. Root cause
    was investigated this session but not confirmed (see Alpha Log) — the
    next session must continue that investigation, *not* guess a fix. This
    blocks real use of the Smudge tool, so it comes before any visual work.
14. Section 10.2 (canvas shrinks when a panel closes) — **already done**,
    see Alpha Log. Listed here only to preserve the user's original
    numbering.
15. Section 11 (panel layout & professionalism rework) — **DONE, Session 8**
    (overlay-panel option, chosen by the user). Sections 12-13 below now
    have a settled structure to restyle within (`OverlayPanel`, the left/
    right rails) instead of the old docked `Drawer`s — pick up from there.
16. Section 12 (Brush Settings: visual redesign + brush-type-is-a-real-
    brush-not-a-preset + brush preview thumbnails).
17. Section 13 (Color Picker: color wheel).
18. Section 14 (full layout/professionalism pass — spacing, radius,
    iconography, typography consistency across every panel; touch-target
    sizing) — do this last, after the structural and per-panel work above,
    for the same reason Session 6 put its own UI pass last: touching every
    component file once, after the functional shape has settled, beats
    restyling things twice.

---

## 1. Select tool

### 1.1 — Fix the root cause: selection self-collapses immediately after every cut
**[DONE — Session 3. Confirmed live, not a guess — see reasoning below]**

- **File:** `src/engine/documentCanvas.ts` — method `captureSnapshot()`.
- **Root cause (verified via direct API test bypassing the pointer pipeline):**
  Cutting a selection calls `endSelection()` → sets `hasSelection = true` → fires
  `onStrokeCommitted()` → which calls `captureSnapshot()` for the undo-history push
  → and `captureSnapshot()` unconditionally calls `this.bakeFloatingSelection()` at
  its top. Since `hasSelection` was *just* set true, this immediately pastes the
  selection right back where it was cut from and clears `hasSelection` back to
  `false` — within the same synchronous call. The floating selection never
  actually "stays on."
- **Why this also causes "resize does nothing":** `getHitHandle()` (private method
  in `SelectionManager.ts`) requires `hasSelection === true` to register a corner
  hit. Since the selection is already baked back before the user's next click,
  there's nothing left to grab — clicks fall through to "click outside → start new
  selection."
- **Why it looks blurrier:** `commitSelection()` in `SelectionManager.ts` pastes
  back via `ctx.drawImage(tempCanvas, rect.x, rect.y, rect.w, rect.h)`. `rect.w/h`
  come from float world-coordinates; `tempCanvas.width/height` are the browser's
  rounded integer version of the same float. Any mismatch forces antialiased
  resampling on every accidental re-bake, softening edges.
- **Fix:**
  1. Remove `this.bakeFloatingSelection();` from the top of `captureSnapshot()`.
     Undo/redo history doesn't need floating-selection state baked in — it's
     transient interaction state, not committed layer pixels. The existing
     `discardFloatingSelection()` call in the Ctrl+Z keydown handler already
     handles "undo while a selection floats" correctly (drops it, doesn't paste).
     **Keep** the bake calls in `compositeToDataURL()` and `exportAsBlob()` —
     export/thumbnails genuinely need a flattened raster.
  2. **Required follow-up, don't skip:** `src/stores/appStore.ts` →
     `saveCurrentProject()` calls `dc.captureSnapshot()` then
     `dc.compositeToDataURL()`. Once the bake is removed from `captureSnapshot`,
     a selection floating at save-time would be captured with a hole (pixels not
     yet placed) while the thumbnail's own bake call commits it separately
     afterward — snapshot and thumbnail would disagree, and the floating pixels
     would be missing from the persisted project forever. Fix: at the top of
     `saveCurrentProject`, call `dc.commitActiveSelection()` (existing public,
     history-recording bake) *before* `captureSnapshot()`.
  3. **Also fix the float/integer mismatch, don't just paper over it:** in
     `SelectionManager.extractPixels()`, round `nx/ny/nw/nh` to integers
     (`Math.round`) before using them for both the `tempCanvas` dimensions and
     the stored `currentRect`. Removes sub-pixel resample blur even on
     legitimate resizes.
- **Test after fixing:** cut a selection → verify it stays floating → drag a
  corner handle to resize → drag inside to move → click outside to commit →
  undo → redo → save project → reopen it → verify pixels are intact, not lost,
  not blurred.
- **Risk: Needs care** — this is the load-bearing fix for the whole tool.

### 1.2 — Add a rotate handle (mouse-native)
**[DONE — Session 3. See Alpha Log for what changed / how it was verified.]**
- **File:** `src/engine/SelectionManager.ts`.
- Currently only x/y move and w/h resize exist — no rotation.
- Add a handle (small circle, fixed screen-distance above top-center of the
  selection — standard Photoshop/Affinity/Krita placement) that sets a new
  `rotation` field (radians). Apply live to `floatingSprite.rotation` for preview
  (Pixi sprites support this natively). On commit, `commitSelection()` must paint
  rotated content:
  ```
  ctx.save();
  ctx.translate(centerX, centerY);
  ctx.rotate(rotation);
  ctx.drawImage(tempCanvas, -w/2, -h/2, w, h);
  ctx.restore();
  ```
  instead of the current axis-aligned `drawImage`.
- **Risk: Needs care** — `getHitHandle()` currently assumes an axis-aligned rect.
  Once rotation is nonzero, corner hit-testing needs the test point rotated into
  the rect's local space before comparing, or hit-testing breaks post-rotation.

### 1.3 — Add ibis Paint's touch gesture set, redirected from canvas gestures when a selection is active
**[DONE — Session 3. See Alpha Log for what changed / how it was verified.]**
- **Files:** `src/engine/documentCanvas.ts` (the existing 2-pointer pinch block in
  `onPointerDown`/`onPointerMove`), `src/engine/SelectionManager.ts`.
- ibis Paint's model (confirmed via their docs): one-finger drag inside = move
  (already works); two-finger pinch = uniform scale; two-finger twist = rotate; a
  "Done" button confirms.
- Flowdy's existing 2-pointer handling always zooms/pans the *canvas* — it has no
  awareness a selection might be active. Add a branch: when
  `this.selection.hasSelection` is true and a 2-pointer gesture starts *inside*
  the current selection rect, drive the selection's scale/rotate (from 1.2)
  instead of `this.zoom`/`this.rotation`. Outside the selection (or no
  selection), keep current canvas-zoom behavior unchanged.
- **Mouse equivalent (user explicitly wants this usable without touch too):** the
  corner-handle drag (1.1, already exists) *is* the mouse-native scale
  interaction, and the rotate handle (1.2) is the mouse-native rotate
  interaction — both drive the same underlying `currentRect`/`rotation` state as
  the touch gestures, so there's one shared model underneath, two input paths
  into it. No separate "fake pinch with a mouse" mechanism needed.
- Add an explicit **"Done" / checkmark button** near the selection (floating
  toolbar or a fixed toolbox button) as an alternative to "click outside to
  commit" — keep click-outside working too, the button is additive.
- **Risk: Needs care** — genuinely new interaction surface. Get 1.1 and 1.2 fully
  solid and tested first.

### 1.4 — Do NOT build yet: mesh/node-based inner reshaping
User wants to eventually drag individual points *inside* a selection to warp its
content (ibis Paint's "Mesh Form" — the layer is divided into a grid and you drag
grid points to warp it; different from "Translate Scale" which is 1.1-1.3). Don't
build this now. Just keep `SelectionManager`'s public commit/discard API generic
enough (`startSelection`/`updateSelection`/`endSelection`/`commitSelection`
lifecycle) that a future mesh-transform mode could plug into the same lifecycle
hooks rather than needing a rewrite.

---

## 2. Flow (Intensity) — rework to match real Flow/Opacity behavior
**[DONE — Session 3. See Alpha Log for what changed / how it was verified.]**

Per Photoshop/Procreate's documented behavior: **Opacity is a ceiling; Flow is a
per-application rate that builds up within one continuous stroke but can never
exceed that ceiling until you lift the pen.**
(Sources: https://phlearn.com/tutorial/the-difference-between-flow-and-opacity-in-photoshop/ ,
https://f64academy.com/brush-flow-vs-opacity-photoshop/ ,
https://afbrushpacks.com/understanding-opacity-and-flow-in-brushes-of-procreate/)

- **File:** `src/engine/brushEngine.ts` — `paintDab()`, `HighPerformanceBrushStroke`.
- **What's wrong:** `paintDab` computes `dabOpacity = opacity * intensity` and
  draws every dab with plain `source-over` directly onto the real layer canvas.
  Dabs along a stroke overlap heavily (spacing ≈5-10% of brush size), so each
  overlapping dab compounds alpha further (`1 - (1-a)^n`) with **no ceiling** —
  it mathematically approaches 100% opacity as dabs pile up, regardless of the
  `opacity` setting. There's no real distinction between "how strong is each
  dab" (Flow's job) and "how strong can the whole stroke ever get" (Opacity's
  job) — they're just multiplied and both get exceeded once enough dabs overlap.
- **The fix — stroke buffer (the standard technique real engines use):**
  1. On `down()` (stroke start): allocate a scratch canvas the size of the active
     layer (or its dirty-rect bounding box, as a later perf pass), fully
     transparent. Also snapshot the layer's current pixels into a second scratch
     canvas ("pre-stroke copy") via canvas-to-canvas `drawImage` (same pattern
     already used in `documentCanvas.ts`'s `blitAndDiscard`).
  2. During `move()`: paint dabs into the **scratch buffer**, not the real layer,
     using `intensity` (this *is* Flow — consider renaming internally for
     clarity) as the per-dab alpha. Compounding within the buffer is fine and
     expected.
  3. Each frame (reuse the existing RAF batching via `enqueueDraw`/
     `flushDrawQueue`): recomposite the visible layer as `pre-stroke copy, then
     draw scratch buffer on top with ctx.globalAlpha = opacity`. Starting fresh
     from the untouched pre-stroke copy every time means the stroke's total
     visual contribution can never exceed `opacity`, no matter how saturated the
     buffer itself got.
  4. On `flush()` (stroke end): one final recomposite; drop the scratch buffers
     (or return them to a pool — see perf note below).
- **Eraser:** same technique, but the scratch buffer accumulates an alpha *mask*
  via Flow-dabs, applied to the pre-stroke copy via `destination-out` at
  `globalAlpha = opacity`.
- **Why this also unblocks Section 3:** Color Mix currently samples pixel color
  from the real layer `ctx` mid-stroke, which right now includes the *current
  stroke's own* already-painted, uncapped pixels — corrupting "the color
  underneath." Once dabs paint into a separate scratch buffer and the real layer
  isn't touched until composite, sampling the real layer mid-stroke gets a clean
  read of what's actually underneath.
- **Risk: Needs care.** Real architecture change to the hot path (every dab now
  targets a scratch surface, plus a recomposite step per frame). **Perf note:**
  allocating a full-layer-size (e.g. 2048×2048) scratch canvas pair fresh per
  stroke will stall on rapid stroke-after-stroke input — pool/reuse one scratch
  canvas pair across strokes instead of allocating new ones each time.

---

## 3. Color Mix — rework for authentic, vibrant mixing
**[DONE — Session 3. See Alpha Log for what changed / how it was verified.]**

- **File:** `src/engine/brushEngine.ts` — `HighPerformanceBrushStroke.move()`.
- **What's wrong, precisely:**
  1. `mixRate = settings.colorMix * 0.15` is completely decoupled from
     Flow/Intensity — cranking Flow doesn't make mixing more visible, it just
     makes the (currently uncapped, per Section 2) fresh paint overpower the
     mixed color faster. This is why it "takes forever at high intensity" — it's
     not that mixing is slow, unbounded Flow buildup is drowning it out before it
     can show. **Re-test this after Section 2 lands before doing more work here**
     — it may resolve mostly as a side effect.
  2. The mixing itself is naive linear RGB interpolation:
     `wetColor.r += (pixel.r - wetColor.r) * mixRate`. Real "natural" mixing in
     production software doesn't do this — RGB averaging between complementary
     colors produces muddy gray/brown instead of vibrant secondary colors. This
     is what "doesn't mix like mainstream software" is describing. Reference:
     Mixbox (used by Rebelle 5 Pro's "Pigments" feature) mixes in a
     4-component pigment space via Kubelka-Munk theory so blue+yellow actually
     produces green, not gray.
     (https://github.com/scrtwpns/mixbox , https://scrtwpns.com/mixbox/)
- **Fix:**
  1. Add `mixbox` npm package (confirmed OK by user — CC BY-NC license, project
     is personal/non-commercial). Replace the RGB lerp with
     `mixbox.lerp(wetColorHex, sampledColorHex, mixRate)` — check the JS API
     docs (https://scrtwpns.com/mixbox/docs/javascript/README) for exact
     signature/return type and whether it needs an async init (some
     pigment-mixing libs load a lookup-table texture; confirm bundle size and
     init cost before committing to the hot path).
  2. Keep the periodic-sampling structure (throttled ~80ms) for now — full
     per-pixel "smear under the whole brush footprint" (closer to how
     Photoshop's Mixer Brush actually picks up paint —
     https://helpx.adobe.com/photoshop/using/painting-mixer-brush.html) is a
     bigger lift. Flag as a stretch goal, not required this pass.
  3. Re-tune `mixRate`'s scale (currently capped at 0.15 max) once both the Flow
     fix and Mixbox are in — the "correct" feel will want a different constant
     than what was compensating for the old broken Flow behavior.
- **Risk: Moderate** — new dependency in the hot rendering path; verify bundle
  size / init cost before committing.

---

## 4. Visual / professional cleanup

### 4a. Tool authenticity gaps (Procreate as reference) — for awareness, mostly future scope
Documented for prioritization later, **not scoped into this pass** except where
noted:
- Select tool is rectangle-only; Procreate has Freehand/Ellipse/Automatic modes +
  Add/Subtract. (Rectangle-mode fixes are Section 1 above; other modes = new
  tools, future work.)
- Brush engine: no per-brush blend-mode selection (only the `marker` style
  hardcodes `multiply`), no pressure-mapped taper curves, no stylus
  tilt/azimuth support. Future brush-engine milestone, not this pass.
- Layers: no per-layer opacity/blend mode/mask/group — only visibility toggle
  exists. Significant, frequently-used Procreate feature, entirely missing.
  Worth prioritizing as the *next* major feature after this whole TODO, but it's
  new scope, not a bug — don't build it as part of this pass.
- Color picker is reasonably close to Procreate's Classic/HSB tab already; not
  flagged as broken.

### 4b. Theme — change default, keep pink as an option
**[DONE — Session 3. See Alpha Log.]**
- **File:** `src/stores/themeStore.ts` — change `activeTheme: "pink"` default to
  `"dark"`.
- **File:** `src/index.css` — refine the existing `html[data-theme="dark"]`
  palette toward Procreate's actual look: near-black panels, high-contrast light
  text, one restrained blue accent. Current dark theme (Catppuccin-derived) is
  close but has a purple tint — nudge toward true neutral gray/black.
- Keep pink/light/custom as selectable options in Settings, just not the
  default.

### 4c. Buttons and general UI — make everything look more professional
**[PARTIALLY DONE — Session 3.** The hardcoded-blue theme-inconsistency bug (the
concrete, grep-verifiable part) is fixed — see Alpha Log. The broader "one
shared Button component + consistent corner-radius/padding/shadow across every
button in the app" pass described below is **still open** — remains as
described.]
- **Files:** all of `src/components/*.tsx` plus `App.tsx`'s inline Settings
  modal.
- **Problem found via grep (12 hits):** hardcoded `bg-blue-600` /
  `hover:bg-blue-500` / `text-blue-*` / `border-blue-*` Tailwind classes appear
  throughout (Save button, Undo/Redo active states, selected color swatch
  border, layer active-row border, etc.) *instead of* the theme's
  `--shell-accent` variable. This means these specific elements don't actually
  follow the active theme — switching themes leaves them a fixed blue, which
  reads as inconsistent/unpolished. Before a global find-replace, confirm
  `tailwind.config.js` registers `shell-accent` (and friends) as proper Tailwind
  color tokens (e.g. `theme.extend.colors['shell-accent']`), not just raw CSS
  vars referenced ad hoc — if not, add that config first so `bg-shell-accent`
  etc. actually work as utility classes.
- **Inconsistent button styling overall** — spot-checked and found: corner
  radius varies (`rounded-lg` vs `rounded-xl` vs `rounded-full` with no
  apparent system), padding scale varies (`px-3 py-1.5` vs `px-4 py-2` vs `p-3`),
  shadow usage varies (`shadow-sm` vs `shadow-2xl` vs none), hover states
  sometimes swap the whole background color abruptly instead of a subtle
  brightness/opacity shift. This is the concrete substance of "make the buttons
  look more professional" — not a vague aesthetic ask, a consistency problem.
- **Do this:** create one shared button treatment (either a small `Button`
  component in `src/components/`, or at minimum a documented set of Tailwind
  class recipes for primary/secondary/icon/danger button variants) and migrate
  every button in the app to use it. This should be a single source of truth so
  future buttons are consistent by default, not another one-off styling pass.
  Suggested variants based on current usage patterns: primary (accent-filled,
  for Save/Create/main actions), secondary (bordered, bg-shell-bg, for
  Cancel/Gallery-style nav), icon (compact, for layer row up/down/delete/merge
  buttons), danger (red, for Delete). Keep corner radius, padding, and shadow
  consistent within each variant across every file.
- Re-verify in both the new default (dark) theme and at least one alternate
  (pink or light) after the change, since the whole point is theme-consistency.
- **Risk: Trivial-to-Moderate.** Default-theme swap is trivial. The
  button/hardcoded-color sweep is mechanical but touches many files — do it as
  its own pass, visually check both themes afterward before considering it
  done.

---

## 5. Engine robustness — stroke prediction & end-of-stroke overshoot

**Do this section last, after Sections 1-4 are done, per explicit user
instruction ("a little last step after remaking everything").**

Both of these are in `src/engine/brushEngine.ts`, inside
`HighPerformanceBrushStroke`. **Neither has been live-tested/confirmed in this
session** (unlike Section 1.1, which was fully confirmed) — treat the analysis
below as a strong starting hypothesis to verify, not a given.

### 5a. Sharp linear line jutting out of a curved stroke (e.g., drawing a spiral)
**[DONE — Session 3. See Alpha Log.]**
- **User's description:** when drawing a tight curve (their example: a spiral),
  occasionally a straight line segment shoots out of the curve in a "linear way"
  — i.e., a stray tangent line breaking the smooth curve.
- **Likely cause:** `move()`'s prediction step:
  ```
  const predT = this.tuning.predictionMs / 1000;
  const predX = this.smooth.x + this.vel.x * predT;
  const predY = this.smooth.y + this.vel.y * predT;
  ```
  This is **linear velocity extrapolation** — it projects the *current* velocity
  vector forward in a straight line to guess where the pen will be a few ms from
  now. That's a tangent-line approximation of the future path. On a tightly
  curved path (a spiral is the worst case — direction is *constantly* changing),
  the real future path curves away from that tangent, so the prediction
  "shoots" straight in the current direction instead of following the curve.
  The tighter the curve and the higher the prediction distance/speed, the more
  visible the overshoot — matching exactly "one line is just out of the spiral
  in a linear way."
- **Suggested fix directions (pick one, verify visually against a hand-drawn
  spiral test before/after):**
  1. Detect curvature: compare the direction of the last two motion segments: if
     the angle between them exceeds a threshold, scale down `predictionBlend`
     for that frame (less prediction when turning sharply, full prediction on
     straight runs where it's actually safe and useful).
  2. Or replace linear extrapolation with curvature-aware extrapolation —
     extrapolate along the tangent of the existing quadratic curve
     (`stampAlongQuadratic`'s control points) at its endpoint, rather than the
     raw instantaneous velocity vector.
  3. Or simply reduce `DEFAULT_BRUSH_TUNING.predictionMs`/`predictionBlend` to
     more conservative values — prediction exists to reduce end-of-stroke input
     lag, not to extrapolate indefinitely; a smaller lookahead window shrinks
     the worst-case overshoot proportionally.
- Test by simulating a tight spiral gesture (small radius, multiple loops) via
  dispatched `PointerEvent`s at varying speeds and visually inspecting the
  result (screenshot tooling was unreliable earlier in this project's sessions —
  if still true, read back the layer canvas pixels via `getImageData` and check
  for stray isolated line segments outside the expected curve's bounding path,
  or render to a data URL and inspect that way).

### 5b. Stroke continues past where the pointer actually stopped
**[DONE — Session 3. See Alpha Log.]**
- **User's description:** "when finishing a line... the stroke should stop
  where the holding has stopped, the program always recalculates the data
  after a stroke is done and adds another bunch of spheres at the end making a
  line a bit longer than intended."
- **Likely cause:** `flush()`'s end-taper branch:
  ```
  if (settings.endTaper > 0 && this.smoothedSpeed > 20) {
     // walks `actualTail = min(endTaper, smoothedSpeed * 0.2)` distance
     // beyond `this.lastDrawn`, stamping a shrinking tail of dabs
  }
  ```
  This is *by design* for a tapered brush-lift effect (real brushes taper as
  they lift off the canvas) — but note **3 of the 4 built-in presets** in
  `src/stores/editorStore.ts` (`BRUSH_PRESETS`) have nonzero `endTaper`
  (Fade Watercolor: 150, Blurring Marker: 80, Round Brush: 40 — only Felt Tip
  Pen has 0), so this triggers for most presets a user would actually pick,
  matching "the program *always* does this."
  The real bug is likely **not** that tapering happens, but that its *length*
  is based on `this.smoothedSpeed`, which is an exponentially-smoothed,
  *lagging* metric:
  ```
  this.smoothedSpeed = this.smoothedSpeed * 0.8 + instantSpeed * 0.2  // (decelerating case)
  ```
  If the user stops the pen **abruptly** (sudden full stop, not a gradual
  slowdown), `smoothedSpeed` at the moment of pointerup hasn't had time to decay
  from whatever it was a few samples ago — so `actualTail` gets computed from a
  *stale, still-high* speed value even though the true instantaneous speed at
  the stop is ~0. This produces a disproportionately long tail exactly on
  abrupt stops, which is precisely "the stroke should stop where the holding
  stopped" being violated.
- **Suggested fix directions (verify against a deliberate "draw then stop dead"
  test, comparing tail length for abrupt vs. gradual stops):**
  1. Compute the taper length from the **true instantaneous velocity at the
     final sample** (derivable from the last two raw samples in
     `this.strokePoints`/`rawLast`, not the lagging `smoothedSpeed`), or at
     minimum blend in a much faster-decaying estimate right at `flush()` time.
  2. Add a stillness check: if the pointer hasn't moved appreciably for some
     short window before lift (e.g. compare the last couple of raw sample
     positions/timestamps), treat it as a deliberate stop and suppress/shrink
     the tail rather than tapering based on stale motion data.
  3. Re-verify the non-taper branch too (the `else` in `flush()`, used when
     `endTaper === 0` or `smoothedSpeed <= 20`) doesn't have a similar overshoot
     via `stampAlongSegment` drawing to `safeSample` — confirm `safeSample` is
     the *actual* last pointer position and not a predicted one leaking through
     from `move()`'s `drawTip`.
- **Risk: Needs care** for both 5a and 5b — this is stroke-feel-critical code
  used on every single stroke in the app. Any change here needs to be checked
  against a range of stroke speeds/shapes (slow careful lines, fast flicks,
  tight curves, dead stops) before considering it done, not just the one
  reported scenario.

---

## 6. New tools
**[PLANNING ONLY — Session 6. Nothing below is implemented.]**

### 6.1 Lasso select tool
**[DONE — Session 7. See Alpha Log.]**
- **Reference:** Photoshop has both a Freehand Lasso (traces the pointer path
  1:1) and a Polygonal Lasso (click to place straight-line vertices, click the
  start point to close). ibis Paint's Lasso is freehand-drag only. Build
  freehand first — it matches the interaction model Flowdy's rectangle
  marquee already uses (press-drag-release); treat polygonal as a stretch
  addition, not v1 scope.
- **Key insight — this reuses almost all of Section 1's work, don't rebuild
  it:** once a lasso'd region is cut, the result is conceptually identical to
  what the rectangle select tool already produces — a rectangular bounding-box
  sprite (`SelectionManager.floatingSprite`) whose texture happens to have an
  irregular alpha shape baked in instead of being fully opaque. Everything
  built in Session 3 (corner-handle resize with local-space delta math,
  rotate handle, `setTransform()` for the touch pinch/rotate gesture,
  `commitSelection()`'s rotated-paste-back) operates purely on `currentRect`/
  `rotation`/the `tempCanvas` texture and has **no idea** whether that texture
  is a plain rectangle or a lasso'd shape. So: only the *extraction* step
  needs new code; move/resize/rotate/gesture/commit are unchanged.
- **Extraction implementation sketch** (`SelectionManager.ts`):
  1. Add a `lassoPoints: Point[]` array, populated during `updateSelection()`
     while in lasso mode (append the raw world-space point each call — no
     need for the quad-smoothing machinery `brushEngine.ts` uses, a lasso
     selection edge is expected to look hand-drawn).
  2. On release, compute the bounding box of `lassoPoints`, then build a
     `Path2D` from the points **translated into that bbox's local space**
     (subtract `bboxX/bboxY` from every point).
  3. Extract via `destination-in` clipping instead of a plain rect copy:
     draw the source layer's bbox region onto `tempCanvas` as today, then
     `tempCtx.save(); tempCtx.globalCompositeOperation = 'destination-in';
     tempCtx.fill(path2D); tempCtx.restore();` — this punches out everything
     outside the lasso'd shape, leaving `tempCanvas` with a normal RGBA image
     but only the lasso'd pixels opaque. From here on it's identical to the
     rectangle flow (`Texture.from(tempCanvas)`, `floatingSprite`, etc.).
  4. Clearing the source layer must also respect the lasso shape, not the
     whole bbox: `ctx.save(); ctx.clip(path2D-in-absolute-coords);
     ctx.clearRect(bboxX, bboxY, bboxW, bboxH); ctx.restore();` (note: this
     clip needs the path in the *layer's* coordinate space, i.e. not
     translated to bbox-local — keep both versions, or translate the ctx
     instead of the path).
  5. Optional polish: lightly smooth `lassoPoints` before building the path
     (e.g. a small moving-average or Douglas-Peucker simplify at a tight
     epsilon) so the selection edge isn't jittery from raw pointer noise —
     nice-to-have, not required for v1.
- **UI:** add a Rectangle/Lasso sub-mode toggle shown when the Select tool is
  active (`ToolPalette.tsx` or `Toolbox.tsx`) — mirrors how Photoshop nests
  marquee-shape options in its tool options bar. Simplest version: a small
  two-button switch, not a full nested tool menu.
- **Risk: Moderate-large.** Real new extraction math, but it sits *underneath*
  an already-solid, already-tested selection foundation — the move/resize/
  rotate/gesture/commit code from Session 3 needs zero changes.

### 6.2 Shift-key 1:1 aspect-ratio-locked resize
**[DONE — Session 7. See Alpha Log.]**
- **Confirmed via research:** holding Shift while dragging a corner resize
  handle to constrain proportions is a decades-old, universal convention
  (Photoshop, Illustrator, Adobe XD, and reportedly as far back as MacPaint) —
  implement it exactly that way, no deviation needed.
- **Hook point:** `SelectionManager.updateSelection()`'s corner-resize branch
  (added in Session 3 — computes `nx/ny/nw/nh` from `initialRectPos` plus a
  local-space-rotated delta). Needs a `shiftKey: boolean` parameter threaded
  through from `documentCanvas.onPointerMove`'s `PointerEvent.shiftKey` down
  to `updateSelection(x, y, zoom, shiftKey)`.
- **Math:** when `shiftKey` is true and a corner handle (`tl`/`tr`/`bl`/`br`)
  is active, after computing the raw `nw`/`nh` from the drag delta, rescale
  whichever of `nw`/`nh` changed *less* to match the aspect ratio of
  `initialRectPos.w / initialRectPos.h`, keeping the *opposite* corner fixed
  (that's the anchor point implied by which handle is being dragged) — same
  formula for all four corners, just with the sign flips already present in
  the existing `tl`/`tr`/`bl`/`br` branches.
- **Explicitly does NOT need to touch the touch-pinch gesture** (Section
  1.3's `selectionGesture` in `documentCanvas.ts`): pinch already scales `nw`
  and `nh` by the *same* `scale` factor derived from finger distance, so it's
  uniform-scaling by construction — already "1:1 ratio preserving" without
  any change. Don't add redundant logic there.
- **Risk: Low.** Isolated, well-defined, the exact hook point already exists
  from Session 3's local-space delta math.

### 6.3 Other popular tools — candidate menu, not scoped work
Documented for prioritization later, per the user's "other tools from very
popular programs" ask — **do not build speculatively**, pick from this list
only when asked for a specific one:
- **Magic Wand / Automatic select** (Photoshop, ibis Paint, Procreate's
  "Automatic" mode): click a point, flood-fill outward over a color-tolerance
  threshold to build an irregular mask. Cheap to add once 6.1 lands — same
  "mask → `destination-in` → `tempCanvas`" plumbing as the lasso. Must use a
  stack-based (not recursive) scanline flood fill over `getImageData` to
  avoid a stack overflow / perf cliff on a 2048×2048 canvas. Needs a
  Tolerance slider.
- **Gradient tool:** drag a line, fill with `createLinearGradient`/
  `createRadialGradient` between two colors. Should respect Alpha Lock the
  same way brush painting does.
- **Shape tool** (rectangle/ellipse/line; Shift = perfect square/circle, same
  convention as 6.2): vector-drawn-then-rasterized primitive shapes, present
  in Photoshop and Clip Studio Paint.
- **Smudge tool:** grouped with brushes — see Section 7.2.
- **Transform / Perspective / Warp** (Photoshop, Clip Studio Paint, ibis
  Paint's "Transform" tool): free transform applied to a whole layer, not
  just a marquee'd selection. Largely a generalization of `SelectionManager`'s
  existing rotate/scale rig to operate on a whole layer without requiring a
  cut first.
- **Text tool:** `ctx.fillText`/font rendering onto a layer; needs a font
  picker and an in-canvas text-entry overlay.
- **Symmetry / Mirror drawing** (Procreate's Drawing Guide symmetry, ibis
  Paint's mirror mode): mirrors every dab across a user-placed axis live
  during a stroke. Would hook into `HighPerformanceBrushStroke`'s per-dab
  stamping loop in `brushEngine.ts`, stamping one or more extra mirrored dabs
  per real dab.
- **Ruler / perspective / grid guides** (Procreate's Drawing Guides): snaps
  or constrains stroke direction rather than drawing directly — a different
  kind of feature from everything else on this list (an input-shaping guide,
  not a drawing tool). **Straight + circular variants DONE — Session 16.**
  Perspective/grid/radial-symmetry variants remain unbuilt future scope.
- **Bucket/Fill (paint bucket):** contiguous flood fill from a clicked seed
  pixel. **DONE — Session 16** (`src/engine/floodFill.ts`). Shares its
  scanline-flood-fill core with what a future Magic Wand selection tool
  would need (see the bullet above) — that tool would reuse the same
  algorithm to build a mask instead of writing pixels directly.

---

## 7. New brushes (ibis Paint as reference)
**[PLANNING ONLY — Session 6. Nothing below is implemented.]**

Confirmed ibis Paint's actual tool/brush set via research: separate Brush,
Eraser, Smudge, and **Blur** tools, plus brushes grouped into categories (Ink,
Sketch, Watercolor, Outline) with pattern types (Mono/Water/Double/Color).

### 7.1 Blur brush
**[DONE — Session 7. See Alpha Log.]**
- ibis Paint's Blur tool softens/homogenizes pixels under the stroke — used
  for smooth transitions between colors/shapes already on the canvas.
- **Implementation sketch:** per dab, sample a small alpha-weighted
  neighborhood average of the pixels currently under the dab radius — this
  is **exactly** what `sampleAreaColor()` (added in Session 4 for Color Mix,
  in `brushEngine.ts`) already computes. A blur dab is essentially "paint
  `sampleAreaColor()`'s result back at this same position," repeated with
  high spacing/overlap so repeated strokes over an area progressively
  homogenize it. Cheap to prototype from existing code — this is the most
  reuse-heavy item in the whole plan.
- **Must read from the pre-stroke snapshot (`this.preCtx`), not the live
  layer**, for the same reason Color Mix does (established in Sessions 3-4):
  reading the live layer mid-stroke would pick up this same stroke's own
  already-blurred pixels and feed back on itself.
- Should still flow through the existing Flow/Opacity pipeline (Session 3's
  `recomposite()`) so Opacity caps blur strength per stroke like every other
  brush, rather than being a special case.
- **Risk: Moderate** — new read-modify-write brush behavior, but built almost
  entirely from an existing helper function.

### 7.2 Smudge brush
**[REBUILT AGAIN — Session 14, 2026-07-20: replaced the throttled-stamp +
carried-patch mechanism (below) with continuous backward-sampling and no
throttle, after the user correctly identified the Session 12 design as
still a stamp loop underneath its per-pixel-lerp implementation — see the
Session 14 Alpha Log entry for the full diagnosis and verification. The
notes below (Session 12) are kept for the parts still true: no canvas
composite stacking, dab geometry fixed per stroke, `recomposite()`'s
dedicated branch.]**
**[REBUILT — Session 12, 2026-07-20, after Session 11 deleted the tool
entirely at the user's request. Sessions 7-10 had repeatedly hit artifacts
traceable to stacking Canvas 2D composite operations (destination-out/
source-over layering) — a light centerline, an infinite "soliton" trail,
8-bit rounding stalls — each taking a full session to even understand.
Session 12 kept the underlying algorithm Session 10 had validated by
direct measurement (live self-referential surface, masked-lerp deposit,
partial-blend recapture, throttled dab spacing) but replaced canvas
compositing with explicit per-pixel `ImageData`/`Float32Array` math — one
auditable numeric lerp per pixel, no composite-mode stacking, and the
carried patch stays in float precision across the whole stroke instead of
round-tripping through 8-bit canvas storage every dab. See the Session 12
Alpha Log entry for the full design and live verification (strength-
tunable transport, no centerline inversion, 0 chromatic anomalies, a real
UI-driven drag test). Known limitation: dab geometry is fixed per stroke
(taper/pressure modulate strength, not size) — a deliberate trade for
removing a whole class of resampling artifact. The notes below are the
original Session 7 planning writeup, kept for historical reference.]**
- **Classic algorithm, confirmed via research:** on stroke start, capture a
  small patch of the canvas under the pointer. On each subsequent move, stamp
  that carried patch at the new position (opacity scaled by a strength/
  pressure parameter), then re-capture a fresh patch at the new position for
  the next step — paint is progressively dragged/smeared along the path
  rather than newly deposited.
- **Implementation sketch:** maps onto the existing per-dab stamping loop in
  `brushEngine.ts` — instead of `paintDab` stamping the cached flat-color
  radial-gradient stamp, a smudge dab stamps a captured canvas patch masked
  to the same soft radial falloff (reuse the stamp-alpha-gradient technique
  as a clip/mask instead of a flat fill color).
- Needs: a new `BrushSettings` field (e.g. `smudgeStrength: number`,
  analogous to `colorMix`), and a new small pooled per-stroke "carried patch"
  scratch canvas — follow the exact `preStroke`/`wetBuffer` pooling pattern
  from Sessions 2-3's Flow rework (allocate once, resize in place, reuse
  across strokes) rather than allocating fresh per stroke.
- **Same feedback-loop discipline as everything else in this file:** sample
  the *pre-stroke* snapshot at the start of each step, before that step's own
  smudge paints, or it'll smear its own just-smudged pixels within one stroke.
- **Risk: Moderate** — a third stateful per-stroke scratch buffer, but the
  pooling pattern to copy is already proven out twice in this codebase.

### 7.3 Other ibis Paint brush categories — lower priority, for awareness
- Most of ibis Paint's brush *categories* (Ink, Sketch, Watercolor, Outline)
  are really just different presets of parameters Flowdy's engine **already
  exposes** (size/hardness/opacity/taper/colorMix/`brushStyle`) — see
  `editorStore.ts`'s existing `BRUSH_PRESETS` (4 presets today: Fade
  Watercolor, Blurring Marker, Round Brush, Felt Tip Pen). Not new engine
  capability, just more presets. Worth revisiting once 7.1/7.2 land and there
  are real blur/smudge parameters to build a proper watercolor-bleed-style
  preset around (ibis Paint explicitly calls out "Watercolor (Bleed)" +
  "Blur" as its recommended pairing for soft transitions).

---

## 8. Clipping layers (clipping masks)
**[DONE — Session 7. See Alpha Log.]**

- **User's ask, confirmed via research to be Procreate/Photoshop's
  "Clipping Mask":** a layer clips to the *shape and alpha* of the layer
  immediately below it (the nearest non-clipped layer beneath it in the
  stack). Anything painted/placed on a clipped layer is only visible where
  the base layer already has opaque pixels. It's non-destructive and
  re-evaluates live if the base layer's content changes later.
- **Why this must NOT reuse Session 4's Alpha Lock code path, even though
  they sound similar:** Alpha Lock (`HighPerformanceBrushStroke.recomposite()`'s
  `source-atop` branch) clips a layer's *own painting* to its *own* existing
  alpha — a **paint-time** constraint baked into pixels as you paint. A
  clipping mask clips a layer's *rendering* to a **different** layer's alpha,
  and must stay correct for content already painted before the clip was
  turned on, for whole-layer opacity/blend-mode results, and for non-paint
  content like an imported image (Section 8 pairs naturally with Session 5's
  image import). This has to be a rendering-time mechanism, not a paint-time
  one — do not try to implement it as another `recomposite()` composite-
  operation branch.
- **Implementation approach — Pixi-native masking, not canvas-2D clipping:**
  `DocumentCanvas` already renders each layer as a Pixi `Sprite` in
  `layerRoot` (see `syncLayers()`). Pixi supports one sprite acting as a mask
  for other display objects natively (`someSprite.mask = otherSprite`) — this
  is the right primitive to reach for, not a canvas 2D clip path.
  1. Add `clippedToLayerBelow?: boolean` to `LayerMeta`
     (`layerStore.ts`) — same "optional, default false, old saves
     unaffected" pattern as Session 4's `alphaLocked`/`opacity`/`blendMode`.
     Add a `toggleClipping(id)` action alongside `toggleAlphaLock`.
  2. In `DocumentCanvas.syncLayers()`, after rebuilding stacking order, walk
     the layer list and for each run of consecutive `clippedToLayerBelow`
     layers sitting on top of a non-clipped "base" layer, set
     `rt.sprite.mask = baseRt.sprite` for every clipped layer in that run
     (one base sprite can mask multiple maskees at once, no texture
     duplication needed). For a clipped layer with no non-clipped layer
     beneath it (moved to the very bottom of the stack, or its base got
     deleted), set `rt.sprite.mask = null` — this must fall out naturally
     from `syncLayers()` re-running on every layer-list change, matching
     Procreate's documented "clip silently deactivates" behavior, including
     the explicit edge case of the bottom-most layer in the whole document
     having clipping turned on with nothing below it to clip to.
  3. **UI** (`LayerPanel.tsx`): a clip-toggle button in the existing "⚙
     Properties" panel (alongside Session 4's Alpha Lock/Duplicate row).
     Procreate additionally shows a visual indent + small corner-arrow glyph
     directly on clipped layer rows in the main list (not just inside the
     expanded panel) so the parent/clipped relationship reads at a glance —
     worth matching, since it's the kind of detail that makes a layers UI
     feel legible rather than just functional.
- **Persistence:** flows through the exact same save/load path as
  opacity/blendMode/alphaLocked (Session 4) — `LayerMeta` fields are
  structural-cloned into IndexedDB as-is, no `db.ts` schema change needed.
- **Risk: Moderate.** Unlike every other per-layer property added so far
  (opacity/blend/alpha-lock, each self-contained to its own layer), this one's
  correctness depends on *neighboring* layers and must be re-evaluated
  whenever the layer list reorders, adds, or deletes — not just when its own
  metadata changes. Hand-test explicitly: clip layer moved to the bottom of
  the stack, base layer deleted out from under a clipped layer, base layer's
  own opacity/blend-mode changed while something is clipped to it.

---

## 9. UI professional remake
**[PLANNING ONLY — Session 6. Nothing below is implemented.]**

Directly continues Session 3's explicitly-deferred "full shared-Button-
component + corner-radius/padding/shadow consistency pass" (see Section 4c
above) — the user is now asking for exactly that, plus more. Researched two
angles: what generically reads as "AI-generated"/generic in tool UIs, and
what actual professional creative-tool UIs (Procreate, Photoshop) do
differently.

### 9.1 Replace emoji-as-icons with a real icon set — single highest-leverage fix
**[DONE — Session 7. See Alpha Log.]**
- **Concrete finding (grepped, not assumed):** `package.json` has no icon
  library installed at all. Every icon in the app — 🖌 Brush, 🧹 Eraser, ⬚
  Select, 💾 Save Artwork, ⬇ Export, ↩ Undo, Redo ↪, ⚙️ Settings, 🖼 Gallery,
  🖼 Import Image, 🔒 Alpha Lock, ⧉ Duplicate, ⇧/⇩ merge icons, and more,
  across `TopBar.tsx`, `Toolbox.tsx`, `LayerPanel.tsx`, `App.tsx` — is a raw
  platform emoji character. This is arguably the single biggest "doesn't
  look professional" tell in the app: real creative-tool UIs (Procreate,
  Photoshop, Figma, Krita) use a consistent monoline/outline SVG icon set,
  never platform emoji, which also render inconsistently per OS/browser (an
  actual correctness problem, not just a style one).
- **Recommendation:** add [`lucide-react`](https://lucide.dev) — MIT-licensed,
  tree-shakeable, ~1500 consistent-stroke-width outline icons, the de-facto
  default pick for Tailwind/React apps. Do a full sweep replacing every
  emoji-as-icon usage with the matching Lucide icon: `Brush`, `Eraser`,
  `Square`/`MousePointer` (Select), `Save`, `Download`, `Undo2`, `Redo2`,
  `Settings`, `Image` (Gallery/Import), `Lock` (Alpha Lock), `Copy`
  (Duplicate), `ChevronUp`/`ChevronDown` (merge/move). Leave genuinely
  decorative/expressive emoji alone if any exist as real content, not UI
  chrome — there probably aren't any such cases in this app, everything
  found was chrome.
- Alternative considered: Phosphor Icons — also excellent, slightly larger
  bundle, more icon weights/variants. Lucide is the more common default and
  simpler to wire up (one import per icon, no theming config needed).

### 9.2 Design tokens / consistency system (the work Session 3 deferred)
**[DONE — Session 7. See Alpha Log.]**
- Finish the audit Session 3 explicitly left open: converge every button
  across `App.tsx`, `TopBar.tsx`, `LayerPanel.tsx`, `ToolPalette.tsx`,
  `ExportModal.tsx`, `NewCanvasModal.tsx`, `Toolbox.tsx`, `ColorPicker.tsx` on
  one small set of variant recipes (primary/secondary/icon/danger — already
  sketched in Sessions 1 and 3's notes) as either a real shared `<Button>`
  component or a documented Tailwind class-constant map, then migrate every
  button to it. Same treatment for corner radius (pick one scale — e.g.
  `rounded-lg` for buttons/inputs, `rounded-xl`/`rounded-2xl` reserved for
  panels/modals only, not both used interchangeably for the same kind of
  element) and shadow usage (`shadow-sm` for resting panels, a stronger
  shadow reserved only for floating/modal elements).

### 9.3 Typography
**[DONE — Session 7. See Alpha Log.]**
- **Confirmed via grep: no custom font is configured anywhere** (`index.css`/
  `tailwind.config.js` have nothing beyond Tailwind's default stack). A real
  UI typeface is one of the highest-polish-per-effort changes available.
  Don't over-index on the "Inter is the AI slop font" critique found during
  research — that critique is specifically about *marketing pages* defaulting
  to Inter + purple-gradient + three-cards-in-a-row, not about Inter being a
  bad choice for a dense tool UI (it's still what Figma/Linear/etc. use).
  Reasonable options: Inter itself at slightly tighter tracking for UI/body
  text, optionally paired with something with more character for
  headings/branding (Manrope or Sora were the two that came up as good
  creative-tool-appropriate pairings). Load via `@fontsource` (self-hosted,
  no external request — matches this app's offline-friendly Tauri nature)
  rather than a Google Fonts `<link>`, and set it as Tailwind's
  `fontFamily.sans` default so it applies everywhere without per-component
  classes.

### 9.4 Depth, motion, and "canvas-first" chrome (Procreate-inspired)
**[DONE — Session 7. See Alpha Log.]**
- Research on Procreate's actual design philosophy: minimal, unobtrusive
  charcoal (never pure black) chrome, canvas takes visual priority over UI,
  features nested/progressively-disclosed rather than all exposed at once.
  Concrete, scoped suggestions for Flowdy building on work already done:
  - The Session 3 dark theme (neutral near-black, not pure black) is already
    on the right track — extend the same restraint to internal panel
    dividers, which currently use the same high-contrast `border-shell-border`
    for both the outer panel edge and internal separators. Consider a
    subtler treatment for internal-only dividers so the eye isn't drawn to
    grid lines instead of the artwork.
  - Continue the progressive-disclosure pattern Session 4's Properties
    expander already started (Merge Up/Down, Duplicate, Alpha Lock tucked
    behind a "⚙" toggle instead of always-visible) — apply the same idea to
    the Brush Settings drawer: Start/End Taper and Color Mix could live in a
    secondary "Advanced" sub-section, surfacing only Size/Opacity/Flow by
    default.
  - Add motion polish to state changes that currently snap instantly
    (Properties panel expand/collapse, drawer open/close) — a short
    (150-200ms) transition reads as noticeably more "designed" at very low
    cost. Animating to an unknown/`auto` height needs either a CSS grid
    `grid-template-rows: 0fr → 1fr` trick or a measured-height JS approach;
    plain `transition-all` won't animate `height: auto` directly.
- **Risk: Low-moderate overall.** Broad and touches many files, but each
  individual change is low-risk and independently shippable — don't treat
  this as one big-bang pass. Start with 9.1 (icons) — highest value, lowest
  risk, and the most obvious win of the whole section.

---

## 10. Bug fixes
**Do these first — the user's explicit instruction, and 10.1 blocks real use
of the Smudge tool.**

### 10.1 Smudge tool introduces color that isn't in the artwork
**[Superseded by the Session 12 rebuild — the tool this bug was filed
against (Session 10's canvas-composite-based version) no longer exists;
Session 11 deleted it and Session 12 rebuilt it on an explicit-pixel-math
architecture instead (see Section 7.2 and the Session 12 Alpha Log entry).
The red-tint symptom below has still never been reproduced in-engine
across 5 sessions now. Kept below as a record of what was tried across
Sessions 7-10 and why each canvas-composite attempt fell short, in case
the new architecture ever needs the same history.]
See the notes below and the
Alpha Log for full detail on each.]**

**Red-tint sub-issue — investigated again, still not reproduced.** Leading
hypothesis from Session 7 (stale RGB under near-zero alpha, revealed by
resampling) is now REFUTED by direct measurement, not just re-guessed. See
Alpha Log for the full Session 8 entry — three separate real-pointer-driven
tests (opaque shapes, transparent edges, and a deliberate multi-color
scenario) all came back completely clean at both the CPU canvas level and
the GPU-rendered level. Recommendation: stop hunting for an engine bug
without a fresh, concrete repro from the user (see "Next step" below) — do
not guess-fix.

**"Acts like a brush" sub-issue — FOUND AND FIXED, Session 8, then
FOLLOWED UP AND FIXED AGAIN same session after the first fix over-corrected
(user caught it immediately: "before it did all the things it had to, now
it just pushes a lighter color out of the darker one... we would be able
to smudge white into the black circle but that doesn't work").** The user showed a screenshot of real smudge use: a solid
black circle with additional black loops/trails that looked just as opaque
and flat as a plain brush stroke, not a fading drag. Root-caused by direct
pixel measurement (not guessed): dragged a smudge stroke away from a solid
black circle and sampled brightness at increasing distance — the trail
stayed **fully opaque black for ~90px**, then cut off to white within one
sample step, i.e. a flat plateau followed by a cliff, not a gradual fade.
Cause: dab spacing is ~5% of brush size, so a 100px brush stamps roughly 20
overlapping dabs at any point it passes over; each dab drew its content
onto `wetCtx` via plain `source-over` at `globalAlpha = strength`, and
repeated same-stroke `source-over` compositing over overlapping dabs
saturates to full opacity within a handful of dabs regardless of
`strength` (`1-(1-strength)^n → 1` fast) — so any touched area became
solid opaque almost immediately, no matter how diluted the actual carried
content was. **Fix** (`src/engine/brushEngine.ts`'s `stampSmudgeDab()`):
before drawing each dab's content, first punch that dab's own footprint out
of `wetCtx` (`destination-out` with the same soft mask, alpha 1), then draw
`source-over` at `globalAlpha = strength` as before. This makes each dab
*replace* rather than compound with earlier same-stroke dabs at that
position, so a spot's final opacity reflects the freshest dab's `strength`
directly instead of accumulated overlap count. **Verified live** with the
same reproduction: the ~90px solid plateau is gone (now only the source
shape's own real extent reads as solid, exactly as expected), and the
transition beyond the source now shows an actual gradient (178 → 182 → 220
→ 238 → 247 → 253 over ~20px) instead of a single-step cliff — a real,
substantial improvement, though not a mathematically perfect linear fade
(a residual ~10px secondary plateau remains right at the source edge,
likely an artifact of the captured patch's own soft-hardness edge being
faithfully reproduced for the first few post-source dabs — much less
severe than the original bug and not pursued further this session). Also
re-ran the exact multi-color, extreme-pressure/speed red-tint regression
test from earlier this session against the modified code — still zero
chromatic anomalies, confirming this fix didn't reintroduce or interact
with the (separate, unreproduced) red-tint issue. `npx tsc --noEmit`
clean, `npm test` 35/35 passing.

**Follow-up, same session — the first fix above over-corrected, caught by
the user immediately after trying it live, root-caused and fixed for
real.** The first fix's `destination-out` erase used the *full brush-sized*
mask at every dab. At typical dab spacing (~5% of brush size, so ~4-5px on
an 80-100px brush), that meant every single dab erased almost the *entire
trail* laid down by the last ~15-20 dabs before drawing its own content —
not just its own overlap with the immediately-prior dab. Net effect: no
real drag/smear, just a small moving patch of color that erased its own
history behind it as it moved — exactly the user's description ("pushes a
lighter color out of the darker one"). Directly confirmed by testing the
user's own suggested scenario: dragging a smudge stroke from white,
through the edge of, and deep into a black circle — sampled brightness at
6 points along the drag through the circle's interior and found it
**completely unchanged from pure black (r=1) everywhere inside**, i.e. zero
carry, not just a weak one. **Fix, in two parts, both needed:**
1. **`src/engine/brushEngine.ts`'s `stampSmudgeDab()`:** shrank the erase
   mask from the full dab size down to `effSize * 0.16` (roughly 3-4x the
   dab spacing — just enough overlap between consecutive dabs to still
   prevent the original same-spot saturation bug, without erasing dabs
   stamped further back along the path).
2. **`SMUDGE_PICKUP_RATE` constant, same file:** even with the erase-radius
   fix alone, the white-into-black test *still* showed zero carry — traced
   to a separate, pre-existing problem the first fix's erase step had
   merely *exposed* rather than caused: this rate (0.35) is applied at
   *every dab*, and dabs land every ~5% of brush size, so survival of the
   original carried content after traveling just one full brush-width is
   `0.65^20 ≈ 0.0002` — essentially zero, regardless of `Smudge Strength`.
   Before this session's erase-step fix, that fast per-dab dilution was
   invisible because overlapping dabs' alpha was *also* compounding in the
   shared wet buffer (the original saturation bug) — a lucky accident that
   made the drag look like it carried further than any single dab's own
   diluting content actually did. Once dab-overlap compounding was fixed,
   this rate alone determined visible carry distance, and it was simply
   too fast to ever show a meaningful drag. Reduced to `0.05` (survives
   ~36% after one brush-width, ~13% after two — tuned to read like a real
   smudge tool's drag instead of vanishing within the first couple of
   dabs).
- **Verified live**, with the exact same white-into-black reproduction:
  brightness now reads 248 → 44 → 16 → 16 → 16 → 16 → 24 across the same 6
  sample points (was flat 1 → 1 → 1 → 1 → 1 → 1 → 1) — a real, substantial,
  gradually-fading carry, not a step function. Re-ran the original
  "acts like a brush" plateau reproduction too, to confirm the *first*
  fix's win wasn't lost in the process: still a smooth gradual fade (0 → 1
  → 21 → 114 → 169 → 203 → 230 → 244, leveling off, not a plateau-then-
  cliff). Re-ran the multi-color chromatic regression test one more time —
  still zero anomalies. `npx tsc --noEmit` clean, `npm test` 35/35 passing.

- **Symptom (from the user's screenshot):** smudging with a black brush
  produces a strong, solid red-tinted region with no red anywhere in the
  visible artwork — not subtle noise, a real color shift.
- **Where to pick up:** `src/engine/brushEngine.ts`'s `stampSmudgeDab()` and
  `captureSmudgePatch()`. The leading hypothesis (see Alpha Log for the full
  reasoning) is that `captureSmudgePatch()`'s partial-blend recapture path
  (added this session to fix a *different* bug — the carried patch fading
  instantly instead of persisting) can leave stale, hidden RGB data under
  near-zero-alpha pixels, which then gets revealed as visible color when
  `stampSmudgeDab()`'s `drawImage` rescales the carried patch to fit a
  differently-sized dab (this happens whenever `effSize` varies with
  pressure/velocity/taper — something a real variable-speed pointer stroke
  does constantly and this session's synthetic constant-velocity
  reproduction attempt barely exercised).
- **First step, before writing any fix:** reproduce with *real* pointer-
  driven strokes (dispatched `PointerEvent`s with varying speed, or better,
  actually drawing with a mouse/tablet if that's available) rather than
  direct `down()`/`move()`/`flush()` calls with constant-velocity synthetic
  samples — this session's attempt used the latter and could not reproduce
  the bug after ~488 dabs, which may just mean the synthetic test didn't
  hit the right conditions, not that the bug doesn't exist.
- **Second step:** if reproduced, dump `HighPerformanceBrushStroke.
  carriedPatch`'s raw pixel data via `getImageData` mid-stroke (it's a
  private field but accessible at runtime via JS, same as other debugging
  this session did throughout) and check specifically for non-zero R/G/B
  at pixels where alpha is at or near 0. This would directly confirm or
  rule out the leading hypothesis before touching any code.
- **If confirmed:** the fix needs to either (a) explicitly zero color
  channels wherever alpha drops to 0 after the `destination-out` step —
  not achievable with pure canvas 2D compositing calls, would need a
  `getImageData`/`putImageData` pass (costly if done every dab — consider
  doing it only occasionally, or only on the final recapture of a stroke),
  or (b) stop blending the carried patch's own pixels for persistence
  entirely and track fade via a separate opacity multiplier that decays
  per-dab instead, leaving the patch's actual pixel data untouched by
  repeated partial composites. (b) is likely the more robust fix — it
  sidesteps the whole "does canvas compositing leave stale hidden data"
  question rather than trying to clean up after it.
- **Also worth checking, lower priority:** whether `stampSmudgeDab`'s
  `sctx.drawImage(this.carriedPatch, 0, 0, this.carriedPatch.width, this.
  carriedPatch.height, 0, 0, w, h)` — the rescale call — should have
  `imageSmoothingEnabled = false` set explicitly first, as a *diagnostic*
  (not a real fix — it would look pixelated). If disabling smoothing makes
  the color-bleed disappear, that's strong direct confirmation the bug is
  in image-resampling of bad source data, pointing squarely at the fix
  directions above rather than something else entirely.
- **Risk: Needs care.** This is the same stroke-hot-path code every other
  Smudge use goes through — verify any fix against a range of stroke
  speeds/sizes/durations (per this file's established pattern for brush-
  engine work), not just the one reported scenario.
- **Next step, since two sessions of code-level investigation have both come
  up empty:** get a concrete repro from the user — ideally the actual
  project file/save data that showed the red blob (not just the screenshot),
  or a fresh recording of the exact steps (which layer, what was on it
  already, brush size/hardness/smudge-strength, roughly how long/fast the
  stroke was). Session 7's Alpha Log already flagged that its own live-
  testing (Sections 7-9) painted many colored test patches directly onto the
  canvas via `ctx.fillRect` and never fully cleared them — if the user's
  report came from a session where that leftover test content was still on
  the canvas (even off-screen from the screenshot's crop, or hidden under
  another layer), the "red with no visible source" symptom would be
  completely explained by genuinely-correct smudge behavior dragging in
  real, pre-existing (just not visually obvious) red pixels — not a bug at
  all. Worth ruling this out explicitly with the user before spending a
  third session on synthetic repro attempts.

### 10.2 Collapsing a sidebar panel shrinks/animates the canvas
**[DONE — Session 7. Root-caused and fixed, verified live — see the Alpha
Log entry above for the full measurement trail.]**
- **Root cause:** `src/index.css` set `#root { height: 100% }` but never
  gave `html`/`body` an explicit height, so the percentage-height chain
  never actually anchored to the real viewport — it silently fell back to
  being sized by page content instead, which happened to coincidentally
  match the viewport under normal conditions but shrank the instant any
  content (e.g. a collapsed Drawer) got shorter.
- **Fix:** added `html, body { height: 100%; }` to `index.css`.
- Nothing further to do here — listed only so this section matches the
  user's original numbering.

---

## 11. Panel layout & professionalism rework
**[DONE — Session 8. User explicitly chose option 2 (overlay panels) when
asked. See Alpha Log for the full implementation + live verification.]**

User's framing: the current left/right sidebar structure (left: Brush
Settings + Color Picker drawers; right: Layers + Tools drawers, all via the
`Drawer` component in `App.tsx`) has *decent logic* for what goes where and
what does what — the ask is a presentation/organization rework, not a
re-architecture of what the panels do. Visual direction: **mimic/derive
from ibis Paint, but with much less transparency than ibis Paint actually
uses** — panels should read as solid/opaque/professional, not glassy.

- **Current structure to redesign from** (don't rediscover this by reading
  source — it's exactly this): `App.tsx`'s `Drawer` component wraps each of
  the 4 panels identically (icon + title header, chevron toggle, collapsible
  body via this session's new `Collapsible` — see `src/components/
  Collapsible.tsx`). Left `aside` (`w-64`): `ToolPalette.tsx` (brush preset
  dropdown + sliders) then `ColorPicker.tsx`. Right `aside` (`w-80`):
  `LayerPanel.tsx` then `Toolbox.tsx` (tool grid + Rectangle/Lasso sub-mode).
  `TopBar.tsx` currently holds only Gallery/Save/Export (left group), the
  "Flowdy" wordmark (center), and Undo/Redo (right group) — genuinely empty
  of any brush/color/layer context right now.
- **Concrete candidate for what moves to the top bar** (explicitly suggested
  by the user as an example, not mandatory): a compact current-brush
  preview/selector and a current-color swatch next to Undo/Redo, so the
  user's active tool/color state is visible *without* needing a sidebar open
  at all — this is exactly the pattern ibis Paint and Procreate use (a
  slim, always-visible status strip) rather than Flowdy's current
  everything-lives-in-a-tall-sidebar approach. If pursued: a small swatch
  button opening the Color Picker as an overlay/popover (anchored under the
  swatch) rather than requiring the whole left sidebar open, and similarly
  a brush-preview thumbnail (ties directly into Section 12's brush-preview
  work — same rendering path could serve both) opening Brush Settings the
  same way.
- **Bigger structural direction to weigh (flag as a decision point, not a
  mandate):** ibis Paint's actual layout doesn't use permanently-docked
  sidebars at all — it uses a slim always-visible toolbar plus panels that
  open as overlays/sheets on demand, maximizing canvas space (especially
  important on tablet, per the user's own touch-target ask in Section 14).
  Flowdy's current docked-sidebar model is more like classic desktop
  Photoshop. Two real options for the next session to choose between rather
  than defaulting silently:
  1. **Keep docked sidebars, reorganize/restyle their contents** — lower
     risk, smaller diff, still delivers a real visual upgrade. Compatible
     with also adding the top-bar quick-access swatch/brush-preview above
     as a *supplement*, not a replacement.
  2. **Move to on-demand overlay panels** (closer to ibis Paint's actual
     model) — bigger canvas area, more touch-friendly, but a real
     architecture change: `App.tsx`'s layout, `Drawer`'s open/close model,
     and how `CanvasStage`'s available space is computed would all need
     rework, and `documentEngineRef.current?.forceResize()` calls (already
     used for Focus Mode) would need to fire on panel-open/close instead of
     just Focus Mode toggling. Higher effort, but closer to what "mimic
     ibis Paint" literally means.
  Given the user described the *current logic* as already decent and asked
  for a presentation fix more than a re-architecture, option 1 is the
  safer default unless the user says otherwise when this is picked up —
  but don't assume that silently since option 2 is what "derive from ibis
  Paint" more literally implies; worth a quick check-in with the user
  before committing to one.
- **Opacity direction:** whatever layout is chosen, panels should be
  *solidly* opaque (`bg-shell-panel` at full alpha, as already used) — this
  is explicitly *not* asking for glass/blur panel backgrounds like ibis
  Paint itself uses; the user was specific that Flowdy should read as more
  solid/professional than ibis Paint's own translucent style.
- **Risk: Low for option 1, Moderate-High for option 2** (touches core
  layout/resize plumbing, not just visual styling).

---

## 12. Brush Settings panel
**[DONE (12.1 via Section 11's OverlayPanel inheritance, 12.2 with one new
real brush type as the plan itself scoped — "pick a couple to start" — and
12.3) — Session 8. See Alpha Log for implementation + live verification.]**

### 12.1 Visual redesign
- Restyle `ToolPalette.tsx` (and the `Drawer` wrapping it, per Section 11's
  outcome) to the same opaque, ibis-Paint-derived-but-more-solid direction
  as the rest of this UI pass — reuses Session 9's `Button`/design-token
  work, this is a continuation not a fresh system.
- **ibis Paint's actual brush-settings structure**, confirmed via research
  (https://ibispaint.com/lecture/index.jsp?no=118&lang=en): parameters are
  grouped into tabs — **Basic** (thickness/opacity), **Fade** (start/end
  shape, opacity, blur degree), **Shape** (brush pattern shape, spacing),
  **Jitter** (thickness/opacity/color/particle-density randomness),
  **Type** (brush type + texture), **Dynamic** (pressure/speed-driven
  thickness/opacity/blur changes). Flowdy's current panel is one flat
  scrolling list (now split into a default tier + Session 9's "Advanced"
  collapsible for Taper/Color-Mix) — consider adopting a similar *tabbed*
  grouping instead of one long list once there are more parameters to
  organize (this pairs naturally with Section 12.2 below, since new brush
  types will likely want their own type-specific parameters that don't
  make sense to show for every brush).

### 12.2 Brush type must be a distinct brush, not a parameter preset
**User's correction to current behavior, worth reading carefully:** picking
a different brush from the list should switch to an entirely different
*stroke algorithm/texture*, not just different parameter values layered on
the same underlying renderer.
- **Current reality, precisely (don't rediscover this by reading source):**
  `BrushStyle` (`src/engine/brushTypes.ts`) is `"round" | "pen" | "marker" |
  "blur" | "smudge"`. `getStamp()` (`src/engine/brushEngine.ts`) generates
  every non-blur/smudge stamp via the *same* single algorithm — a radial
  gradient (color → transparent) baked onto a small canvas — varying only
  `hardness` (where the gradient's inner opaque stop sits) and, for
  `"marker"` specifically, a rotate+squash transform and a `multiply` blend
  mode instead of `source-over`. So `"round"` and `"pen"` are *pixel-
  identical* algorithms today (the 4 existing presets in `editorStore.ts`'s
  `BRUSH_PRESETS` differ only in numeric parameter values, not rendering
  logic) — this is *exactly* the "preset, not a real different brush"
  behavior the user is flagging, and it's happening even before you get to
  the user-facing preset list. `"blur"` and `"smudge"` *are* already
  genuinely distinct algorithms (Session 7's work, see `stampBlurDab()`/
  `stampSmudgeDab()`) — proof the architecture already supports real
  per-style divergence, it's just underused for the paint-style brushes.
- **Existing extension point to build on, not replace:**
  `HighPerformanceBrushStroke.makeDabPainter()` already dispatches to a
  completely different per-dab rendering function based on `settings.
  brushStyle` (`stampBlurDab`/`stampSmudgeDab`/the default `paintDab`-based
  closure). Adding a genuinely different brush type means adding a new
  `BrushStyle` value and a new case in `makeDabPainter()` with its own dab-
  rendering function — the same pattern already proven twice. Concrete
  candidates for *actually* different algorithms (not exhaustive, pick a
  couple to start rather than attempting full ibis Paint parity in one
  pass):
  - **Textured/bristle brush:** instead of `getStamp()`'s flat radial
    gradient, pre-render a stamp from a noise/bristle texture (canvas-
    generated procedural noise, or a small baked texture asset) so the
    edge has irregular grain instead of a perfectly smooth falloff —
    closest to ibis Paint's "Type" tab texture options.
  - **True wet/watercolor brush:** partially exists already via Color
    Mix (`mixbox`-based pigment blending, `src/engine/brushEngine.ts`'s
    `move()`) — a real "Watercolor" brush type could just be a preset that
    forces high Color Mix + a soft stamp, *or*, to match the user's "must
    be a different implementation" ask more literally, a dab renderer that
    samples-and-blends more aggressively per-dab (closer to how `Blur`'s
    `stampBlurDab` reads the pre-stroke snapshot) rather than only mixing
    at the periodic Color-Mix sample points.
  - **Multi-stamp/scatter brush** (ibis Paint's particle-jitter-driven
    brushes): stamp several small offset dabs per step with randomized
    position/rotation instead of one dab — a real rendering-logic
    difference, not just a parameter tweak.
- **Risk: Moderate-High per new brush type.** Each genuinely-different
  algorithm is new rendering code on the hot stroke path — needs the same
  range-of-speeds/sizes live verification this file's engine work always
  requires. Scope to 1-2 new real brush types first rather than a whole
  ibis Paint-sized library in one pass.

### 12.3 Brush previews (thumbnails showing actual stroke texture)
- **What's needed:** each entry in the brush/preset picker
  (`ToolPalette.tsx`'s dropdown, currently plain text rows — see
  `BRUSH_PRESETS.map(...)`) needs a visible thumbnail of that brush's real
  stroke texture, not just a name — confirmed this is standard practice via
  research (ibis Paint has a dedicated brush-preview feature specifically
  so users can "test brushes before committing"). Stretch goal, called out
  by the user as "ideally": the preview updates live as Size/Hardness/
  Opacity sliders change, not just a static icon per brush.
  - **Concrete, buildable approach using code that already exists:** render
    a small offscreen canvas (e.g. 120×40px) per preset/brush-style by
    driving the *actual* stroke-rendering path — `paintDab`/`getStamp()`
    (or the relevant `stampXDab` for blur/smudge/future distinct brushes)
    — along a fixed short S-curve or wavy path, using that preset's real
    settings. This reuses the exact same rendering code the real canvas
    uses (so the preview is never misleading), not a separate hand-drawn
    icon per brush. Convert to a data URL (`canvas.toDataURL()`) or just
    keep it as a live `<canvas>` element in the picker row.
  - For the "live update as sliders change" stretch goal: debounce
    re-rendering the *currently selected* preview canvas on slider
    `onChange` (don't re-render all previews on every slider tick, only
    the active one) — cheap since it's a tiny fixed-size canvas, not the
    full artboard.
- **Risk: Low-Moderate.** Self-contained (a new small rendering utility +
  UI change to the preset list), doesn't touch the real stroke/paint
  pipeline at all, just calls into it read-only for preview generation.

---

## 13. Color Picker
**[DONE — Session 8. Used `@uiw/react-color-wheel` per the plan's own
recommended order (try the library first). See Alpha Log for the full
implementation + live verification, including a real interaction-library
gotcha found and worked around during testing.]**

- **ibis Paint's actual structure**, confirmed via research
  (https://ibispaint.com/lecture/index.jsp?no=11&lang=en): a **Color
  Circle** (hue ring) combined with an **HSB box** (saturation/brightness
  square) that you drag inside — plus, notably, ibis Paint *also* offers
  alternate shapes (square/triangle) and slider-based (HSV/RGB) views as
  user-selectable options, it doesn't force the wheel as the only way in.
  Matches the user's own description ("hue ring + saturation/value square
  or triangle").
- **Current `ColorPicker.tsx` to redesign from:** linear HSB sliders (H/S/B
  as three range inputs) + linear RGB sliders + a HEX input + an eyedropper
  button (real SVG icon already, not emoji) + a 12-swatch quick-pick grid.
  The user's ask is specifically to replace/lead with a wheel — **keep the
  HEX input, eyedropper, and swatches** (ibis Paint itself keeps
  slider/hex-equivalent fallbacks alongside its wheel, per the research
  above, and this file's own past sessions established these as working,
  non-broken pieces not worth discarding) — the linear HSB sliders are the
  piece most redundant with a new wheel and the most reasonable to drop or
  demote once the wheel exists; keep or drop the linear RGB sliders is a
  smaller judgment call, lower priority either way.
- **Decision point the user explicitly asked to be flagged rather than
  silently resolved: build custom vs. use an existing wheel component.**
  Researched both directions:
  - **Custom build** (SVG or canvas hue ring + saturation/value square):
    fits this app's generally dependency-light approach (no new runtime
    dependency), full control over styling to match the "opaque,
    professional" direction, but real effort — hue-ring geometry, drag
    interaction, and keeping it in sync with the existing `hexToRgb`/
    `rgbToHex`/`rgbToHsv`/`hsvToRgb` helpers already in `src/lib/color.ts`
    (reuse these, don't reimplement color math) is a non-trivial UI+math
    task on its own.
  - **`@uiw/react-color`'s `Wheel` component** — a real React component
    (not a vanilla-DOM widget needing a wrapper), small, part of a modular
    package where individual pickers can be installed separately. Likely
    the easiest integration into this app's existing React/Zustand/
    Tailwind stack.
  - **`iro.js`** — a more mature, actively-maintained, SVG-based HSV color
    picker widget with a longer track record and more configuration depth,
    but it's framework-agnostic (vanilla DOM), so React integration means
    wrapping it in a `useRef`/`useEffect`-managed DOM mount rather than
    using it as a natural JSX component — more integration friction than
    `@uiw/react-color`, but worth it if `@uiw/react-color`'s `Wheel` proves
    visually or functionally lacking once actually tried.
  - **Recommendation for whoever picks this up:** try `@uiw/react-color`'s
    `Wheel` first (lowest integration cost, confirm it looks acceptable
    restyled to match the app's palette/opacity direction), fall back to
    `iro.js` if it doesn't, and only reach for a full custom build if
    neither library's visual output can be made to fit — don't default
    straight to a custom build without trying the existing options first,
    per the user's own explicit framing ("fall back to the closest existing
    wheel-based color picker component" if custom is too costly).
- **Risk: Low-Moderate** if using a library (mostly integration + restyling
  work), **Moderate-High** if building custom (real interaction + geometry
  code, needs careful testing across mouse *and* touch drag, per Section
  14's touch-target requirement).

---

## 14. Overall layout & professionalism pass
**[DONE (touch-target audit; the rest was already satisfied by Sections
11-13's shared `OverlayPanel`/`Button` reuse, per this section's own
framing) — Session 8. See Alpha Log for details.]**

- **Consistent visual language across every panel** (spacing, corner
  radius, iconography, typography, color palette) — this is a direct
  continuation of Session 9's `Button`/`Collapsible`/design-token/
  typography work (Sections 9.1-9.4, all done), extended to cover whatever
  new surfaces Sections 11-13 introduce (a color wheel, brush preview
  thumbnails, any new top-bar controls, any new overlay/popover panels if
  Section 11's option 2 is chosen) so they land in the *same* system
  instead of becoming a fifth one-off style.
- **Touch-target sizing — concrete thing to audit, not just "make it
  touch-friendly" in the abstract:** `src/components/Button.tsx`'s
  `IconButton` currently renders at `p-1.5` (6px padding around a ~14-16px
  icon, roughly 26-28px total) — noticeably under the ~44×44px minimum
  touch target most mobile/tablet design guidelines (iOS HIG, Material
  Design) recommend. `LayerPanel.tsx`'s Up/Down/Properties/Delete row and
  the swatch grid in `ColorPicker.tsx` are the densest, most likely to be
  genuinely hard to hit precisely on a tablet — worth a real touch-target
  pass (larger hit areas even if the *visual* icon stays compact, e.g. via
  padding rather than just scaling the icon up) rather than assuming
  Session 9's icon sweep already solved this — it solved *legibility*, not
  *touch-target size*, which is a separate concern this file hadn't
  addressed yet.
- **Reduce visual clutter from always-visible controls** — mostly falls out
  of Section 11's reorganization (fewer always-expanded sidebar sections)
  and Section 9.4's progressive-disclosure pattern (Advanced sub-sections,
  Properties expanders) already established — extend that same instinct to
  whatever Section 11 lands on, rather than introducing a third clutter-
  reduction pattern.
- **Verify both input modes explicitly before calling this done:** mouse
  precision (hover states, cursor-based tools like the eyedropper and any
  new color wheel drag) *and* touch (tablet-sized hit targets, drag
  gestures that don't fight with the canvas's own pinch/pan/rotate
  handling established in Section 1.3's touch-gesture work) — this file's
  own past sessions found real touch/mouse divergences before (e.g.
  Session 3's gesture-redirection work), don't assume one input mode's
  testing covers the other.
- **Risk: Low-Moderate overall**, broad but each piece independently
  shippable — same framing as Session 6's original UI-pass risk note.
