# bpmn2dexpi - CLI Usage

## Command Line Interface

The bpmn2dexpi project includes a CLI for converting BPMN files to DEXPI XML without using the web interface.

### Installation

```bash
cd bpmn2dexpi
npm install
```

### Usage

The examples below vary across two dimensions:
- how you run the CLI (npm script vs direct node/global command)
- what input you provide (BPMN or DEXPI XML)

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

#### Option 3: Export to Neo4j (BPMN or DEXPI input)

```bash
# BPMN input (auto transforms BPMN -> DEXPI before export)
npm run neo4j-export <input.bpmn> -- --uri <uri> --user <user> --password <password> [--database neo4j]

# DEXPI input
npm run neo4j-export <input.xml> -- --input-type dexpi --uri <uri> --user <user> --password <password>
```

Both `bolt://` (local) and `neo4j+s://` (Aura cloud) URIs are supported.

**Examples:**
```bash
# Export BPMN directly to Neo4j
npm run neo4j-export "examples/Tennessee_Eastman_Process.bpmn" -- --uri bolt://localhost:7687 --user neo4j --password secret

# Export DEXPI XML directly to Neo4j
npm run neo4j-export output.xml -- --input-type dexpi --uri bolt://localhost:7687 --user neo4j --password secret

# Save transformed DEXPI while exporting BPMN
npm run neo4j-export process.bpmn -- --uri bolt://localhost:7687 --user neo4j --password secret --dexpi-out process-dexpi.xml

# Use a non-default database
npm run neo4j-export process.bpmn -- --uri bolt://localhost:7687 --user neo4j --password secret --database mydb
```

### Help

```bash
# General help
node --import tsx cli.js --help

# Neo4j export help (shows all options)
node --import tsx cli.js neo4j-export --help
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
from bpmn2dexpi import transform, export_to_neo4j

# Convert and save to file
transform('process.bpmn', 'output.xml')

# Convert and get XML as string
dexpi_xml = transform('process.bpmn')
print(dexpi_xml)

# Export BPMN directly to Neo4j
export_to_neo4j(
    input_file='process.bpmn',
    uri='bolt://localhost:7687',
    user='neo4j',
    password='secret',
    database='neo4j'
)

# Export DEXPI XML directly to Neo4j
export_to_neo4j(
    input_file='process.xml',
    uri='bolt://localhost:7687',
    user='neo4j',
    password='secret',
    input_type='dexpi'
)
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

**4. `Missing required option(s): --uri, --password`**
- The CLI tells you exactly which flags are missing
- Run `bpmn2dexpi neo4j-export --help` to see all required options

**5. `Cannot determine input type from 'file.dat'`**
- Use `--input-type bpmn` or `--input-type dexpi` when the file extension isn't `.bpmn` or `.xml`

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
