# Overnight Work — Status & Evaluation Guide

**Date:** May 7, 2026
**Branch state at start:** `main` at `b855ec4` (post-Phase-4 + CI fixes + TEP fixture replacement). `feature/dexpi-to-bpmn-import` at `b9d31e3`, 80 commits ahead of main, 31 behind.

This document summarises what landed during your overnight session and how to evaluate each piece tomorrow. Order is roughly priority for review — top items are most actionable.

> Main was not edited. All work landed on new branches off main.

---

## 1. ELK Layout Engine — `feature/elk-layout-engine`

**Status:** Working prototype + sample relayouts ready for visual review.

**What's there:**
- `src/layout/ElkBpmnLayout.ts` — ELK.js wrapper. Takes a typed graph (nodes / edges / ports) with subprocess hierarchy, returns absolute coordinates for every shape and waypoint. Supports `INCLUDE_CHILDREN` (subprocesses laid out inside parents, parent sized to fit), `FIXED_SIDE` port constraints (Inlet=WEST, Outlet=EAST), orthogonal edge routing, and L→R direction.
- `src/layout/BpmnFileRelayout.ts` — BPMN-XML adapter. Parses a `bpmn:definitions` document, extracts the node/edge graph, runs ELK, writes back a fresh `bpmndi:BPMNDiagram` block. Logical content is preserved verbatim.
- `scripts/relayout-bpmn.mjs` — CLI entrypoint.
- `examples/Tennessee_Eastman_Process_ELK.bpmn` — TEP fixture relayed out by ELK. **Open this side-by-side with `examples/Tennessee_Eastman_Process.bpmn`** in Camunda Web Modeler / SemTalk to compare layouts.

**How to run yourself:**
```bash
npm run relayout examples/Tennessee_Eastman_Process.bpmn /tmp/tep_elk.bpmn
```

**Performance:** ~480ms on the full TEP fixture (192 KB BPMN, ~85 nodes, ~150 edges).

**Test coverage:** 4 smoke tests in `src/layout/__tests__/ElkBpmnLayout.test.ts` covering L→R flow, hierarchical containment, port-side constraints, and end-to-end relayout-of-TEP.

**Known limitations:**
- Port-side constraints only apply when edges provide directional context. Isolated nodes default to one side.
- Default spacing values (60/100/30/20px) tuned for PFD-density; tighter or looser may be desirable depending on diagram size.

**What to evaluate:**
1. **Visual quality.** Open both BPMN files in Camunda. Does ELK produce a more readable PFD than your current import-branch routing?
2. **Subprocess sizing.** Look at `Activity_07878z5` (ReactingChemicals). ELK sizes it 806×1360 to fit children. Is that right for your diagram?
3. **Edge routing.** ELK uses orthogonal routing — is that what you want, or should I switch to the alternative `POLYLINE` style?
4. **Port positioning.** Inlets land on WEST, outlets on EAST. Inspect a few tasks in Camunda — are the port placements visually correct?

If the verdict is "good", we plug ELK into the importer (the `feature/dexpi-to-bpmn-import-rebased` branch already has the glue — see §3 below).

---

## 2. Data-Type Validator — `feature/dexpi-datatype-validation`

**Status:** Tier-3 validator complete with 14 passing tests. 104 total tests pass on this branch.

**What's there:**
- Registry now parses `<Enumeration>` declarations (62 enums from Process.xml + Core.xml).
- `src/transformer/DexpiDataTypeValidator.ts` — validates every `<Data property="X">value</Data>` against the wrapping class's declared targetType:
  - **Builtin types:** Boolean, Integer, Double, UnsignedByte, DateTime, AnyURI, String, Undefined
  - **Enumerations:** value must be one of the declared literals
  - **Class refs / DataTypes:** out of scope (skip)
  - **QualifiedValue's Value/Values/Unit:** mapped explicitly to Double/Double/String (Core.xml's UnionDataType is too loose to be useful)

**What this catches that existing validators don't:**
- Typoed enum literals (e.g. `Provenance="Estimted"`)
- Non-numeric values where Double is expected
- Out-of-range UnsignedByte values
- Malformed DateTime / AnyURI strings

**Regression check:** TEP emission has zero data-type violations.

**What's intentionally out of scope (future work):**
- Reference target-class compliance (whether `<References objects="#X"/>` points at an object whose class matches the declared targetType)
- Cardinality (lower/upper) — usually XSD-detectable already

**What to evaluate:**
1. Whether the validator's scope is the right slice (Builtin + Enum + skip-others) or whether you want target-class checking too.
2. Whether the strict mode should now run all three tiers (XSD + property-name+kind + data-type) by default in CI, or stay opt-in.

**To merge:** clean cherry-pick onto main. No conflicts (this branch has only additions).

---

## 3. Importer Rebased + ELK Pipeline — `feature/dexpi-to-bpmn-import-rebased`

**Status:** Importer compiles + tests pass on Phase-4 main. ELK layout pipeline integrated. End-to-end round-trip works.

