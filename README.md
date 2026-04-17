<img src="./src/assets/noncropped_logo.png" alt="BPMN2DEXPI Logo" width="400" />

A web-based tool for creating DEXPI 2.0-compliant block flow and process flow diagrams. Model chemical processes visually using BPMN 2.0 and export to DEXPI 2.0 XML — validated against the official DEXPI XML Schema.

## Features

- **Visual Modeling**: Drag-and-drop BPMN 2.0 editor with DEXPI-aware palette
- **DEXPI 2.0 Export**: XSD-validated output against the official DEXPI XML Schema
- **Material Library**: Define materials, compositions, and thermodynamic states
- **Port System**: Typed ports (Material, Energy, Information) with hierarchy support
- **Stream Properties**: Flow rates, compositions, and qualified parameters (Scope, Range, Provenance)
- **CLI Tool**: Batch convert BPMN files to DEXPI 2.0 XML from terminal or Python
- **Neo4j Export**: Export process graphs directly to a Neo4j graph database

## Prerequisites

- **Node.js** 18+ (recommended: 20 LTS)
- **npm** 9+
- **xmllint** (for XSD validation in CLI/test mode — available via `libxml2-utils` on Linux, `brew install libxml2` on macOS)

## Quick Start

### Option A: Clone and run (web interface + CLI)

```bash
git clone https://github.com/skhella/bpmn2dexpi.git
cd bpmn2dexpi
npm install

# Run the web app
npm run dev

# Or use CLI for batch processing
npm run transform input.bpmn output.xml
```

### Option B: Install via npm (CLI only)

```bash
npm install -g bpmn2dexpi

# Convert BPMN to DEXPI 2.0 XML
bpmn2dexpi input.bpmn output.xml
```

## Usage

### Web Interface

1. Open `http://localhost:5173` in your browser
2. Drag process elements from the palette (ProcessStep types, Sources, Sinks)
3. Connect elements with typed flows (Material, Energy, Information)
4. Define materials and compositions in the Material Library panel
5. Configure ports and stream properties in the properties panel
6. Export to DEXPI 2.0 XML or Neo4j

<img src="./examples/Web-Interface-Screenshot.png" alt="Web Interface Screenshot" width="90%" />

### Command Line

```bash
# If using cloned repo
npm run transform process.bpmn output.xml

# If installed globally via npm
bpmn2dexpi process.bpmn output.xml
```

### Python Integration

The included `bpmn2dexpi.py` script wraps the CLI for use from Python:

```python
from bpmn2dexpi import transform

# Convert and save to file
transform('input.bpmn', 'output.xml')

# Get XML as string
xml = transform('input.bpmn')
```

See [CLI_USAGE.md](./CLI_USAGE.md) for more examples.

### Neo4j Export

The tool can export process diagrams directly to a Neo4j graph database:

1. Click the **"Export to Neo4j"** button in the toolbar
2. Enter your Neo4j connection details:
   - **Local**: `bolt://localhost:7687`
   - **Aura**: `neo4j+s://xxx.databases.neo4j.io`
3. Choose whether to clear existing data
4. Click Export

**Exported graph structure:**
- `ProcessStep` nodes with port properties
- `Source` and `Sink` nodes for process boundaries
- `MaterialStream`, `EnergyFlow`, `InformationFlow` relationships
- `CONTAINS` relationships for subprocess hierarchy

## DEXPI 2.0 Compliance

