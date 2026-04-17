/**
 * TransformerLogger
 * Collects warnings emitted during a transformation and surfaces them
 * to the caller.  In browser contexts it also writes to console.warn.
 */
export class TransformerLogger {
  private _warnings: string[] = [];
  private _errors: string[] = [];

  warn(message: string): void {
    this._warnings.push(message);
    // Surface to browser / node console as well
    if (typeof console !== 'undefined') {
      console.warn(`[bpmn2dexpi] ${message}`);
    }
  }

  error(message: string): void {
    this._errors.push(message);
    if (typeof console !== 'undefined') {
      console.error(`[bpmn2dexpi] ${message}`);
    }
  }

  get warnings(): readonly string[] {
    return this._warnings;
  }

  get errors(): readonly string[] {
    return this._errors;
  }

  reset(): void {
    this._warnings = [];
    this._errors = [];
  }
}
