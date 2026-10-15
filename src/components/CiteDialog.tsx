/**
 * Citation dialog, opened from the footer's "Cite" affordance.
 *
 * Gives users a ready-to-paste reference for the article the tool
 * accompanies: the formatted citation, a BibTeX block with a copy
 * button, and a pointer at the repository's CITATION.cff for citing
 * the software itself. Static content — the article metadata mirrors
 * the README's "Based on Research" section.
 */
import { useState } from 'react';

interface CiteDialogProps {
  open: boolean;
  onClose: () => void;
}

const DOI = '10.1016/j.dche.2026.100326';
const DOI_URL = `https://doi.org/${DOI}`;

const BIBTEX = `@article{Khella2026bpmn2dexpi,
  author  = {Khella, Shady and Schichtel, Markus and Esche, Erik and Weichhardt, Frauke and Repke, Jens-Uwe},
  title   = {Representing {DEXPI} {Process} in {BPMN} 2.0 for graphical modeling and exchange of block flow and process flow diagrams},
  journal = {Digital Chemical Engineering},
  year    = {2026},
  doi     = {${DOI}},
  note    = {In press}
}`;

export function CiteDialog({ open, onClose }: CiteDialogProps) {
  const [copied, setCopied] = useState(false);

  // Clear the transient "Copied" confirmation on the way out, so the
  // dialog reopens in its resting state (the component stays mounted
  // while closed).
  const handleClose = () => {
    setCopied(false);
    onClose();
  };

  if (!open) return null;

  const copyBibtex = async () => {
    try {
      await navigator.clipboard.writeText(BIBTEX);
      setCopied(true);
    } catch {
      // Clipboard API unavailable (insecure context, permissions) —
      // select the block so a manual copy is one keystroke away.
      const pre = document.getElementById('cite-bibtex');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  };

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
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        role="dialog"
        aria-labelledby="cite-dialog-title"
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
        <h3 id="cite-dialog-title" style={{ margin: 0 }}>Cite BPMN2DEXPI</h3>

        <div style={{ fontSize: '0.9em', color: '#444' }}>
          If you use this tool in your work, please cite the article:
        </div>

        <div style={{ fontSize: '0.9em', color: '#222', padding: '0.6em 0.8em', background: '#f6f8f9', borderLeft: '3px solid #3498db', borderRadius: '3px' }}>
          Shady Khella, Markus Schichtel, Erik Esche, Frauke Weichhardt, and
          Jens-Uwe Repke. <em>Representing DEXPI Process in BPMN 2.0 for
          graphical modeling and exchange of block flow and process flow
          diagrams</em>. Digital Chemical Engineering (2026), in press.
          DOI: <a href={DOI_URL} target="_blank" rel="noreferrer">{DOI}</a>.
        </div>

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4em' }}>
            <strong style={{ fontSize: '0.9em' }}>BibTeX</strong>
            <button className="btn" onClick={copyBibtex} style={{ fontSize: '0.8em', padding: '0.25rem 0.6rem' }}>
              {copied ? 'Copied' : 'Copy BibTeX'}
            </button>
          </div>
          <pre
            id="cite-bibtex"
            style={{
              margin: 0,
              padding: '0.7em',
              background: '#f5f5f5',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontSize: '0.75em',
              lineHeight: 1.45,
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >{BIBTEX}</pre>
        </div>

        <div style={{ fontSize: '0.8em', color: '#666' }}>
          To cite the software itself, use the citation metadata in the
          repository&apos;s{' '}
          <a href="https://github.com/skhella/bpmn2dexpi/blob/main/CITATION.cff" target="_blank" rel="noreferrer">CITATION.cff</a>.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={handleClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
