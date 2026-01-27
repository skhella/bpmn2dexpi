# DEXPI Process Tool

A graphical DEXPI process modeling tool built on top of bpmn.io, allowing you to create process flow diagrams with DEXPI-specific semantics and export them to DEXPI XML format.

## Features

- **Visual Process Modeling**: Use BPMN.io's powerful diagramming engine
- **DEXPI-Specific Palette**: Specialized elements for process engineering
  - 130+ ProcessStep types (DEXPI 2.0 compliant)
  - InstrumentationActivity types with automatic color coding
  - Sources and Sinks
  - Material/Energy Flows
  - Auto-type assignment for new elements
- **Material Library System**:
  - Material templates with component lists
  - Material states with composition fractions
  - Inline editing (no modals)
  - Template-based auto-population of compositions
- **Port Management**: Graphical port editor with:
  - Multiple port types (Material, Energy, Information)
  - Port directions (Inlet/Outlet)
  - Visual positioning on shapes
  - Hierarchical port mapping (parent-child relationships)
  - Automatic port positioning behavior
- **Stream Properties**: Define material flows with:
  - Stream types (MaterialFlow, EnergyFlow)
  - Provenance and range qualifiers
  - Material state references
  - Port-to-port connections
- **BPMN ↔ DEXPI Transformation**: 
  - Export BPMN diagrams with DEXPI extensions
  - Transform to DEXPI 2.0.0 XML format
  - QualifiedValue structure compliance
  - Proper hierarchical ProcessStep and port relationships
- **Round-trip Support**: Import and continue editing BPMN files
- **CLI Tool**: Command-line interface for batch processing
  - Node.js CLI for terminal usage
  - Python wrapper for data pipeline integration
  - Identical output to web app export

## Based on Research

This tool implements the mapping methodology described in:
**"Mapping DEXPI to BPMN"** by Khella et al.

The tool maps:
- `ProcessStep` → BPMN Task (130+ subtypes supported)
- `InstrumentationActivity` → BPMN Task (color-coded green)
- `Source` → BPMN Start Event
- `Sink` → BPMN End Event
- `MaterialFlow/EnergyFlow` → BPMN Sequence Flow
- `InformationFlow` → BPMN Association
- Ports stored as BPMN extensionElements with hierarchy support

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

Open http://localhost:5174 in your browser.

### CLI Usage

Transform BPMN files to DEXPI XML from the command line:

```bash
# Using npm script
npm run transform input.bpmn output.xml

# Direct node execution
node --import tsx cli.js input.bpmn output.xml

# Print to stdout
npm run transform input.bpmn
```

**Python Integration:**

```python
from transform import bpmn_to_dexpi

# Save to file
bpmn_to_dexpi('process.bpmn', 'output.xml')

# Get as string
dexpi_xml = bpmn_to_dexpi('process.bpmn')
```

See [CLI_USAGE.md](./CLI_USAGE.md) for detailed documentation and examples.

### Build

```bash
npm run build
```

## Architecture

### Key Components

1. **DEXPI Moddle Extension** (`src/dexpi/moddle/`)
   - JSON schema defining DEXPI metadata structure
   - TypeScript interfaces for type safety
   - Material templates and states system

2. **Custom Renderer** (`src/dexpi/renderer/`)
   - Renders ports as visual overlays on BPMN shapes
   - Different colors/shapes for different port types
   - Color-coded ProcessStep types (blue) and InstrumentationActivity (green)

3. **Custom Palette** (`src/dexpi/palette/`)
   - Restricted palette with DEXPI-relevant elements
   - Custom icons and labels

4. **Behaviors** (`src/dexpi/behavior/`)
   - **AutoTypeBehavior**: Automatically assigns default DEXPI types to new elements
   - **PortBehavior**: Automatic port positioning on element creation

5. **Properties Panels** (`src/components/`)
   - **DexpiPropertiesPanel**: Edit DEXPI element types with organized dropdowns
   - **MaterialLibraryPanel**: Browse and manage material templates, components, and states
   - **MaterialEditorPanel**: Inline editing of material properties and compositions
   - Port management (add/remove/configure)
   - Stream properties configuration

6. **BPMN → DEXPI Transformer** (`src/transformer/`)
   - Parses BPMN XML with DEXPI extensions
   - Builds DEXPI 2.0.0 compliant XML
   - Handles hierarchical port references
   - Processes material templates and states
   - QualifiedValue structure for attributes
   - 130+ ProcessStep type mappings from schema

