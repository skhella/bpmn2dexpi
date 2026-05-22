import React, { useEffect, useState } from 'react';
import type { Neo4jConfig } from '../utils/neo4jExporter';
import './Neo4jExportModal.css';

interface Neo4jExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onExport: (config: Neo4jConfig, options: { clearDatabase: boolean }) => void;
  isExporting: boolean;
  progress: { current: number; total: number; stage: string } | null;
}

export const Neo4jExportModal: React.FC<Neo4jExportModalProps> = ({
  isOpen,
  onClose,
  onExport,
  isExporting,
  progress
}) => {
  const SESSION_PASSWORD_KEY = 'neo4j_password_session';

  // Storage helpers — wrap every access so disabled-storage contexts
  // (Safari ITP private mode, sandboxed iframes, embedded WebViews
  // with storage policies) don't crash the modal at render time.
  const safeLocalGet = (k: string) => {
    try { return localStorage.getItem(k); } catch { return null; }
  };
  const safeSessionGet = (k: string) => {
    try { return sessionStorage.getItem(k); } catch { return null; }
  };
  const safeLocalSet = (k: string, v: string) => {
    try { localStorage.setItem(k, v); } catch { /* storage disabled or full */ }
  };
  const safeLocalRemove = (k: string) => {
    try { localStorage.removeItem(k); } catch { /* storage disabled */ }
  };
  const safeSessionSet = (k: string, v: string) => {
    try { sessionStorage.setItem(k, v); } catch { /* storage disabled */ }
  };
  const safeSessionRemove = (k: string) => {
    try { sessionStorage.removeItem(k); } catch { /* storage disabled */ }
  };

  const [config, setConfig] = useState<Neo4jConfig>({
    uri: safeLocalGet('neo4j_uri') || 'bolt://localhost:7687',
    user: safeLocalGet('neo4j_user') || 'neo4j',
    password: safeSessionGet(SESSION_PASSWORD_KEY) || '',
    database: safeLocalGet('neo4j_database') || 'neo4j'
  });
  const [clearDatabase, setClearDatabase] = useState(true);
  const [saveCredentials, setSaveCredentials] = useState(true);

  useEffect(() => {
    // Remove any previously persisted password from older versions.
    safeLocalRemove('neo4j_password');
  }, []);

  useEffect(() => {
    if (config.password) {
      safeSessionSet(SESSION_PASSWORD_KEY, config.password);
      return;
    }
    safeSessionRemove(SESSION_PASSWORD_KEY);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.password]);

  if (!isOpen) return null;

  const handleExport = () => {
    // Save credentials if requested
    if (saveCredentials) {
      safeLocalSet('neo4j_uri', config.uri);
      safeLocalSet('neo4j_user', config.user);
      safeLocalSet('neo4j_database', config.database || 'neo4j');
    }

    onExport(config, { clearDatabase });
  };

  return (
    <div className="neo4j-modal-overlay" onClick={onClose}>
      <div className="neo4j-modal" onClick={e => e.stopPropagation()}>
        <div className="neo4j-modal-header">
          <h2>Export to Neo4j</h2>
          <button className="neo4j-modal-close" onClick={onClose}>×</button>
        </div>
        
        <div className="neo4j-modal-body">
          <div className="neo4j-form-group">
            <label htmlFor="neo4j-uri">Connection URI</label>
            <input
              id="neo4j-uri"
              type="text"
              value={config.uri}
              onChange={e => setConfig({ ...config, uri: e.target.value })}
              placeholder="bolt://localhost:7687"
              disabled={isExporting}
            />
            <span className="neo4j-help-text">
              For local: bolt://localhost:7687 | For Aura: neo4j+s://xxx.databases.neo4j.io
            </span>
          </div>
          
          <div className="neo4j-form-row">
            <div className="neo4j-form-group">
              <label htmlFor="neo4j-user">Username</label>
              <input
                id="neo4j-user"
                type="text"
                value={config.user}
                onChange={e => setConfig({ ...config, user: e.target.value })}
                placeholder="neo4j"
                disabled={isExporting}
              />
            </div>
            
            <div className="neo4j-form-group">
              <label htmlFor="neo4j-password">Password</label>
              <input
                id="neo4j-password"
                type="password"
                value={config.password}
                onChange={e => setConfig({ ...config, password: e.target.value })}
                placeholder="Enter password"
                disabled={isExporting}
              />
              <span className="neo4j-help-text">
                Password is kept only for this browser tab session.
              </span>
            </div>
          </div>
          
          <div className="neo4j-form-group">
            <label htmlFor="neo4j-database">Database</label>
            <input
              id="neo4j-database"
              type="text"
              value={config.database || ''}
              onChange={e => setConfig({ ...config, database: e.target.value })}
              placeholder="neo4j"
              disabled={isExporting}
            />
          </div>
          
          <div className="neo4j-options">
            <label className="neo4j-checkbox">
              <input
                type="checkbox"
                checked={clearDatabase}
                onChange={e => setClearDatabase(e.target.checked)}
                disabled={isExporting}
              />
              <span>Clear existing data before import</span>
            </label>
            
            <label className="neo4j-checkbox">
              <input
                type="checkbox"
                checked={saveCredentials}
                onChange={e => setSaveCredentials(e.target.checked)}
                disabled={isExporting}
              />
              <span>Remember connection settings (excluding password)</span>
            </label>
          </div>
          
          {progress && (
            <div className="neo4j-progress">
              <div className="neo4j-progress-bar">
                <div 
                  className="neo4j-progress-fill" 
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                ></div>
              </div>
              <span className="neo4j-progress-text">{progress.stage}</span>
            </div>
          )}
          
          <div className="neo4j-info">
            <h4>What will be exported:</h4>
            <ul>
              <li><strong>ProcessStep</strong> nodes with type labels (e.g., :ReactingChemicals, :Separating)</li>
              <li><strong>Port</strong> nodes with direction (In/Out)</li>
              <li><strong>Stream</strong> nodes with flow properties (mass flow, temperature)</li>
              <li><strong>MaterialTemplate</strong>, <strong>MaterialComponent</strong>, <strong>MaterialState</strong> nodes</li>
              <li><strong>FLOWS_TO</strong> relationships between process steps</li>
              <li><strong>CONTAINS</strong> relationships for subprocess hierarchy</li>
              <li><strong>HAS_MATERIAL_STATE</strong> relationships for streams</li>
            </ul>
          </div>
        </div>
        
        <div className="neo4j-modal-footer">
          <button 
            className="btn" 
            onClick={onClose}
            disabled={isExporting}
          >
            Cancel
          </button>
          <button 
            className="btn btn-primary" 
            onClick={handleExport}
            disabled={isExporting || !config.password}
          >
            {isExporting ? 'Exporting...' : 'Export to Neo4j'}
          </button>
        </div>
      </div>
    </div>
  );
};
