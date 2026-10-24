# DEXPI Schema Files

This folder contains XML schema files from the **DEXPI (Data Exchange in the Process Industry)** specification, releases 2.0.0 and 2.0.1.

## Files

- **DEXPI_XML_Schema.xsd** - Official DEXPI 2.0 XML Schema (serialization grammar). Shared by both releases: the file in the 2.0.1 sources (`src/documentation/_static/DEXPI_XML_Schema.xsd` at tag `V2.0.1` of the specification repository) is byte-identical to the 2.0.0 one (SHA-256 `0bd6568b…36e6`), so one schema validates documents of either release.
- **Core.xml** - DEXPI 2.0.0 Core model (shared foundation: physical quantities, diagram primitives, …)
- **Process.xml** - DEXPI 2.0.0 Process model (block flow / process flow diagrams)
- **Plant.xml** - DEXPI 2.0.0 Plant model (piping & instrumentation diagrams); loaded by `--validate` so P&ID documents check against their own vocabulary
- **2.0.1/Core.xml**, **2.0.1/Process.xml**, **2.0.1/Plant.xml** - the same three models of DEXPI Specification 2.0.1 (30 September 2026, the bugfix release replacing 2.0.0), as served at `https://dexpi.org/specification/2.0.1/xml/` (the `data.dexpi.org/models/2.0.1/` URIs the files declare for themselves do not resolve at the time of writing). Loaded when the target version is 2.0.1, and by `--validate` for documents that import the 2.0.1 models.

The 2.0.0 files are unmodified copies of the official DEXPI Specification 2.0.0 build artifacts (the same files published under `https://data.dexpi.org/models/2.0.0/`), byte-identical to the specification repository's CI output; the 2.0.1 files are unmodified copies of the 2.0.1 build artifacts. The 2.0.0 files stay at the folder root because every loader addresses them there; each later release gets a subfolder named after it (see `src/transformer/dexpiVersions.ts`).

### What changed in 2.0.1

From the [2.0.1 changelog](https://dexpi.org/specification/2.0.1/html/appendix/changelog.html), as confirmed by diffing the model files. Core: the `PercentageUnit` enumeration is renamed `RatioUnit` and gains `Fraction`, `PartsPerThousand`, `PartsPerMillion`, `PartsPerBillion` next to `Percent`. Process: `Composition.MoleFractiona` is renamed `MoleFractions`; the `CompositionBasis` enumeration is removed; `ProcessModel.Compositions` and `ProcessModel.MaterialStateTypes` are removed, `MaterialStateType.Composition` becomes a composition (0..1), and `MaterialState.State` and `MaterialState.Phases` (renamed from `Phase`) become compositions; `MeasuringProcessVariable.MeasuredVariable` becomes a data property typed `Undefined | MeasuredQuantity`; `InstrumentationActivity.InformationPorts` and `ProcessStepDetail.Ports` are added; `StoringEnergy.Capacity` is renamed `ChargeCapacity`; new classes `SupplyingEnergy`, `SupplyingMaterial`, `TransportingEnergy`, `TransportingMaterial`, `TransportingMechanicalEnergy`, `TransportingThermalEnergy`, `StoringMechanicalEnergy`, `SelectingProcessVariable` (with the `SelectorType` enumeration) and `PortNodePosition`, with `SupplyingElectricalEnergy`, `SupplyingMechanicalEnergy`, `SupplyingFluids`, `SupplyingSolids`, `TransportingElectricalEnergy`, `TransportingFluids`, `TransportingSolids` re-parented under them (their `Flow` / `Capacity` properties now inherited) and `SeparatingByFlash` re-parented under `SeparatingByThermalProcess`. Plant: `ProcessSafetyFunction` added, `Heater.TubeBundle` moved up from `ElectricHeater`, piping connection opposite multiplicities relaxed. No class is removed in either model.

### Draft, not used by the tool

- **DEXPI_XML_Schema_1.1.0_RC_1.xsd** - Draft DEXPI XML Schema 1.1.0 (release candidate 1), circulated for review with the *Profiles for DEXPI* working draft. Kept here for reference only; validation continues to use the 2.0.0 schema above.

Relative to 2.0.0 the draft is a pure superset — nothing is removed or changed, and three things are added:

| Addition | Where |
|---|---|
| `names` simple type | new |
| `MetaElementReferenceProperty` complex type | new; added to the `ConcreteClass` and `AbstractClass` content models |
| `MetaElementReferences` complex type | new; added to the `Object` content model |

These carry the profile machinery: properties whose values are modeling elements rather than data, which the proposed `Core.Constraints` classes and the Process Type Library `Templates` link build on.

As circulated, the RC does not compile as an XSD. Two defects, both reproducible with `xmllint --noout --schema`:

1. The `MetaElementReferenceProperty` complex type contains a stray `<xsd:element>` declaration inside its body, which the XSD content model for `complexType` forbids. The element is already declared in the `ConcreteClass` and `AbstractClass` content models, so the line is redundant as well as invalid.
2. `MetaElementReferences/@metaElements` is typed `nameOrNameReferences`, a simple type the schema never defines (the DOCTYPE entity subset has no plural "name or name reference" pattern either).

With both patched locally the schema compiles, and both this project's Tennessee Eastman export and the official DEXPI 2.0.1 beta 2 `Process.xml` validate against it.

## License

These schema files are part of the DEXPI specification, licensed under the **Creative Commons Attribution 4.0 International License (CC BY 4.0)**.

- Specification: https://dexpi.gitlab.io/-/Specification
- Specification sources: https://gitlab.com/dexpi/Specification
- License: https://creativecommons.org/licenses/by/4.0/

## Usage

The bpmn2dexpi exports reference these models. The exported DEXPI XML files import them by the URIs the model files declare for themselves (`Model/@uri`), so a 2.0.0 export imports

```xml
<Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
<Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
```

and a 2.0.1 export the same paths under `models/2.0.1/`. `--validate` reads the release from those imports and loads the matching files; it additionally resolves documents that import the Plant model:

```xml
<Import prefix="Plant" source="https://data.dexpi.org/models/2.0.0/Plant.xml"/>
```
