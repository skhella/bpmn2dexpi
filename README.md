<img src="./src/assets/noncropped_logo.png" alt="BPMN2DEXPI Logo" width="400" />

A web-based tool for modeling chemical processes in BPMN 2.0 and exporting to DEXPI 2.0–compliant block flow and process flow diagrams, validated against the official DEXPI XML Schema.

## Features

- **Visual modeling** — drag-and-drop BPMN 2.0 editor with a DEXPI-aware palette
- **DEXPI 2.0 export** — XSD-validated output, with a structural fallback in browser contexts
- **Strict-mode fidelity check** — five-dimensional validation against the DEXPI 2.0 information model: property names and kinds, data types, reference targets, cardinality, and class existence
- **Profile-based extensibility** — declare custom classes or property extensions in a Profile XML, or auto-generate a Profile from any model to close vocabulary gaps
- **Material library** — materials, compositions, and thermodynamic states
- **Typed ports & streams** — Material / Energy / Information, with flow rates, compositions, and qualified parameters
- **Instrumentation variables on ProcessStep** — measured / controlled variables author canonically on the connected ProcessStep (DEXPI 2.0 spec p.900); a dedicated panel on connected `DataObject`s offers a property dropdown sourced from the connected step's class
- **CLI tool** — batch-convert BPMN to DEXPI 2.0 XML from the terminal or Python
- **Neo4j export** — push process graphs directly to a Neo4j graph database

## Prerequisites

- **Node.js** 20 LTS or newer (jsdom 29 requires Node 20+)
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

Open `http://localhost:5173`, drag elements from the palette, connect with typed flows, configure ports and stream properties in the side panel, edit instrumentation variables on connected `DataObject`s, and export to DEXPI 2.0 XML or Neo4j.

<img src="./examples/Web-Interface-Screenshot.png" alt="Web Interface Screenshot" width="90%" />

## Architecture

The transformer is a standalone, framework-independent TypeScript module — usable independently of the React frontend:

```
src/transformer/
├── BpmnToDexpiTransformer.ts        # Core BPMN → DEXPI 2.0 transformation
├── DexpiProcessClassRegistry.ts     # Loads the DEXPI schemas + any Profiles
├── DexpiOutputValidator.ts          # XSD validation + structural fallback
├── DexpiPropertyNameValidator.ts    # Strict-mode fidelity checks
├── DexpiDataTypeValidator.ts        #   (property names, data types,
├── DexpiReferenceValidator.ts       #    reference targets, cardinality,
├── DexpiCardinalityValidator.ts     #    class existence)
├── DexpiClassExistenceValidator.ts  #
├── DexpiProfileGenerator.ts         # Generates a Profile XML closing strict gaps
├── TransformerLogger.ts
├── types.ts
└── __tests__/

dexpi-schema-files/
├── DEXPI_XML_Schema.xsd             # Official DEXPI 2.0 XML Schema
├── Process.xml                      # DEXPI 2.0 Process model
└── Core.xml                         # DEXPI 2.0 Core model
```

## Validation

Every export is checked against the official DEXPI 2.0 XML Schema, so the file you get is always exchangeable with other DEXPI tools.

Turn on **Strict mode** (export dialog checkbox, `--strict` CLI flag, or `{ strict: true }` on `transformer.transform()`) for deeper fidelity checks: property names, data types, reference targets, required-property cardinality, and class existence. Strict mode never blocks the export — it produces a summary dialog (or CLI output) listing what doesn't match the schema, so you can fix it in the panel or capture it in a generated Profile.

## Extension mechanisms

Two complementary ways to handle process content beyond the core DEXPI 2.0 vocabulary:

**Profiles** — declare project-specific classes or property extensions in a Profile XML using DEXPI's metamodel grammar. Loaded Profiles populate the type dropdown and are recognized under strict-mode validation. A reference Profile lives in `examples/profiles/sample-extension.xml`; the TEP-derived `examples/profiles/tep-generated.xml` shows a worked example.

### Loading and generating Profiles

- **UI** — *Import Profile* loads an XML file; *Generate Profile* walks the current model and emits a Profile XML that closes any strict-mode gaps.
- **CLI** — `--profile FILE` (repeatable) loads Profiles; `--generate-profile FILE` writes a Profile derived from the input model.
- **Library API** — pass `profileXmls: [{ name, xml }]` to `transformer.transform()`.

The generator is deterministic (alphabetical, no timestamps — safe to commit) and infers types and bounds from the actual model so the Profile is precise rather than permissive. To make authoring less guesswork, the properties panel auto-shows the attributes a class needs (e.g. `Method` on a Compressor) as empty rows ready to fill in, and a **Required in generated Profile** checkbox lets you tag project-specific attributes so they're enforced on reload.

Profiles are runtime-only — they live for the current CLI process or browser session and are not persisted.

Profiles are loaded with uniform-merge semantics: same-name class declarations merge additively into the active vocabulary (kind, supertypes, and existing properties preserved; new properties from the Profile appended). The registry records a non-blocking warning per merge so callers can surface unintended collisions (e.g. a hand-authored Profile typoing a standard class name).

This follows the conceptual extensibility approach DEXPI 2.0 is being designed for, but the precise idiom is not yet standardized. Generated Profiles may need migration when DEXPI publishes its canonical Profile mechanism.

## Testing

```bash
npm test              # run the test suite
npm run test:watch    # watch mode
npm run test:coverage # with coverage
```

Unit tests (transformer, registry, validation) plus an end-to-end integration benchmark using the Tennessee Eastman PFD. CI runs on Node.js 20 / 22 / 24 via GitHub Actions.

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

v0.2.1
