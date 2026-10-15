# DEXPI Schema Files

This folder contains XML schema files from the **DEXPI (Data Exchange in the Process Industry)** specification, version 2.0.

## Files

- **DEXPI_XML_Schema.xsd** - Official DEXPI 2.0 XML Schema (serialization grammar)
- **Core.xml** - DEXPI 2.0 Core model (shared foundation: physical quantities, diagram primitives, …)
- **Process.xml** - DEXPI 2.0 Process model (block flow / process flow diagrams)
- **Plant.xml** - DEXPI 2.0 Plant model (piping & instrumentation diagrams); loaded by `--validate` so P&ID documents check against their own vocabulary

All four files are unmodified copies of the official DEXPI Specification 2.0.0 build artifacts (the same files published under `https://data.dexpi.org/models/2.0.0/`), byte-identical to the specification repository's CI output.

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

The bpmn2dexpi exports reference these models. The exported DEXPI XML files import them via:

```xml
<Import prefix="Core" source="https://data.dexpi.org/models/2.0.0/Core.xml"/>
<Import prefix="Process" source="https://data.dexpi.org/models/2.0.0/Process.xml"/>
```

`--validate` additionally resolves documents that import the Plant model:

```xml
<Import prefix="Plant" source="https://data.dexpi.org/models/2.0.0/Plant.xml"/>
```
