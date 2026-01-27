# DEXPI Process Tool

A web-based tool for creating DEXPI-compliant process flow diagrams. Model chemical processes visually and export to DEXPI XML format for interoperability with engineering tools.

## Features

- **Visual Modeling**: Drag-and-drop interface for process diagrams
- **DEXPI Compliance**: Export to DEXPI 2.0 XML standard
- **Material Library**: Define materials, compositions, and states
- **Port System**: Connect equipment with typed ports (Material, Energy, Information)
- **Stream Properties**: Configure flow properties and material references
- **CLI Tool**: Batch convert BPMN files to DEXPI XML from terminal or Python

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

1. Drag process elements from the palette
2. Connect elements with flows
3. Add materials and compositions in the Material Library
4. Configure ports and streams in the properties panel
5. Export to DEXPI XML

### Command Line

```bash
# Convert BPMN to DEXPI XML
npm run transform process.bpmn output.xml
```

### Python Integration

```python
from transform import bpmn_to_dexpi
bpmn_to_dexpi('input.bpmn', 'output.xml')
```

See [CLI_USAGE.md](./CLI_USAGE.md) for more examples.

## Based on Research

Implements the BPMN-DEXPI mapping from **"Mapping DEXPI to BPMN"** by Khella et al.

**Mapping:**
- ProcessStep → BPMN Task
- Source → BPMN Start Event  
- Sink → BPMN End Event
- MaterialFlow/EnergyFlow → BPMN Sequence Flow
- InformationFlow → BPMN Association
- Ports → BPMN extensionElements

## Technology

Built with React, TypeScript, and bpmn.io. Targets [DEXPI 2.0 specification](https://dexpi.gitlab.io/-/Specification).

## License

This project is released under the MIT License.

### Third-Party Licenses

**bpmn-js** (https://bpmn.io/license/)  
This tool uses bpmn-js, which is dual-licensed:
- Free for non-commercial and evaluation purposes
- Requires a commercial license for production use in commercial projects

If you plan to use this tool in a commercial setting, please review bpmn-js licensing at https://bpmn.io/license/ and obtain appropriate licenses.

**DEXPI Specification**  
The DEXPI specification is licensed under Creative Commons Attribution 4.0 International License (CC BY 4.0).

See [LICENSE](./LICENSE) for the MIT License terms of this project.
