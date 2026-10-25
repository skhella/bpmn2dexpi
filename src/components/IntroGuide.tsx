/**
 * First-visit guide dialog.
 *
 * Orients visitors who open the hosted app without having read the paper.
 * Kept short on purpose: one sentence on what the tool is, a picture of the
 * BPMN-to-DEXPI mapping, and three ways in (tour, example, blank canvas).
 * The full mapping table is folded away; the how-to lives in the tour.
 * Shown once per browser (localStorage flag, owned by App) and reopenable
 * from the toolbar's Guide button.
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
  ['Task', 'ProcessStep, or an InstrumentationActivity'],
  ['Subprocess', 'ProcessStep with SubProcessSteps'],
  ['Sequence flow', 'Stream (material, energy or information)'],
  ['Ports on an element', 'MaterialPort, energy ports, InformationPort'],
  ['Data object', 'Material library, or a measured process variable'],
  ['Pool', 'ProcessModel'],
];

/**
 * The mapping as a picture: feed → step → product on the main line, an
 * instrument above the step with its variable carrier. Pure SVG, scales
 * with the dialog width.
 */
function MappingStrip() {
  const ink = '#1E293B';
  const label = { fontSize: 11, fill: '#475569', textAnchor: 'middle' as const, fontFamily: 'inherit' };
  const dexpi = { fontSize: 11.5, fill: '#0E7490', textAnchor: 'middle' as const, fontWeight: 600, fontFamily: 'inherit' };
  return (
    <svg viewBox="0 0 560 190" width="100%" role="img" aria-label="BPMN elements and the DEXPI Process concepts they become" style={{ display: 'block', maxWidth: '560px', margin: '0 auto' }}>
      <defs>
        <marker id="ig-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={ink} />
        </marker>
      </defs>
      {/* instrument + variable */}
      <rect x="236" y="14" width="88" height="40" rx="7" fill="#ECFEFF" stroke="#0E7490" strokeWidth="1.8" />
      <text x="280" y="38" style={{ ...label, fill: ink, fontSize: 12 }}>TI 101</text>
      <path d="M280,54 L280,70" stroke="#0E7490" strokeWidth="1.5" strokeDasharray="4 3" />
      <path d="M268,70 h18 l8,8 v22 h-26 z" fill="#fff" stroke="#0E7490" strokeWidth="1.5" />
      <path d="M286,70 v8 h8" fill="none" stroke="#0E7490" strokeWidth="1.5" />
      <path d="M280,100 L280,114" stroke="#0E7490" strokeWidth="1.5" strokeDasharray="4 3" />
      <text x="334" y="38" style={{ ...dexpi, textAnchor: 'start' }}>MeasuringProcessVariable</text>
      <text x="306" y="90" style={{ ...dexpi, textAnchor: 'start' }}>process variable</text>
      {/* main line */}
      <circle cx="60" cy="140" r="17" fill="#fff" stroke={ink} strokeWidth="1.8" />
      <path d="M77,140 L228,140" stroke={ink} strokeWidth="1.8" markerEnd="url(#ig-arrow)" />
      <rect x="232" y="116" width="96" height="48" rx="8" fill="#F8FAFC" stroke={ink} strokeWidth="1.8" />
      <text x="280" y="145" style={{ ...label, fill: ink, fontSize: 13 }}>Reactor</text>
      <path d="M328,140 L478,140" stroke={ink} strokeWidth="1.8" markerEnd="url(#ig-arrow)" />
      <circle cx="500" cy="140" r="17" fill="#fff" stroke={ink} strokeWidth="3.5" />
      {/* ports */}
      <circle cx="232" cy="140" r="3.5" fill="#2DD4BF" />
      <circle cx="328" cy="140" r="3.5" fill="#2DD4BF" />
      {/* captions */}
      <text x="60" y="178" style={dexpi}>Source</text>
      <text x="152" y="130" style={label}>Stream</text>
      <text x="280" y="178" style={dexpi}>ProcessStep</text>
      <text x="403" y="130" style={label}>Stream</text>
      <text x="500" y="178" style={dexpi}>Sink</text>
      <text x="232" y="106" style={{ ...label, fontSize: 10 }}>port</text>
    </svg>
  );
}

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
          borderRadius: '10px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          padding: '1.4em 1.5em 1.2em',
          maxWidth: '620px',
          width: '92%',
          maxHeight: '88vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '1em',
        }}
      >
        <div>
          <h3 id="intro-guide-title" style={{ margin: 0, fontSize: '1.25em' }}>Draw a process. Get DEXPI.</h3>
          <div style={{ marginTop: '0.35em', fontSize: '0.92em', color: '#444', lineHeight: 1.45 }}>
            Model block flow and process flow diagrams in BPMN and exchange them as
            DEXPI 2.0 Process XML. Everything runs in your browser; nothing leaves your machine.
          </div>
        </div>

        <MappingStrip />

        <div style={{ display: 'flex', gap: '0.5em', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={onStartTour}>
            Take the two-minute tour
          </button>
          <button className="btn" onClick={onLoadExample}>
            Open the Tennessee Eastman example
          </button>
          <button className="btn" onClick={onClose}>Start with a blank canvas</button>
        </div>

        <details style={{ fontSize: '0.85em', color: '#444' }}>
          <summary style={{ cursor: 'pointer', color: '#0E7490' }}>Full BPMN → DEXPI mapping</summary>
          <table style={{ marginTop: '0.5em', width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {MAPPING.map(([bpmn, dexpi]) => (
                <tr key={bpmn}>
                  <td style={{ padding: '0.25em 0.75em 0.25em 0', borderBottom: '1px solid #eee', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{bpmn}</td>
                  <td style={{ padding: '0.25em 0', borderBottom: '1px solid #eee' }}>{dexpi}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>

        <div style={{ fontSize: '0.8em', color: '#666', textAlign: 'center' }}>
          <a href="https://doi.org/10.1016/j.dche.2026.100326" target="_blank" rel="noreferrer">Paper</a>
          {' · '}
          <a href="https://github.com/skhella/bpmn2dexpi" target="_blank" rel="noreferrer">Documentation</a>
          {' · '}
          reopen this any time with <strong>Guide</strong>
        </div>
      </div>
    </div>
  );
}
