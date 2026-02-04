# DEXPI Schema Files

This folder contains XML schema files from the **DEXPI (Data Exchange in the Process Industry)** specification.

## Files

- **Core.xml** - DEXPI Core schema definitions
- **Process.xml** - DEXPI Process schema definitions

## License

These schema files are part of the DEXPI specification, licensed under the **Creative Commons Attribution 4.0 International License (CC BY 4.0)**.

- Specification: https://dexpi.gitlab.io/-/Specification
- License: https://creativecommons.org/licenses/by/4.0/

## Usage

The DEXPI Process Tool exports reference these schemas. The exported DEXPI XML files import them via:

```xml
<Import uid="..." Alias="Core" Namespace="http://sandbox.dexpi.org/rdl/Core"/>
<Import uid="..." Alias="Process" Namespace="http://sandbox.dexpi.org/rdl/Process"/>
```