**What's there:**
- `src/transformer/DexpiToBpmnTransformer.ts` (cherry-picked from `feature/dexpi-to-bpmn-import`)
- `src/transformer/__tests__/DexpiToBpmnTransformer.test.ts`
- `src/layout/*` (the ELK module from §1)
- `src/transformer/DexpiImportWithElk.ts` — glue module. Importer produces BPMN with its own heuristic layout, then ELK overrides the layout. The glue exposes `importDexpiWithElk(dexpiXml, { skipElk: false })`.
- `scripts/import-dexpi.mjs` — CLI: `npm run import-dexpi <in.dexpi.xml> <out.bpmn> [--skip-elk]`
- `examples/round-trip/TEP_roundtrip_with_ELK.bpmn` — round-trip BPMN→DEXPI→BPMN(ELK)
- `examples/round-trip/TEP_roundtrip_native_layout.bpmn` — same round-trip, but with `--skip-elk` (preserves the importer's heuristic layout)

**125 tests pass** on this branch.

**Performance:**
- Importer alone: ~460ms
- Importer + ELK relayout: ~900ms (additional ~440ms for the layout pass)

**What's NOT included from the original `feature/dexpi-to-bpmn-import` branch (deferred):**
- App.tsx UI integration (Import-DEXPI button, file picker, etc.)
- 79 intermediate import-branch commits (port-routing fixes, obstacle-aware routing, layout heuristics, etc.). Each of those was developed against pre-Phase-4 main, so they need re-evaluation in light of the ELK-based layout. **Many of those routing fixes may be obsolete if ELK takes over edge routing.**

**What to evaluate:**
1. **Round-trip layout quality.** Open `examples/round-trip/TEP_roundtrip_with_ELK.bpmn` and `examples/round-trip/TEP_roundtrip_native_layout.bpmn` in Camunda side-by-side. Which layout produces a more readable PFD?
2. **Logical-content preservation.** Both files should have identical `dexpi:` extensionElements (only the BPMNDiagram differs). If you spot any logical differences, that's a transformer bug, not a layout issue.
3. **Whether to keep the importer's heuristic layout as a fallback.** If ELK is reliably better, the `--skip-elk` flag becomes a debug-only escape hatch.

**To get full UI integration:** add an "Import DEXPI" button to App.tsx that calls `importDexpiWithElk()`. The original import branch had this; cherry-picking it onto this rebased branch will conflict on App.tsx but the conflict will be smaller than the full 80-commit merge attempt.

---

## 4. Original Import Branch — `feature/dexpi-to-bpmn-import` (untouched)

**Status:** Preserved on remote at `b9d31e3`. Not merged, not deleted.

**Why I didn't merge it directly into main:**
- 80 commits ahead of main, 31 behind. Multiple files (`App.tsx`, `dexpi.json`, `BpmnToDexpiTransformer.ts`) had structurally-different edits on both sides. The `App.tsx` conflict alone spanned 218 lines and required manual reconstruction of UI integration code.
- I tried two approaches: a straight `git merge main` (aborted after assessing scope) and a fresh-branch cherry-pick (also conflicted on App.tsx).
- The chosen path (§3) gets the substantive importer code onto Phase-4 main without dragging in the 79 intermediate commits, most of which are ad-hoc layout fixes likely obsoleted by ELK adoption.

**What you can do with it:**
- Keep it for archaeology / reference (recommended)
- If you want any specific intermediate fix from those 79 commits, cherry-pick the specific commit onto `feature/dexpi-to-bpmn-import-rebased`
- Delete once the rebased branch covers everything you need

---

## Summary of Branches & Commits

| Branch | Status | Most-recent commit | Tests passing |
|---|---|---|---|
| `main` | Untouched (per instruction) | `b855ec4` | 90/90 |
| `feature/elk-layout-engine` | New | `a7a829c` | 94/94 (90 + 4 ELK) |
| `feature/dexpi-datatype-validation` | New | `03f209b` | 104/104 (90 + 14 datatype) |
| `feature/dexpi-to-bpmn-import-rebased` | New | `b72ea19` | 125/125 (94 + 31 importer) |
| `feature/dexpi-to-bpmn-import` | Untouched (preserved for archaeology) | `b9d31e3` | 91/91 (its own pre-Phase-4 suite) |

---

## Recommended Order for Tomorrow

1. **Open the round-trip files in Camunda Web Modeler / SemTalk first** (they're checked into the rebased branch under `examples/round-trip/`). This is the most concrete signal of whether the layout work is going in the right direction.
2. If ELK looks good, evaluate the standalone `examples/Tennessee_Eastman_Process_ELK.bpmn` on `feature/elk-layout-engine` to confirm it works on the original-layout fixture too.
3. Decide whether to merge `feature/dexpi-datatype-validation` first (small, low-risk, additive) or `feature/dexpi-to-bpmn-import-rebased` first (larger, includes ELK + importer).
4. Either branch can be cherry-picked independently or in sequence onto main with minimal conflicts (both branched cleanly from main).

---

## Open Questions / Things I Couldn't Decide Without You

- **Layout-engine spacing values.** I picked DEFAULT_LAYOUT_OPTIONS (`elk.spacing.nodeNode=60`, etc.) based on PFD-density intuition. You may want denser or looser. Easy to tune in `src/layout/ElkBpmnLayout.ts`.
- **Port-side constraint fallback.** With FIXED_SIDE, ELK respects sides only when edges provide direction. Isolated nodes default both sides to WEST. Could switch to `FIXED_POS` for fully-deterministic placement; let me know if you want that.
- **Strict-mode CI gate.** Currently the property-name + kind validator runs as a CI gate against TEP. Should the new data-type validator join that gate, or stay opt-in?
- **Importer integration.** The `feature/dexpi-to-bpmn-import-rebased` branch is ready to merge into main but lacks the App.tsx import button. You can either (a) add the button manually after merge, or (b) we do another cycle to port the original import-branch's button on top.