Generated XML files are validated against the official **DEXPI XML Schema** (`dexpi-schema-files/DEXPI_XML_Schema.xsd`, sourced from the [DEXPI 2.0 Specification](https://dexpi.gitlab.io/-/Specification/-/jobs/11676485644/artifacts/src/.build/html/html/basics/metamodel_and_exchange_format.html)).

The transformer enforces XSD-compliant output:
- All element IDs follow the `[A-Za-z_][A-Za-z_0-9]*` pattern required by the schema
- Data values use `Double`/`Integer`/`String` as specified (no generic `Number` type)
- `References` elements use the `objects` attribute with space-separated IDREFs
- Process types reference the official `Process/Process.*` class hierarchy from `Process.xml`

In Node and CLI environments, `validateDexpiOutputXsd()` from `src/transformer/DexpiOutputValidator.ts` runs `xmllint` against the bundled XSD. A structural fallback is available for browser contexts.

## Architecture

The core transformer is implemented as a standalone, framework-independent TypeScript module in `src/transformer/`, independently importable from the React frontend:

```
src/transformer/
├── BpmnToDexpiTransformer.ts   # Core BPMN → DEXPI 2.0 encoding
├── DexpiOutputValidator.ts      # XSD + structural validation
├── TransformerLogger.ts         # Warning/error collection per transform()
├── types.ts                     # Typed interfaces (zero `any`)
└── __tests__/                   # 36 automated tests
    ├── BpmnToDexpiTransformer.unit.test.ts
    ├── DexpiOutputValidator.unit.test.ts
    └── TennesseeEastman.integration.test.ts

dexpi-schema-files/
└── DEXPI_XML_Schema.xsd         # Official DEXPI 2.0 XML Schema
```

## Testing

```bash
# Run all 36 tests (3 suites)
npm test

# Watch mode during development
npm run test:watch

# With coverage report
npm run test:coverage
```

**Test suites:**
- `BpmnToDexpiTransformer.unit.test.ts` — 15 unit tests: type resolution, heuristic fallback warnings, duplicate port detection, output structure
- `DexpiOutputValidator.unit.test.ts` — 8 unit tests: structural validation of generated DEXPI 2.0 XML
- `TennesseeEastman.integration.test.ts` — 13 end-to-end tests including XSD validation against the official schema on the Tennessee Eastman benchmark

A GitHub Actions CI workflow (`.github/workflows/ci.yml`) runs all tests on every push and pull request against Node.js 18, 20, and 22.

## DEXPI Encoding

The tool implements the encoding methodology described in the associated publication. Key correspondences:

| DEXPI Process Element | BPMN 2.0 Element | SKOS Relationship |
|---|---|---|
| ProcessStep (any subtype) | Task | skos:narrowMatch |
| Source | Start Event | skos:narrowMatch |
| Sink | End Event | skos:narrowMatch |
| MaterialFlow / EnergyFlow | Sequence Flow | skos:narrowMatch |
| InformationFlow | Association | skos:narrowMatch |
| Port (inlet/outlet) | extensionElements | skos:relatedMatch |
| MaterialTemplate | Data Object | skos:relatedMatch |

All DEXPI-specific information (element type, ports, stream attributes, material states) is preserved in BPMN `extensionElements` using the `dexpi:` namespace, enabling lossless reconstruction.

**Annotation requirement:** The transformer reads the `dexpiType` attribute from `extensionElements` as the authoritative source for process step typing. Tasks without this annotation fall back to heuristic name-matching, which emits a warning and should not be relied upon for production use.

## Based on Research

This tool implements the encoding methodology described in:

> Shady Khella, Markus Schichtel, Erik Esche, Frauke Weichhardt, and Jens-Uwe Repke.
> *Encoding DEXPI Process Classes in BPMN 2.0 for Graphical Instantiation of Block Flow and Process Flow Diagrams* (under review, Digital Chemical Engineering, 2026).

A link to the publication will be added once available.

## Technology

- **Frontend**: React 19, TypeScript
- **Diagramming**: [bpmn.io](https://bpmn.io) (bpmn-js)
- **Build**: Vite 7
- **Testing**: Vitest, jsdom
- **Schema**: [DEXPI 2.0](https://dexpi.gitlab.io/-/Specification) (XSD validation via xmllint)

## Acknowledgments

This project was developed with assistance from AI coding tools, including GitHub Copilot and Claude.

## License

This project is released under the [MIT License](./LICENSE).

### Third-Party Licenses

**bpmn-js**
Licensed under the bpmn.io License (modified MIT). Free to use, including commercially, with one requirement: the bpmn.io watermark in diagrams must remain visible and unmodified.

**DEXPI Specification**
Licensed under Creative Commons Attribution 4.0 International License (CC BY 4.0).

---

*Current version: v0.1.0*
