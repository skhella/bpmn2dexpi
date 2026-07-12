# DEXPI Schema Files

This folder contains XML schema files from the **DEXPI (Data Exchange in the Process Industry)** specification, version 2.0.

## Files

- **DEXPI_XML_Schema.xsd** - Official DEXPI 2.0 XML Schema (serialization grammar)
- **Core.xml** - DEXPI 2.0 Core model (shared foundation: physical quantities, diagram primitives, …)
- **Process.xml** - DEXPI 2.0 Process model (block flow / process flow diagrams)
- **Plant.xml** - DEXPI 2.0 Plant model (piping & instrumentation diagrams); loaded by `--validate` so P&ID documents check against their own vocabulary

All four files are unmodified copies of the official DEXPI Specification 2.0.0 build artifacts (the same files published under `https://data.dexpi.org/models/2.0.0/`), byte-identical to the specification repository's CI output.

## License

These schema files are part of the DEXPI specification, licensed under the **Creative Commons Attribution 4.0 International License (CC BY 4.0)**.

- Specification: https://dexpi.gitlab.io/-/Specification
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
