# Paper changes for the canonical-`QualifiedValue` fix — *canonical everywhere*

**Scope of this branch (`cc/dexpi-canonical-qualifiedvalue`):** the DEXPI 2.0
information-model-canonical `QualifiedValue` shape is used **everywhere** — both
in the emitted DEXPI XML **and** inside the BPMN `extensionElements` that the
editor authors. A unit-bearing value is carried as a nested
`AggregatedDataValue` of type `Core/PhysicalQuantities.PhysicalQuantity`
(scalars) or `…PhysicalQuantityVector` (fraction vectors); units are resolved
**schema-side** to real enumeration literals and emitted as `DataReference`s;
the homegrown `UnitReference` Data child is gone (D6).

> **Bottom line.** Section 5 (Results and Findings) needs **no changes** — every
> validation claim still holds (re-verified against the live implementation).
> The required edits are confined to the two **code Listings** and **one
> sentence in the methodology (Section 3)**, because — unlike the
> flat-`extensionElements` alternative — this branch makes the *authoring*
> shape canonical too, so the listings that print `extensionElements` now show
> the nested carrier. Concretely: (1) restructure Listings 1 and 2 to the nested
> form, (2) two unit-token edits inside them, and (3) one methodology sentence.
> (`MoleFlow` needs **no** edit — it stays `11.2 KilomolePerHour` as printed and
> fails closed, since DEXPI has no per-hour molar-flow unit.) Details below.

---

## 0. If you can make NO further edits (camera-ready locked)

The implementation is still **faithful to every prose claim** — the only places
the branch and the paper disagree are the *literal XML in the two listings*
(structure + two unit tokens) and *one methodology sentence*. None of the
**Results**, the five-dimension framing, the tables, or the figures are
affected. If the listings cannot be edited, the paper remains **correct in all
its findings**; the listings would simply show the flat carrier shape while the
shipped code emits the (equivalent, richer) nested shape. That is a
presentational mismatch in two code blocks, not a factual error in the paper.

If you *can* make minor edits after reviewer feedback, apply Sections 1–3 below.

---

## 1. Required edits — the two code Listings

The listings print a BPMN `extensionElements` fragment. In the flat shape a
measurement was:

```xml
<dexpi:components property="MassFlow">
  <dexpi:object type="Core/QualifiedValue">
    <dexpi:data property="Value">48015.4</dexpi:data>
    <dexpi:data property="Unit">KilogramPerHour</dexpi:data>
  </dexpi:object>
</dexpi:components>
```

In the canonical (information-model) shape it becomes — the Unit and Value move
**inside** a `PhysicalQuantity` `AggregatedDataValue` under the QualifiedValue's
`Value`:

```xml
<dexpi:components property="MassFlow">
  <dexpi:object type="Core/QualifiedValue">
    <dexpi:data property="Value">
      <dexpi:aggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantity">
        <dexpi:data property="Unit">KilogramPerHour</dexpi:data>
        <dexpi:data property="Value">48015.4</dexpi:data>
      </dexpi:aggregatedDataValue>
    </dexpi:data>
  </dexpi:object>
</dexpi:components>
```

This is the same transformation everywhere a `Value`+`Unit` appears.

### Listing 1 (Section 4 — the Process Stream)

Apply **two** changes:

1. **Restructure** each `<dexpi:components>` measurement (e.g. `MassFlow`,
   `Temperature`) to the nested form shown above.