7. **Enumerations** (`src/utils/dexpiEnumerations.ts`)
   - Comprehensive DEXPI type system
   - 60+ ProcessStep types
   - 7 InstrumentationActivity types
   - Type aliases for common names

## Usage

### Creating a Process Diagram

1. **Add Elements**: Drag elements from the palette onto the canvas
2. **Set DEXPI Type**: Select an element and choose its DEXPI type from organized dropdowns in the properties panel
   - Auto-type assignment happens for new elements
   - 130+ ProcessStep types available
   - InstrumentationActivity types (color-coded green)
3. **Add Ports**: Click "Add Port" and configure port properties
   - Ports automatically position on element boundaries
   - Support for hierarchical parent-child port relationships
4. **Manage Materials**: Open the Material Library to:
   - Create material templates with component lists
   - Define material states with composition fractions
   - Edit compositions inline (auto-populated from templates)
5. **Connect Elements**: Draw connections between elements (via ports)
6. **Set Stream Properties**: Select a connection and configure:
   - Stream type and provenance
   - Material state references
   - Port connections

### Exporting

- **Export BPMN**: Save your work in BPMN format (preserves all DEXPI metadata)
- **Export DEXPI XML**: Transform to DEXPI 2.0.0 XML for interoperability
  - Via web UI: Click "Export DEXPI XML" button
  - Via CLI: `npm run transform input.bpmn output.xml`
  - Via Python: `bpmn_to_dexpi('input.bpmn', 'output.xml')`

## DEXPI Specification Compliance

This tool targets DEXPI Specification 2.0.0:
https://dexpi.gitlab.io/-/Specification/-/jobs/11676485644/artifacts/src/.build/html/html/index.html

### Supported DEXPI Elements

- **ProcessStep** (130+ subtypes from DEXPI 2.0 schema)
  - Type aliases for common names (e.g., "Measuring" → "MeasuringProcessVariable")
  - All types map to concrete classes from Process.xml
- **InstrumentationActivity** (7 types)
  - Automatically color-coded green for visual distinction
- **Source/Sink** - Process boundaries
- **Stream** - Material/Energy flows with qualified attributes
- **MaterialTemplate** - Reusable material definitions with component lists
- **MaterialComponent** - Chemical components
- **MaterialState** - Material compositions with fractions
- **MaterialStateType** - Object-based state types
- **Ports** (Material, Energy, Information)
  - Hierarchical parent-child relationships
  - Automatic positioning
- **Attributes with qualifiers**
  - QualifiedValue structure (Provenance, Range, Scope)
  - DEXPI 2.0 compliant enumerations

## Technology Stack

- **React** + **TypeScript**: UI framework
- **bpmn-js**: BPMN modeling and rendering
- **diagram-js**: Canvas and interaction layer
- **xml2js**: XML parsing and generation
- **Vite**: Build tool and dev server
- **tsx**: TypeScript execution for CLI
- **jsdom**: DOM API support for Node.js CLI

## Sample Files

- **`sample-tennessee.bpmn`**: Tennessee Eastman Process with full instrumentation, ports, streams, and material states

## Project Files

- **`cli.js`**: Node.js CLI tool for BPMN → DEXPI transformation
- **`transform.py`**: Python wrapper for CLI integration
- **`CLI_USAGE.md`**: Detailed CLI documentation with examples
- **`README.md`**: This file

## Recent Updates

### v0.2.0 (Latest)
- ✅ Added CLI tool for command-line and Python usage
- ✅ Fixed material editor panel closing behavior
- ✅ Added jsdom and tsx dependencies for Node.js support

### v0.1.0
- ✅ Port hierarchy mapping (parent ports → single child port)
- ✅ DEXPI 2.0 schema compliance updates
- ✅ 130+ ProcessStep type mappings
- ✅ QualifiedValue structure fixes
- ✅ Material library with inline editing
- ✅ Template-based composition auto-population
- ✅ AutoTypeBehavior and PortBehavior
- ✅ Comprehensive DEXPI enumerations

## License

This project is provided under the MIT License.

The DEXPI specification is licensed under Creative Commons Attribution 4.0 International License (CC BY 4.0).
