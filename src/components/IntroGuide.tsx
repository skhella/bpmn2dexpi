/**
 * First-visit guide dialog.
 *
 * Orients visitors who open the hosted app without having read the paper:
 * what the tool is, how to model a BFD/PFD with DEXPI Process semantics,
 * the BPMN-to-DEXPI mapping, an entry point into the interactive
 * step-by-step tour, and a one-click way to load the bundled Tennessee
 * Eastman example (the paper's benchmark). Shown once per browser
 * (localStorage flag, owned by App) and reopenable from the toolbar's
 * Guide button.
 */

interface IntroGuideProps {
  open: boolean;
  onClose: () => void;
  onLoadExample: () => void;
  onStartTour: () => void;
}

const MAPPING: [string, string][] = [
  ['Start event', 'Source'],
  ['End event', 'Sink'],
  ['Task', 'ProcessStep or InstrumentationActivity (class chosen in the panel)'],
  ['Subprocess', 'Nested ProcessStep (SubProcessSteps hierarchy)'],
  ['Sequence flow', 'Stream (MaterialFlow / EnergyFlow / InformationFlow)'],
  ['Ports on an element', 'MaterialPort / energy ports / InformationPort'],
  ['Data object', 'Material library host, or a named process variable linking a process step and an instrumentation activity'],
  ['Pool', 'The process container (ProcessModel)'],
];

const STEPS: string[] = [
  'Drag a start event onto the canvas for each feed (DEXPI: Source) and an end event for each product (DEXPI: Sink).',
  'Drag tasks for the process steps and pick each one’s DEXPI class (Compressing, Cooling, ReactingChemicals, …) in the right-hand panel. Splitting and mixing are process steps too (SplittingMaterial, MixingSimple) — DEXPI Process has no gateways.',
  'Connect elements with sequence flows — each becomes a DEXPI Stream, and typed ports (Material / Energy / Information) are created on both ends automatically. Toggle “Ports” in the toolbar to see them.',
  'Define materials under “Materials”: templates, components, and states with flow data and composition. Link a stream to a material state in the stream’s panel.',
  'Model instrumentation as its own small task: set its DEXPI class to MeasuringProcessVariable (or ControllingProcessVariable, ConveyingSignal, …). Create a data object, wire instrumentation task and process step together through it with data associations, and pick the variable (Temperature, Pressure, Level, …) in the data object’s panel. The variable is exported as a Core/QualifiedValue parameter slot on the measured step; the instrumentation activity references it via MeasuredVariableReference and the step via ProcessStepReference.',
  'Export DEXPI XML — the output is validated against the official DEXPI 2.0 XML Schema. Enable Strict mode in the export dialog for the five information-model fidelity checks.',
];

export function IntroGuide({ open, onClose, onLoadExample, onStartTour }: IntroGuideProps) {
  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-labelledby="intro-guide-title"
        style={{
          background: '#fff',
          color: '#222',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          padding: '1.25em',
          maxWidth: '640px',
          width: '90%',
          maxHeight: '85vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.85em',
        }}
      >
        <h3 id="intro-guide-title" style={{ margin: 0 }}>Welcome to BPMN2DEXPI</h3>

        <div style={{ fontSize: '0.9em', color: '#444' }}>
          Model chemical processes as block flow and process flow diagrams
          using BPMN 2.0 notation, and exchange them as DEXPI 2.0-compliant
          XML. Everything runs in your browser &mdash; diagrams are autosaved
          locally and never leave your machine.
        </div>

        <div>
          <strong style={{ fontSize: '0.95em' }}>Model your first PFD</strong>
          <ol style={{ margin: '0.4em 0 0', paddingLeft: '1.4em', fontSize: '0.85em', color: '#444', display: 'flex', flexDirection: 'column', gap: '0.35em' }}>
            {STEPS.map((step, i) => <li key={i}>{step}</li>)}
          </ol>
        </div>

        <div>
          <strong style={{ fontSize: '0.95em' }}>BPMN to DEXPI Process mapping</strong>
          <table style={{ marginTop: '0.4em', width: '100%', borderCollapse: 'collapse', fontSize: '0.85em' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.25em 0.5em 0.25em 0' }}>BPMN element</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ccc', padding: '0.25em 0' }}>DEXPI Process concept</th>
              </tr>
            </thead>
            <tbody>
              {MAPPING.map(([bpmn, dexpi]) => (
                <tr key={bpmn}>
                  <td style={{ padding: '0.25em 0.5em 0.25em 0', borderBottom: '1px solid #eee', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{bpmn}</td>
                  <td style={{ padding: '0.25em 0', borderBottom: '1px solid #eee', color: '#444' }}>{dexpi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75em', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '0.85em' }}>
            <a href="https://doi.org/10.1016/j.dche.2026.100326" target="_blank" rel="noreferrer">Read the paper</a>
            {' · '}
            <a href="https://github.com/skhella/bpmn2dexpi" target="_blank" rel="noreferrer">Documentation</a>
          </div>
          <div style={{ display: 'flex', gap: '0.5em', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={onStartTour}>
              Step-by-step tour
            </button>
            <button className="btn" onClick={onLoadExample}>
              Load the Tennessee Eastman example
            </button>
            <button className="btn" onClick={onClose}>Start modeling</button>
          </div>
        </div>
      </div>
    </div>
  );
}
