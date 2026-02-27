#!/usr/bin/env python3
"""
Example: Using bpmn2dexpi from Python

This script demonstrates how to convert BPMN files to DEXPI XML
using the Node.js CLI tool from Python.
"""

import subprocess
import sys
from pathlib import Path

def bpmn_to_dexpi(bpmn_file: str, output_file: str = None) -> str:
    """
    Convert a BPMN file to DEXPI XML format.
    
    Args:
        bpmn_file: Path to input BPMN file
        output_file: Optional path to save output (if None, returns XML as string)
    
    Returns:
        DEXPI XML as string if output_file is None, otherwise None
    
    Raises:
        FileNotFoundError: If bpmn_file doesn't exist
        subprocess.CalledProcessError: If transformation fails
    """
    bpmn_path = Path(bpmn_file)
    if not bpmn_path.exists():
        raise FileNotFoundError(f"BPMN file not found: {bpmn_file}")
    
    # Build command
    cmd = ['node', 'cli.js', str(bpmn_path)]
    if output_file:
        cmd.append(str(output_file))
    
    # Run transformation
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=True
    )
    
    if output_file:
        print(f"✓ Saved DEXPI XML to {output_file}")
        return None
    else:
        return result.stdout


def main():
    """Example usage"""
    if len(sys.argv) < 2:
        print("Usage: python transform.py <input.bpmn> [output.xml]")
        print("\nExamples:")
        print("  python transform.py process.bpmn              # Print to console")
        print("  python transform.py process.bpmn output.xml   # Save to file")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None
    
    try:
        result = bpmn_to_dexpi(input_file, output_file)
        if result:
            print(result)
    except FileNotFoundError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"Transformation failed: {e.stderr}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
