#!/usr/bin/env python3
"""
Python integration helpers for bpmn2dexpi CLI

This module provides wrappers for:
- BPMN -> DEXPI transformation
- BPMN/DEXPI -> Neo4j export
"""

import subprocess
import sys
from pathlib import Path

def transform(bpmn_file: str, output_file: str = None) -> str:
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
    cmd = ['node', '--import', 'tsx', 'cli.js', str(bpmn_path)]
    if output_file:
        cmd.append(str(output_file))
    
    # Run transformation
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=True
    )
    if result.stderr:
        print(result.stderr, end='', file=sys.stderr)
    
    if output_file:
        return None
    else:
        return result.stdout


def export_to_neo4j(
    input_file: str,
    uri: str,
    user: str,
    password: str,
    database: str = 'neo4j',
    input_type: str = None,
    dexpi_output_file: str = None,
) -> None:
    """
    Export BPMN or DEXPI XML to Neo4j.

    If input_file is BPMN, it is transformed to DEXPI first and then exported.

    Args:
        input_file: Path to input BPMN (.bpmn) or DEXPI (.xml) file
        uri: Neo4j URI (e.g., bolt://localhost:7687)
        user: Neo4j username
        password: Neo4j password
        database: Neo4j database name (default: neo4j)
        input_type: Optional explicit input type ('bpmn' or 'dexpi')
        dexpi_output_file: Optional path to save transformed DEXPI (BPMN input only)

    Raises:
        FileNotFoundError: If input_file doesn't exist
        ValueError: If input_type is invalid
        subprocess.CalledProcessError: If export fails
    """
    input_path = Path(input_file)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    if input_type is not None and input_type not in ('bpmn', 'dexpi'):
        raise ValueError("input_type must be 'bpmn' or 'dexpi'")

    cmd = [
        'node',
        '--import',
        'tsx',
        'cli.js',
        'neo4j-export',
        str(input_path),
        '--uri',
        uri,
        '--user',
        user,
        '--password',
        password,
        '--database',
        database,
    ]

    if input_type:
        cmd.extend(['--input-type', input_type])
    if dexpi_output_file:
        cmd.extend(['--dexpi-out', str(dexpi_output_file)])

    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    if result.stderr:
        print(result.stderr, end='', file=sys.stderr)


def main():
    """Example usage"""
    if len(sys.argv) < 2:
        print("Usage: python bpmn2dexpi.py <input.bpmn> [output.xml]")
        print("       python bpmn2dexpi.py neo4j <input.{bpmn|xml}> <uri> <user> <password> [database]")
        print("\nExamples:")
        print("  python bpmn2dexpi.py process.bpmn              # Print to console")
        print("  python bpmn2dexpi.py process.bpmn output.xml   # Save to file")
        print("  python bpmn2dexpi.py neo4j process.bpmn bolt://localhost:7687 neo4j secret")
        sys.exit(1)

    if sys.argv[1] == 'neo4j':
        if len(sys.argv) < 6:
            print("Usage: python bpmn2dexpi.py neo4j <input.{bpmn|xml}> <uri> <user> <password> [database]", file=sys.stderr)
            sys.exit(1)

        input_file = sys.argv[2]
        uri = sys.argv[3]
        user = sys.argv[4]
        password = sys.argv[5]
        database = sys.argv[6] if len(sys.argv) > 6 else 'neo4j'

        try:
            export_to_neo4j(
                input_file=input_file,
                uri=uri,
                user=user,
                password=password,
                database=database,
            )
            print(f"✓ Exported {input_file} to Neo4j")
        except FileNotFoundError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
        except subprocess.CalledProcessError as e:
            print(f"Neo4j export failed: {e.stderr}", file=sys.stderr)
            sys.exit(1)
        return

    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) > 2 else None
    
    try:
        result = transform(input_file, output_file)
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
