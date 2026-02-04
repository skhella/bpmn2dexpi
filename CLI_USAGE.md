# DEXPI Process Tool - CLI Usage

## Command Line Interface

The DEXPI Process Tool includes a CLI for converting BPMN files to DEXPI XML without using the web interface.

### Installation

```bash
cd dexpi-process-tool
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

### Help

```bash
npm run transform --help
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
sys.path.append('path/to/dexpi-process-tool')
from transform import bpmn_to_dexpi

# Convert and save to file
bpmn_to_dexpi('process.bpmn', 'output.xml')

# Convert and get XML as string
dexpi_xml = bpmn_to_dexpi('process.bpmn')
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
        cwd='path/to/dexpi-process-tool',
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
from transform import bpmn_to_dexpi

# Process multiple files
input_dir = Path('bpmn_files')
output_dir = Path('dexpi_outputs')
output_dir.mkdir(exist_ok=True)

for bpmn_file in input_dir.glob('*.bpmn'):
    output_file = output_dir / f"{bpmn_file.stem}.xml"
    print(f"Converting {bpmn_file.name}...")
    bpmn_to_dexpi(str(bpmn_file), str(output_file))
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

- `0`: Success
- `1`: Error (file not found, transformation failed, etc.)

---

## Output

The CLI produces DEXPI XML that matches the web app's export format, including:
- Process steps and equipment
- Material streams with composition data
- Port connections
- Material templates and states
- Process parameters

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

- Node.js >= 18
- npm >= 9
- Python >= 3.7 (for Python wrapper)

## Dependencies

Automatically installed with `npm install`:
- tsx (TypeScript execution)
- jsdom (DOM parsing in Node.js)
- xml2js (XML parsing)
