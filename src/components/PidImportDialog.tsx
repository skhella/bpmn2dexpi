/**
 * Shown when "Import DEXPI XML" is given a P&ID instead of a DEXPI Process
 * document: a DEXPI 2.0 Plant model, or a Proteus XML file (DEXPI 1.x).
 *
 * Both are valid DEXPI, just a different part of the standard than this
 * tool draws, so the message explains the difference in plain words and
 * points at what the file needs instead. No third-party product is named —
 * the docs cite the standard, not tools.
 */

interface PidImportDialogProps {
  kind: 'plant' | 'proteus';
  /** Short factual observation the detection rests on (root element, imported model, object type). */
  detail: string;
  fileName?: string;
  onClose: () => void;
}

export function PidImportDialog({ kind, detail, fileName, onClose }: PidImportDialogProps) {
  const detected = kind === 'plant'
    ? 'a DEXPI 2.0 Plant model'
    : 'a Proteus XML P&ID, the DEXPI 1.x format';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pid-import-dialog-title"
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
        style={{
          background: '#fff',
          color: '#222',
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
          padding: '1.25em',
          maxWidth: '520px',
          width: '90%',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.85em',
        }}
      >
        <h3 id="pid-import-dialog-title" style={{ margin: 0 }}>
          This is a P&amp;ID, not a DEXPI Process file
        </h3>

        <p style={{ margin: 0, fontSize: '0.9em', lineHeight: 1.5 }}>
          This app models block flow and process flow diagrams (BFD/PFD) and
          exchanges them as DEXPI Process files, which describe process steps,
          streams, ports and materials.
        </p>

        <p style={{ margin: 0, fontSize: '0.9em', lineHeight: 1.5 }}>
          A P&amp;ID — a DEXPI Plant model, or the older Proteus XML — describes
          equipment, piping and instrumentation at the engineering-detail level,
          which this tool does not draw. The file you chose
          {fileName ? <> (<code>{fileName}</code>)</> : null} was detected as{' '}
          {detected}. Open it in a P&amp;ID viewer instead; to edit a process
          here, import a DEXPI Process document or start a new diagram.
        </p>

        <div style={{ fontSize: '0.8em', color: '#555' }}>
          Detected from: {detail}.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} className="btn btn-primary" autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
