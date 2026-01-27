# DEXPI Process Tool

A graphical DEXPI process modeling tool built on top of bpmn.io, allowing you to create process flow diagrams with DEXPI-specific semantics and export them to DEXPI XML format.

**🌐 Web App** | **⚙️ CLI Tool** | **🐍 Python Integration**

## Features

### Visual Modeling (Web App)

- **Visual Process Modeling**: Use BPMN.io's powerful diagramming engine
- **DEXPI-Specific Palette**: Specialized elements for process engineering
  - Process Steps
  - Instrumentation Activities
  - Sources and Sinks
  - Material/Energy Flows
- **Material Library**: Inline editing for:
  - Material Templates (compositions with component lists)
  - Material Components (individual substances)
  - Material States (temperature, pressure, composition fractions)
- **Port Management**: Graphical port editor with:
  - Multiple port types (Material, Energy, Information)
  - Port directions (Inlet/Outlet)
  - Visual positioning on shapes
  - Toggle visibility (hide ports for cleaner diagrams)
- **Stream Properties**: Define material flows with:
  - Stream types (MaterialFlow, EnergyFlow)
  - Provenance and range qualifiers
  - Material state references
- **BPMN ↔ DEXPI Transformation**: 
  - Export BPMN diagrams with DEXPI extensions
  - Transform to DEXPI 2.0.0 XML format
- **Round-trip Support**: Import and continue editing BPMN files
- **Subprocess Navigation**: Drill down into subprocesses with breadcrumb navigation

### Command-Line Interface (CLI)

- **Batch Processing**: Transform BPMN files to DEXPI XML without UI
- **Python Integration**: Use from Python scripts and data pipelines
- **Identical Output**: Same transformation as web app
- **No Server Required**: Standalone execution

See [CLI_USAGE.md](CLI_USAGE.md) for detailed CLI documentation.

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

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Python** >= 3.7 (optional, for Python integration)

### Installation

```bash
git clone https://github.com/skhella/dexpi-process-tool.git
cd dexpi-process-tool
npm install
```

### Web Application

Start the development server:

```bash
npm run dev
```

Open http://localhost:5174 in your browser.

### CLI Usage

Transform BPMN to DEXPI XML:

```bash
# Save to file
npm run transform input.bpmn output.xml

# Print to console
npm run transform input.bpmn

# From Python
python3 transform.py input.bpmn output.xml
```

See [CLI_USAGE.md](CLI_USAGE.md) for complete CLI documentation.

### Build for Production

```bash
npm run build
```

### Deploy to Web

The app can be deployed to Vercel, Netlify, or any static host:

```bash
# Example: Vercel
npm i -g vercel
vercel
```

Or expose locally with ngrok:

```bash
ngrok http 5174
```

## Architecture

### Key Components

1. **DEXPI Moddle Extension** (`src/dexpi/moddle/`)
   - JSON schema defining DEXPI metadata structure
   - TypeScript interfaces for type safety
   - Material data model (templates, components, states)

2. **Custom Renderer** (`src/dexpi/renderer/`)
   - Renders ports as visual overlays on BPMN shapes
   - Different colors/shapes for different port types
   - Toggle port visibility

3. **Custom Palette** (`src/dexpi/palette/`)
   - Restricted palette with DEXPI-relevant elements
   - Custom icons and labels

4. **Properties Panels** (`src/components/`)
   - **DexpiPropertiesPanel**: Edit element types and properties
   - **MaterialLibraryPanel**: Manage templates, components, and states
   - **MaterialEditorPanel**: Edit material compositions inline
   - Port management (add/remove/configure)
   - Stream properties configuration

5. **BPMN → DEXPI Transformer** (`src/transformer/`)
   - Parses BPMN XML with DEXPI extensions
   - Builds DEXPI 2.0.0 compliant XML
   - Handles port references, material templates, and states
   - Maps process hierarchy to DEXPI structure

