# bpmn2dexpi - CLI Usage

## Command Line Interface

The bpmn2dexpi project includes a CLI for converting BPMN files to DEXPI XML without using the web interface.

### Installation

```bash
cd bpmn2dexpi
npm install
```

### Usage

#### Option 1: Using npm script (recommended)

```bash
npm run transform <input.bpmn> [output.xml]
```

**Examples:**
```bash
# Save to file
npm run transform "examples/Tennessee_Eastman_Process.bpmn" output.xml

# Print to console
npm run transform "examples/Tennessee_Eastman_Process.bpmn"
```

#### Option 2: Direct node execution

```bash
node --import tsx cli.js <input.bpmn> [output.xml]
```

### Flags

```bash
npm run transform -- [flags] <input.bpmn> [output.xml]
```

| Flag | Effect |
|---|---|
| `--strict` | After the export, run the five information-model fidelity checks (property names and kinds, data types, reference targets, cardinality, class existence) and exit non-zero on findings. The file is still written. |
| `--profile FILE` | Load a DEXPI Profile into the vocabulary (repeatable). The export declares it with an `<Import prefix="…">`. |
| `--generate-profile FILE` | Write the export's Profile to FILE instead of the default `output.profile.xml`. |
| `--no-profile` | Do not write or import a Profile, even when the model uses properties outside the DEXPI 2.0 vocabulary. |
| `--validate FILE` | Validate an existing DEXPI 2.0 XML file (Process or Plant) instead of transforming: XSD plus the five fidelity dimensions. Combine with `--profile` for the Profiles it was written against. |

```bash
# export with strict checks
npm run transform -- --strict examples/Tennessee_Eastman_Process.bpmn tep.xml
# → tep.xml and, because the example uses thermodynamic attributes, tep.profile.xml

# validate any DEXPI 2.0 file, loading the Profile it imports
npm run transform -- --validate tep.xml --profile tep.profile.xml
```

### Help

```bash
npm run transform -- --help
```

---

## Python Integration

Use the included Python wrapper for seamless integration in Python projects.

### Basic Usage

```python
from pathlib import Path
import subprocess

# Method 1: Using the helper script
import sys
sys.path.append('path/to/bpmn2dexpi')
from bpmn2dexpi import transform

# Convert and save to file
transform('process.bpmn', 'output.xml')

# Convert and get XML as string
dexpi_xml = transform('process.bpmn')
print(dexpi_xml)
```

### Advanced Python Usage

```python
import subprocess
from pathlib import Path

def convert_bpmn_to_dexpi(bpmn_path: str, output_path: str = None) -> str:
    """
    Convert BPMN to DEXPI XML using the Node.js CLI.
    
    Args:
        bpmn_path: Path to input BPMN file
        output_path: Optional output file path
        
    Returns:
        DEXPI XML string if no output_path, else None
    """
    cmd = ['npm', 'run', 'transform', bpmn_path]
    if output_path:
        cmd.append(output_path)
    
    result = subprocess.run(
        cmd,
        cwd='path/to/bpmn2dexpi',
        capture_output=True,
        text=True,
        check=True
    )
    
    return None if output_path else result.stdout

# Example usage
convert_bpmn_to_dexpi('input.bpmn', 'output.xml')
```

### Batch Processing Example

```python
from pathlib import Path
from bpmn2dexpi import transform

# Process multiple files
input_dir = Path('bpmn_files')
output_dir = Path('dexpi_outputs')
output_dir.mkdir(exist_ok=True)

for bpmn_file in input_dir.glob('*.bpmn'):
    output_file = output_dir / f"{bpmn_file.stem}.xml"
    print(f"Converting {bpmn_file.name}...")
    transform(str(bpmn_file), str(output_file))
    print(f"  → {output_file.name}")
```

---

## Error Handling

### Common Issues

**1. `command not found: node`**
- Install Node.js: https://nodejs.org/

**2. `Cannot find module 'tsx'`**
- Run: `npm install`

**3. `ENOENT: no such file or directory`**
- Check the input file path
- Use absolute paths if relative paths fail

### Exit Codes

- `0`: success
- `1`: error (file not found, transformation failed, XSD validation failed under `--validate`)
- `2`: fidelity findings under `--strict` or `--validate` (the output file is still written)

---

## Output

The CLI produces the same DEXPI 2.0 XML as the web app's export:
- process steps with ports, hierarchy level and sub-steps
- material and energy streams with their quantities
- instrumentation activities referencing the steps they observe
- material templates, components, states and compositions
- a `.profile.xml` next to the output whenever the model uses properties beyond the DEXPI 2.0 vocabulary, imported by the document (see the README, *Profile imports in exported documents*)

The web app can also do the reverse — import a DEXPI 2.0 Process XML and lay it out as a BPMN diagram; the CLI does not.

---

## Integration Examples

### Makefile

```makefile
%.xml: %.bpmn
	npm run transform $< $@

all: process1.xml process2.xml process3.xml
```

### Shell Script

```bash
#!/bin/bash
for bpmn in *.bpmn; do
    output="${bpmn%.bpmn}.xml"
    echo "Converting $bpmn → $output"
    npm run transform "$bpmn" "$output"
done
```

### Python Data Pipeline

```python
import subprocess
import pandas as pd

def process_pipeline(bpmn_file: str) -> pd.DataFrame:
    # Convert BPMN to DEXPI
    result = subprocess.run(
        ['npm', 'run', 'transform', bpmn_file],
        capture_output=True,
        text=True,
        check=True
    )
    dexpi_xml = result.stdout
    
    # Parse and analyze
    # ... your analysis code ...
    
    return dataframe

# Use in pipeline
df = process_pipeline('tennessee-eastman.bpmn')
```

---

## Requirements

- Node.js >= 20
- npm >= 9
- Python >= 3.7 (for Python wrapper)

## Dependencies

Automatically installed with `npm install`:
- tsx (TypeScript execution)
- jsdom (DOM parsing in Node.js)
- xml2js (XML parsing)
