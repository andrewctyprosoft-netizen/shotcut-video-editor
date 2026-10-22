/** App bar: file commands, undo/redo, export and settings. */
export function TopBar({ state, commands, onUndo, onRedo, onSettings }) {
  const name = state.filePath ? state.filePath.split(/[\\/]/).pop() : 'Untitled';
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">SC</span>
        <span>ShotCut</span>
      </div>
      <nav className="actions">
        <button onClick={commands.newProject} title="New project">New</button>
        <button onClick={commands.open} title="Open project">Open</button>
        <button onClick={() => commands.save(false)} title="Save (Ctrl+S)">Save</button>
        <span className="sep" />
        <button onClick={commands.importMedia} title="Import video or audio">Import media</button>
        <span className="sep" />
        <button onClick={onUndo} disabled={!state.past.length} title="Undo (Ctrl+Z)">Undo</button>
        <button onClick={onRedo} disabled={!state.future.length} title="Redo (Ctrl+Y)">Redo</button>
      </nav>
      <div className="title" title={state.filePath ?? ''}>
        {name}
        {state.dirty && <span className="dirty" title="Unsaved changes"> •</span>}
      </div>
      <nav className="actions end">
        <button onClick={onSettings} title="Tools and preferences">Settings</button>
        <button className="primary" onClick={commands.exportVideo}>Export</button>
      </nav>
    </header>
  );
}