6. **CLI Tool** (`cli.js`, `transform.py`)
   - Standalone Node.js CLI for batch processing
   - Python wrapper for integration in data pipelines
   - Uses same transformer as web app

## Usage

### Web Application

#### Creating a Process Diagram

1. **Add Elements**: Drag elements from the palette onto the canvas
2. **Set DEXPI Type**: Select an element and choose its DEXPI type in the properties panel
3. **Add Ports**: Click "Add Port" and configure port properties
4. **Connect Elements**: Draw connections between elements (via ports)
5. **Set Stream Properties**: Select a connection and configure stream metadata

#### Managing Materials

1. **Open Material Library**: Click the "📚 Materials" button
2. **Add Templates**: Define material compositions with component lists
3. **Add States**: Create material states with temperature, pressure, and composition fractions
4. **Reference in Streams**: Select a stream and choose a material state

#### Subprocess Navigation

1. **Create Subprocess**: Add a subprocess element
2. **Enter Subprocess**: Double-click or use the marker to drill down
3. **Navigate Back**: Use the "← Back to Parent" button in the toolbar

#### Exporting

- **Export BPMN**: Save your work in BPMN format (preserves all DEXPI metadata)
- **Export DEXPI XML**: Transform to DEXPI 2.0.0 XML for interoperability

### Command-Line Usage

#### Basic Transformation

```bash
# Transform single file
npm run transform process.bpmn output.xml

# Process multiple files
for f in *.bpmn; do npm run transform "$f" "${f%.bpmn}.xml"; done
```

#### Python Integration

```python
from transform import bpmn_to_dexpi

# Convert and save
bpmn_to_dexpi('tennessee-eastman.bpmn', 'output.xml')

# Get XML string
xml = bpmn_to_dexpi('process.bpmn')
print(xml)
```

See [CLI_USAGE.md](CLI_USAGE.md) for advanced usage and batch processing examples.

## DEXPI Specification Compliance

This tool targets DEXPI Specification 2.0.0:
https://dexpi.gitlab.io/-/Specification/-/jobs/11676485644/artifacts/src/.build/html/html/index.html

### Supported DEXPI Elements

- ProcessStep (and subtypes like ReactingChemicals, Separating, etc.)
- Source / Sink
- Stream (MaterialFlow, EnergyFlow)
- MaterialTemplate, MaterialComponent, MaterialState
- Ports (Material, Energy, Information)
- Attributes with qualifiers (Provenance, Range, Mode)
- Process hierarchy (nested subprocesses)

## Examples

The repository includes a complete example:

- **`sample-tennessee.bpmn`**: Tennessee Eastman Process with instrumentation, ports, and material states
- Demonstrates subprocess hierarchy, port connections, and material library usage
- Can be imported and exported to DEXPI XML

## Technology Stack

- **React** + **TypeScript**: UI framework
- **bpmn-js**: BPMN modeling and rendering
- **diagram-js**: Canvas and interaction layer
- **xml2js**: XML parsing and generation
- **Vite**: Build tool and dev server
- **tsx**: TypeScript execution for CLI
- **jsdom**: DOM APIs for Node.js CLI

## Repository

**GitHub**: https://github.com/skhella/dexpi-process-tool

```bash
git clone https://github.com/skhella/dexpi-process-tool.git
```

## License

This project is provided under the MIT License.

The DEXPI specification is licensed under Creative Commons Attribution 4.0 International License (CC BY 4.0).

## Contributing

Contributions are welcome! Please open an issue or pull request on GitHub.

## Citation

If you use this tool in your research, please cite:

```
Khella, S. et al. (2024). "Mapping DEXPI to BPMN for Process Engineering Workflows"
```

## Support

- **Issues**: https://github.com/skhella/dexpi-process-tool/issues
- **Documentation**: See [CLI_USAGE.md](CLI_USAGE.md) for CLI documentation
- **DEXPI Spec**: https://dexpi.org
