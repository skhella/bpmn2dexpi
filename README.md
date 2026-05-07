<img src="./src/assets/noncropped_logo.png" alt="BPMN2DEXPI Logo" width="400" />

A web-based tool for modeling chemical processes in BPMN 2.0 and exporting to DEXPI 2.0–compliant block flow and process flow diagrams, validated against the official DEXPI XML Schema.

## Features

- **Visual modeling** — drag-and-drop BPMN 2.0 editor with a DEXPI-aware palette
- **DEXPI 2.0 export** — XSD-validated output, with a structural fallback in browser contexts
- **Material library** — materials, compositions, and thermodynamic states
- **Typed ports & streams** — Material / Energy / Information, with flow rates, compositions, and qualified parameters
- **CLI tool** — batch-convert BPMN to DEXPI 2.0 XML from the terminal or Python
- **Neo4j export** — push process graphs directly to a Neo4j graph database

## Prerequisites

- **Node.js** 18+ (recommended: 20 LTS)
- **npm** 9+
- **xmllint** (for XSD validation in Node/CLI — `libxml2-utils` on Linux, `brew install libxml2` on macOS). Browser contexts use a structural fallback.

## Quick Start

```bash
git clone https://github.com/skhella/bpmn2dexpi.git
cd bpmn2dexpi
npm install
npm run dev        # web app at http://localhost:5173
```

## CLI

```bash
npm run transform input.bpmn output.xml

# or install globally
npm install -g bpmn2dexpi
bpmn2dexpi input.bpmn output.xml
```

## Python

```python
from bpmn2dexpi import transform

transform('input.bpmn', 'output.xml')   # save to file
xml = transform('input.bpmn')           # get as string
```

See [CLI_USAGE.md](./CLI_USAGE.md) for more.

## Web Interface

Open `http://localhost:5173`, drag elements from the palette, connect with typed flows, configure ports and stream properties in the side panel, and export to DEXPI 2.0 XML or Neo4j.

<img src="./examples/Web-Interface-Screenshot.png" alt="Web Interface Screenshot" width="90%" />

## Architecture

The transformer is a standalone, framework-independent TypeScript module — usable independently of the React frontend:

```
src/transformer/
├── BpmnToDexpiTransformer.ts      # Core BPMN → DEXPI 2.0 transformation
├── DexpiProcessClassRegistry.ts   # Loads Process.xml → authoritative class list
├── DexpiOutputValidator.ts        # XSD validation (xmllint) + structural fallback
├── TransformerLogger.ts           # Warning/error collection
├── types.ts                       # Typed interfaces
└── __tests__/                     # automated tests

dexpi-schema-files/
├── DEXPI_XML_Schema.xsd           # Official DEXPI 2.0 XML Schema
└── Process.xml                    # DEXPI 2.0 Process model (replace to update)
```

## Validation

DEXPI 2.0 is intentionally permissive: any output conforming to the official XSD is exchangeable. The tool offers two validation paths:

- **XSD validation** (always on) — output validates against the bundled `DEXPI_XML_Schema.xsd` via xmllint in Node/CLI, or a structural fallback in the browser. Property names are treated as opaque strings.
- **Strict information-model fidelity** (opt-in) — additionally checks every `Data` / `Components` / `References` `property=` attribute against the wrapping class's declared properties in `Process.xml` + `Core.xml` (walking supertypes), and verifies the carrier element matches the declared kind (data / reference / composition).

Strict-mode findings never block file production. They surface as warnings (UI / console) or a non-zero CLI exit code, but the deliverable always lands on disk.

Enable strict mode via the **Strict** checkbox in the export dialog, the `--strict` CLI flag, or `{ strict: true }` on `transformer.transform()`.

## Extension mechanisms

Two complementary ways to handle process content beyond the core DEXPI 2.0 vocabulary:

**Profiles** — declare project-specific classes or property extensions in a Profile XML using DEXPI's metamodel grammar. Loaded Profiles populate the type dropdown and are recognized under strict-mode validation. A reference Profile lives in `examples/profiles/sample-extension.xml`; the TEP-derived `examples/profiles/tep-generated.xml` shows a worked example.

**External URI references** — process steps not covered by DEXPI can reference external ontologies (ISO 15926, OntoCAPE, company RDLs) via a `customUri` annotation.

### Loading and generating Profiles

- **UI** — *Import Profile* loads an XML file; *Generate Profile* walks the current model and emits a Profile XML that closes any strict-mode gaps.
- **CLI** — `--profile FILE` (repeatable) loads Profiles; `--generate-profile FILE` writes a Profile derived from the input model.
- **Library API** — pass `profileXmls: [{ name, xml }]` to `transformer.transform()`.

The generator is deterministic (alphabetical output, no timestamps — safe to commit) and uses conservative type defaults.

Profiles are runtime-only — they live for the current CLI process or browser session and are not persisted.

The Profile-level `mode="extend"` marker and its merge-on-conflict semantics are bpmn2dexpi-specific — they follow the conceptual extensibility approach DEXPI 2.0 is being designed for, but the precise idiom is not yet standardized. Generated Profiles may need migration when DEXPI publishes its canonical Profile mechanism.

## Testing

```bash
npm test              # run the test suite
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```

Unit tests (transformer, registry, validation) plus an end-to-end integration benchmark using the Tennessee Eastman PFD. CI runs on Node.js 18 / 20 / 22 via GitHub Actions.

## Based on Research

This tool implements the representation methodology described in:

> Shady Khella, Markus Schichtel, Erik Esche, Frauke Weichhardt, and Jens-Uwe Repke. *Representing DEXPI Process in BPMN 2.0 for Graphical Modeling and Exchange of Block Flow and Process Flow Diagrams* (under review, Digital Chemical Engineering, 2026).

## Technology

React 19, TypeScript, [bpmn.io](https://bpmn.io/) (bpmn-js), Vite 7, Vitest. Schema: [DEXPI 2.0](https://dexpi.gitlab.io/-/Specification).

## License

MIT — see [LICENSE](./LICENSE).

bpmn-js is licensed under the bpmn.io License (modified MIT). The bpmn.io watermark must remain visible and unmodified.

DEXPI Specification is licensed under CC BY 4.0.

---

v0.1.0
