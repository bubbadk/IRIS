import { useCallback, useEffect, useRef, useState } from 'react';
import { browserSession, subscribeBrowser, type BrowserInspection } from './browserSession';
export function BrowserState() {
  const [inspection, setInspection] = useState<BrowserInspection | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [capturedAt, setCapturedAt] = useState('');
  const [address, setAddress] = useState('');
  const sequence = useRef(0);
  const available = browserSession.available();
  const tabs = inspection?.tabs ?? [];
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const next = await browserSession.inspect();
      if (current !== sequence.current) return;
      setInspection(next);
      setCapturedAt(new Date().toLocaleTimeString());
      setError('');
    } catch (failure) {
      if (current === sequence.current) setError(String(failure));
    }
  }, []);
  useEffect(() => {
    if (!available) return;
    const reload = () => void refresh();
    reload();
    const unsubscribe = subscribeBrowser(reload);
    window.addEventListener('focus', reload);
    return () => {
      sequence.current++;
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [available, refresh]);
  useEffect(() => {
    if (inspection?.page?.url) setAddress(inspection.page.url);
  }, [inspection?.page?.url]);
  async function action(kind: 'start' | 'takeControl' | 'returnControl' | 'close') {
    sequence.current++;
    setBusy(kind);
    setError('');
    try {
      await browserSession[kind]();
      await refresh();
    } catch (failure) {
      if (kind === 'takeControl') setInspection(null);
      setError(String(failure));
    } finally {
      setBusy('');
    }
  }
  async function navigate() {
    const url = address.trim();
    if (!url) return;
    sequence.current++;
    setBusy('navigate');
    setError('');
    try {
      await browserSession.navigate(url);
      await refresh();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy('');
    }
  }
  async function switchTab(tabId: string) {
    sequence.current++;
    setBusy('switchTab');
    setError('');
    try {
      await browserSession.switchTab(tabId);
      await refresh();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="browser-state">
      <header>
        <p className="eyebrow">Browser</p>
        <h2>See the work. Take the controls.</h2>
        <p>
          IRIS opens a separate, visible Chromium window. Work directly in that window while agent
          actions are paused.
        </p>
      </header>
      {!available ? (
        <p>
          The automated browser requires the native desktop app, Chrome or Chromium, and a
          compatible ChromeDriver installation.
        </p>
      ) : (
        <>
          <div className="browser-toolbar">
            <button
              className="soft-button primary-button"
              disabled={Boolean(busy) || Boolean(inspection?.running)}
              onClick={() => void action('start')}
            >
              Open visible browser
            </button>
            <button className="row-button" disabled={Boolean(busy)} onClick={() => void refresh()}>
              Refresh view
            </button>
            <button
              className="row-button"
              disabled={Boolean(busy)}
              onClick={() => void action('close')}
            >
              Close browser session
            </button>
          </div>
          {busy && (
            <p role="status">
              {busy === 'takeControl'
                ? 'Pausing agent actions. Waiting for the already dispatched browser action to finish before handing control to you…'
                : 'Waiting for the browser…'}
            </p>
          )}
          {inspection?.running ? (
            <>
              <div className="browser-control-card">
                <strong>
                  {inspection.userControl
                    ? 'You have control'
                    : 'Agent actions are allowed by your tool permissions'}
                </strong>
                <p>
                  {inspection.userControl
                    ? 'Agent browser tools are blocked. Use the visible browser directly, then explicitly return control when you are ready.'
                    : 'Take control before typing or clicking in the browser yourself. An already dispatched action may finish before handover completes.'}
                </p>
                <button
                  className="soft-button"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void action(inspection.userControl ? 'returnControl' : 'takeControl')
                  }
                >
                  {inspection.userControl ? 'Return control to agents' : 'Take control'}
                </button>
                {!inspection.visible && (
                  <p>
                    This session was started headless. Close it and open a visible browser to
                    interact directly.
                  </p>
                )}
              </div>
              {inspection.page && (
                <>
                  {tabs.length > 1 && (
                    <div className="browser-tabs" aria-label="Browser tabs">
                      {tabs.map((tab, index) => (
                        <button
                          type="button"
                          key={tab.id}
                          className="row-button"
                          aria-pressed={tab.active}
                          disabled={Boolean(busy) || inspection.userControl || tab.active}
                          onClick={() => void switchTab(tab.id)}
                        >
                          Tab {index + 1}
                          {tab.active ? ' · current' : ''}
                        </button>
                      ))}
                    </div>
                  )}
                  <form
                    className="browser-address"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void navigate();
                    }}
                  >
                    <label>
                      Address
                      <input
                        value={address}
                        disabled={Boolean(busy) || inspection.userControl}
                        onChange={(event) => setAddress(event.target.value)}
                        placeholder="https://example.com"
                        aria-label="Browser address"
                      />
                    </label>
                    <button
                      className="row-button"
                      type="submit"
                      disabled={Boolean(busy) || inspection.userControl || !address.trim()}
                    >
                      Go
                    </button>
                  </form>
                  <div className="browser-location">
                    <strong>{inspection.page.title || 'Untitled page'}</strong>
                    <span>{inspection.page.url}</span>
                  </div>
                </>
              )}
              <small>
                Captured at {capturedAt}. This is a screenshot, not a live video. Refresh after
                manual changes; the separate browser window shows the live page.
              </small>
              {inspection.screenshot && (
                <img
                  className="browser-capture"
                  src={inspection.screenshot}
                  alt="Most recent captured browser page"
                />
              )}
            </>
          ) : inspection ? (
            <p>No automated browser session is running.</p>
          ) : (
            <p>
              {error
                ? 'Browser status is unavailable. Refresh the view or close the session.'
                : 'Checking the browser session…'}
            </p>
          )}
          <small>
            The session uses a separate temporary profile. Login state is not shared with your
            everyday browser or reused by a new session. The address field uses the same
            permission-controlled browser session and is disabled while you have control. Returning
            control permits future tool calls; it does not restart a stopped agent task.
          </small>
        </>
      )}
      {error && (
        <p className="workspace-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
