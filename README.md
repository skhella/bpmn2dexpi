# bpmn2dexpi
A web-based tool for creating DEXPI-compliant block flow and process flow diagrams. Model chemical processes visually and export to DEXPI XML format for interoperability with engineering tools.

## Features

- **Visual Modeling**: Drag-and-drop interface for process diagrams
- **DEXPI Compliance**: Export to DEXPI 2.0 XML standard
- **Material Library**: Define materials, compositions, and states
- **Port System**: Connect equipment with typed ports (Material, Energy, Information)
- **Stream Properties**: Configure flow properties and material references
- **Neo4j Export**: Export process graphs directly to Neo4j database
- **CLI Tool**: Batch convert BPMN files to DEXPI XML from terminal or Python

## Prerequisites

- **Node.js** 18+ (recommended: 20 LTS)
- **npm** 9+


## Quick Start

```bash
# Install dependencies
npm install

# Run the web app
npm run dev

# Or use CLI for batch processing
npm run transform input.bpmn output.xml
```

## Usage

### Web Interface

1. Open `http://localhost:5173` in your browser
2. Drag process elements from the palette
3. Connect elements with flows
4. Add materials and compositions in the Material Library
5. Configure ports and streams in the properties panel
6. Export to DEXPI XML or Neo4j

<img src="./examples/Web-Interface-Screenshot.png" alt="Web Interface Screenshot" width="90%" />

### Command Line

```bash
# Convert BPMN to DEXPI XML
npm run transform process.bpmn output.xml
```

### Python Integration

```python
from transform import bpmn_to_dexpi

# Convert and save to file
bpmn_to_dexpi('input.bpmn', 'output.xml')

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

Note: the app can remember URI/username/database locally. Neo4j passwords are kept only for the current browser tab session and are not persisted long-term.

**Exported graph structure:**
- `ProcessStep` nodes with port properties
- `Source` and `Sink` nodes for process boundaries
- `MaterialStream`, `EnergyFlow`, `InformationFlow` relationships
- `CONTAINS` relationships for subprocess hierarchy

## Examples

See the [examples/](./examples/) folder for sample BPMN files

## Based on Research

This tool implements the BPMN-DEXPI mapping approach for representing chemical process information using BPMN notation with DEXPI extensions.

**Core Mapping:**
| DEXPI Concept | BPMN Element |
|---------------|--------------|
| ProcessStep | Task |
| Source | Start Event |
| Sink | End Event |
| MaterialFlow/EnergyFlow | Sequence Flow |
| InformationFlow | Association |
| Ports | extensionElements |

## Technology

- **Frontend**: React 19, TypeScript
- **Diagramming**: [bpmn.io](https://bpmn.io) (bpmn-js)
- **Build**: Vite 7
- **Target Spec**: [DEXPI 2.0](https://dexpi.gitlab.io/-/Specification)



## AI-Assisted Development

This project was developed with assistance from Large Language Models and AI coding tools, including GitHub Copilot and Claude. These tools helped with code generation, debugging, and implementation of features.

## License

This project is released under the [MIT License](./LICENSE).

### Third-Party Licenses

**bpmn-js**  
Licensed under the bpmn.io License (modified MIT). Free to use, including commercially, with one requirement: the bpmn.io watermark in diagrams must remain visible and unmodified.

**DEXPI Specification**  
Licensed under Creative Commons Attribution 4.0 International License (CC BY 4.0).