2. **Unit token:** the Temperature unit `degC` matches no `TemperatureUnit`
   literal / `un_symbol` / `un_code`, so it cannot resolve. Change it to the
   canonical literal **`DegreeCelsius`** (which now lives inside the nested
   `PhysicalQuantity`'s `Unit`). `MassFlow`'s `KilogramPerHour` already matches
   `MassFlowRateUnit.KilogramPerHour` — token unchanged, only nested.

### Listing 2 (Appendix — the MaterialState → Composition + MoleFlow)

Apply **three** changes:

1. **Restructure** the fraction vector to the nested **`PhysicalQuantityVector`**
   form — the `Unit` and the per-component `Values` move inside an
   `<dexpi:aggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantityVector">`
   under the QualifiedValue's `Value`:

   ```xml
   <dexpi:components property="MoleFractiona">
     <dexpi:object type="Core/QualifiedValue">
       <dexpi:data property="Value">
         <dexpi:aggregatedDataValue type="Core/PhysicalQuantities.PhysicalQuantityVector">
           <dexpi:data property="Unit">Percent</dexpi:data>
           <dexpi:data property="Values">0.99990</dexpi:data>
           <dexpi:data property="Values">0.00010</dexpi:data>
           <!-- … remaining components, values unchanged (still 0–1) … -->
         </dexpi:aggregatedDataValue>
       </dexpi:data>
     </dexpi:object>
   </dexpi:components>
   ```

2. **Unit token:** the fraction unit `Fraction` matches no `PercentageUnit`
   literal (its only literal is `Percent`). Change the **`Unit`** to **`Percent`**.
   - **Do NOT change** the Composition's free-text basis label
     `<dexpi:data property="Display">Fraction</dexpi:data>` — that stays
     `Fraction`. The 8 fraction **values stay exactly as printed** (0.99990,
     0.00010, …); only the unit token moves and the carrier nests.

3. **`MoleFlow` — keep `KilomolePerHour`; it fails closed.** The fixture stays
   **faithful to the paper**: `MoleFlow` is carried in **`KilomolePerHour`** with
   the value **`11.2`** unchanged (nested in a `PhysicalQuantity`). DEXPI's
   `MoleFlowRateUnit`, however, has **only per-second literals**
   (`KilomolePerSecond`, `PoundMolePerSecond`) — there is **no** per-hour
   molar-flow unit anywhere in DEXPI. `MaterialStateType.MoleFlow` also has no
   unit binding (it is a project/profile extension — Process.xml declares no
   molar-flow property), so the implementation tries a **global** search across
   the `PhysicalQuantities` unit enumerations; `KilomolePerHour` matches nothing.

   Rather than invent a literal or silently rescale the data, the emitter **fails
   closed**: the value `11.2` survives as a bare `<Double>` (the `Double` arm of
   `QualifiedValue.Type`) with **no `<DataReference>` unit**, and a warning is
   logged. So Listing 2 needs **no MoleFlow edit at all** — `11.2 KilomolePerHour`
   is reproduced verbatim; only the carrier nests like the other measurements.

   > Why fail-closed (and not rescale to per-second, nor mint a profile unit):
   > rescaling `÷ 3600` to `KilomolePerSecond` would alter the paper's printed
   > datum, and minting a profile per-hour unit would leave the standard
   > vocabulary. Failing closed keeps the **data** exactly as published and is
   > honest about DEXPI's genuine vocabulary gap — fully consistent with
   > Section 5's statement that `MaterialStateType` has "no molar-flow
   > counterpart": the gap is real not only at the **property** level but at the
   > **unit** level too, and the output says so (bare value + warning) instead of
   > papering over it.

---

## 2. Methodology (Section 3) — one sentence

The flat-carrier description of `extensionElements` needs to acknowledge the
information-model nesting. Wherever Section 3 says the `extensionElements`
"reuse the carrier shape defined by the DEXPI 2.0 XML Schema" (or equivalent),
extend it to note that **unit-bearing quantities are carried in the DEXPI 2.0
information-model form** — the numeric value and its unit nested in a
`PhysicalQuantity` / `PhysicalQuantityVector` `AggregatedDataValue`, with the
unit as a `DataReference` to a `PhysicalQuantities` enumeration literal. Suggested
addition:

> "Measurement properties reuse the DEXPI 2.0 `QualifiedValue` carrier: the
> numeric value and its unit are nested in a `PhysicalQuantity` (or
> `PhysicalQuantityVector`) `AggregatedDataValue`, and the unit is a
> `DataReference` to the corresponding `PhysicalQuantities` enumeration literal
> rather than a free-text string."

No other methodology change is required; Table 3 (the property/carrier mapping)
is unaffected because it maps *property names to carriers*, not the internal
value shape.

---

## 3. Section 5 (Results and Findings) — verified, NO changes needed

Re-ran the five-dimension fidelity check on the regenerated TEP output; each
Section 5 claim still holds.

| Section 5 statement | Status after the fix |
| --- | --- |
| "validated successfully against the official DEXPI 2.0 XML Schema" | ✅ still validates |
| "data-type, reference-target-class, and class-existence dimensions reported no findings" | ✅ all three still **0**. *Stronger now*: the data-type dimension also resolves every enum `DataReference` target against the imported enumerations (D9) — all resolve, so still 0. |
| "remaining two surfaced findings … two categories" | ✅ unchanged: (1) vocabulary gaps (incl. `MoleFlow` **as a property**, instrumentation `Level`/`MassFlow`/`RotationalFrequency`), (2) `Method`. |
| Category-1 examples (no molar-flow *property*; instrumentation variables not declared on the connected class) | ✅ still exactly these gaps |
| Category-2 (`Method`, resolved via the panel's schema-populated enum dropdown) | ✅ unchanged; the same picker now also backs **unit** selection |
| "ran the extension generator … closed all findings" | ✅ close-the-loop still passes (full suite green) |

**The five-dimension framing is preserved.** The enum-`DataReference`-target
check (D9) was folded **into the existing "data type" dimension** (which R1-C2
already defines as validating values against "built-in primitives or enumeration
literals"), not added as a sixth dimension. So "five model-level conditions
(property name and kind, data type, reference target class, cardinality, and
class existence)" stays exactly correct.

### Optional strengthening (not required)
> "Enumeration-typed values, including those carried as `DataReference`s, are
> resolved against the declared enumeration in the imported model, so a
> reference to a non-existent enumeration or literal is rejected rather than
> silently accepted."

---

## 4. What does NOT change (reassurance)

- **Section 5 prose, the five-dimension count/names, Table 3, and all figures** —
  unchanged. The parameter/enumeration table
  (`Provenance: Calculated, Estimated, Observed, Set, Specified`) and the
  `<PortDirection Inlet/>` figure show the *correct* DEXPI enums, which the
  corrected exporter now emits (`Core/DataTypes.QuantityProvenance.*`,
  `Process/Enumerations.PortDirection.{Inlet,Outlet}`). Before the fix the *code*
  contradicted these figures; now it agrees.
- **No new validation levels** were introduced — D9 lives inside the existing
  data-type dimension.

---

## Resubmission checklist

- [ ] Listing 1: restructure measurements to nested `PhysicalQuantity`; `degC` → `DegreeCelsius`.
- [ ] Listing 2: restructure fraction vector to nested `PhysicalQuantityVector`; `Fraction` → `Percent` (leave `Display`=`Fraction`, 8 values unchanged).
- [ ] Listing 2: `MoleFlow` — **no value/unit edit**; keep `11.2 KilomolePerHour` (nested `PhysicalQuantity`). It fails closed to a bare `Double` + warning (DEXPI has no per-hour molar-flow unit).
- [ ] Section 3: one sentence noting the `PhysicalQuantity(Vector)` nesting + unit `DataReference`.
- [ ] (optional) one sentence strengthening the data-type/enumeration-reference validation claim.
- [ ] No edits to Section 5 prose, the five-dimension framing, Table 3, or the figures.
