<img src="./src/assets/noncropped_logo.png" alt="BPMN2DEXPI Logo" width="400" />

A web-based tool for modeling chemical processes in BPMN 2.0 and exporting to DEXPI 2.0–compliant block flow and process flow diagrams, validated against the official DEXPI XML Schema.

## Features

- Visual BPMN 2.0 editor with a DEXPI-aware palette
- DEXPI 2.0 XML export, XSD-validated (`xmllint` in Node/CLI; structural fallback in browser)
- Strict-mode fidelity check across five tiers: property names, data types, reference targets, cardinality, class existence
- Profile-based extensibility for custom classes or properties beyond the standard vocabulary
- Material library, typed ports & streams, canonical instrumentation variables on `ProcessStep` (DEXPI 2.0 spec p.900)
- CLI for batch BPMN → DEXPI XML conversion, with an optional Python wrapper
- Neo4j graph export

## Prerequisites

- Node.js 20 LTS or newer
- npm 9+
- `xmllint` for XSD validation in Node/CLI — `libxml2-utils` on Linux, `brew install libxml2` on macOS (browsers use a structural fallback automatically)

## Quick Start

```bash
git clone https://github.com/skhella/bpmn2dexpi.git
cd bpmn2dexpi
npm install
npm run dev        # web app at http://localhost:5173
```

<img src="./examples/Web-Interface-Screenshot.png" alt="Web Interface Screenshot" width="90%" />

## CLI

```bash
npm run transform input.bpmn output.xml
# or install globally
npm install -g bpmn2dexpi && bpmn2dexpi input.bpmn output.xml
```

See [CLI_USAGE.md](./CLI_USAGE.md) for `--strict`, `--profile`, `--generate-profile`, and the Python wrapper.

## Profiles

A Profile is an XML file declaring classes or properties beyond the DEXPI 2.0 standard vocabulary (`Process.xml` + `Core.xml`). Loaded Profiles populate the type dropdown and are accepted by strict-mode validation. Profiles live per-session — re-import to apply.

- **Import** — UI: *Import Profile* in the DEXPI menu. CLI: `--profile FILE` (repeatable). Library: `profileXmls` option on `transformer.transform()`. Same-name class redeclarations merge additively into the active vocabulary with a non-blocking warning; divergent supertypes or property kinds throw with a named-source diagnostic.
- **Generate** — walk the current model and emit a Profile XML that closes every fidelity gap. UI: *Generate Profile*. CLI: `--generate-profile FILE`. Output is deterministic (alphabetical, no timestamps) — safe to commit.

Reference Profiles: `examples/profiles/sample-extension.xml` (hand-authored), `examples/profiles/tep-generated.xml` (TEP-derived). The canonical Profile idiom is not yet standardized in DEXPI; generated Profiles may need migration once it is.

## Based on Research

> Shady Khella, Markus Schichtel, Erik Esche, Frauke Weichhardt, and Jens-Uwe Repke. *Representing DEXPI Process in BPMN 2.0 for Graphical Modeling and Exchange of Block Flow and Process Flow Diagrams* (under review, Digital Chemical Engineering, 2026).

## License

MIT — see [LICENSE](./LICENSE).

bpmn-js is licensed under the bpmn.io License (modified MIT). The bpmn.io watermark must remain visible and unmodified. DEXPI Specification is licensed under CC BY 4.0.

---

v0.2.1
