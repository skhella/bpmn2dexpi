# DEXPI Process Tool

A graphical DEXPI process modeling tool built on top of bpmn.io, allowing you to create process flow diagrams with DEXPI-specific semantics and export them to DEXPI XML format.

## Features

- **Visual Process Modeling**: Use BPMN.io's powerful diagramming engine
- **DEXPI-Specific Palette**: Specialized elements for process engineering
  - Process Steps
  - Instrumentation Activities
  - Sources and Sinks
  - Material/Energy Flows
- **Port Management**: Graphical port editor with:
  - Multiple port types (Material, Energy, Information)
  - Port directions (Inlet/Outlet)
  - Visual positioning on shapes
- **Stream Properties**: Define material flows with:
  - Stream types (MaterialFlow, EnergyFlow)
  - Provenance and range qualifiers
  - Material template references
- **BPMN ↔ DEXPI Transformation**: 
  - Export BPMN diagrams with DEXPI extensions
  - Transform to DEXPI 2.0.0 XML format
- **Round-trip Support**: Import and continue editing BPMN files

## Based on Research

This tool implements the mapping methodology described in:
**"Mapping DEXPI to BPMN"** by Khella et al.

The tool maps:
- `ProcessStep` → BPMN Task
- `Source` → BPMN Start Event
- `Sink` → BPMN End Event
- `MaterialFlow/EnergyFlow` → BPMN Sequence Flow
- `InformationFlow` → BPMN Association
- Ports stored as BPMN extensionElements

## Getting Started

### Installation

```bash
cd dexpi-process-tool
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
npm run build
```

## Architecture

### Key Components

1. **DEXPI Moddle Extension** (`src/dexpi/moddle/`)
   - JSON schema defining DEXPI metadata structure
   - TypeScript interfaces for type safety

2. **Custom Renderer** (`src/dexpi/renderer/`)
   - Renders ports as visual overlays on BPMN shapes
   - Different colors/shapes for different port types

3. **Custom Palette** (`src/dexpi/palette/`)
   - Restricted palette with DEXPI-relevant elements
   - Custom icons and labels

4. **Properties Panel** (`src/components/`)
   - Edit DEXPI element types
   - Manage ports (add/remove/configure)
   - Define stream properties

5. **BPMN → DEXPI Transformer** (`src/transformer/`)
   - Parses BPMN XML with DEXPI extensions
   - Builds DEXPI 2.0.0 compliant XML
   - Handles port references and material templates

## Usage

### Creating a Process Diagram

1. **Add Elements**: Drag elements from the palette onto the canvas
2. **Set DEXPI Type**: Select an element and choose its DEXPI type in the properties panel
3. **Add Ports**: Click "Add Port" and configure port properties
4. **Connect Elements**: Draw connections between elements (via ports)
5. **Set Stream Properties**: Select a connection and configure stream metadata

### Exporting

- **Export BPMN**: Save your work in BPMN format (preserves all DEXPI metadata)
- **Export DEXPI XML**: Transform to DEXPI 2.0.0 XML for interoperability

## DEXPI Specification Compliance

This tool targets DEXPI Specification 2.0.0:
https://dexpi.gitlab.io/-/Specification/-/jobs/11676485644/artifacts/src/.build/html/html/index.html

### Supported DEXPI Elements

- ProcessStep (and subtypes)
- Source,- Stream
- MaterialTemplate, MaterialState
- Ports (Material, Energy, Information)
- Attributes with qualifiers (Provenance, Range, Mode)

## Technology Stack

- **React** + **TypeScript**: UI framework
- **bpmn-js**: BPMN modeling and rendering
- **diagram-js**: Canvas and interaction layer
- **xml2js**: XML parsing and generation
- **Vite**: Build tool and dev server

## License

This project is provided under the MIT License.

The DEXPI specification is licensed under Creative Commons Attribution 4.0 International License (CC BY 4.0).
