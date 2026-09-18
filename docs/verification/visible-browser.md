# Visible browser and control handover

Working-tree feature for version 0.2.11. This is not a published release.

The Browser desktop object opens a separate visible Chrome/Chromium window, using the existing WebDriver backend and a temporary browser profile. The IRIS window displays a real captured screenshot, title and URL. Refresh and completed agent browser calls update the view; it is explicitly labelled as a screenshot, not live video. Linux browser discovery and compatible ChromeDriver are required. Browser-only preview shows the requirement without fake controls or activity.

Take control blocks new agent browser commands immediately, then waits for any already dispatched command. The UI only reports ownership after native handover succeeds. While the user owns the session, agent reads, navigation, typing, clicks, start and close are blocked. Returning control permits future tool calls; stopped agent tasks need their own continuation. UI close also cleans up an unresponsive browser or driver.

Native commands are serialized. A control epoch invalidates actions queued before takeover, even if control has already been returned. Page snapshots assign monotonically distinct opaque element references and retain the actual elements they refer to. Subsequent snapshots and control handovers invalidate old refs; missing, detached or hidden targets fail instead of being reassigned by index. CSS/text targets remain available and should be chosen from a fresh inspection. The screenshot view does not invalidate agent element refs merely by refreshing.

Navigation and vision (which can navigate before capturing) have execution risk in the tool permission policy. Browser dialogs are not automatically accepted. Agent permissions and human takeover are separate checks. Close/start cannot silently replace an existing session.

## Verification

- Native gate test: user ownership refuses automated actions; returning control does not revive an earlier queued epoch.
- Live test, explicitly invoked: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml live_visible_browser_takeover_and_stale_refs -- --ignored`.
- The live test uses a local HTTP fixture and real visible Chrome/ChromeDriver. It verifies actual click and input effects, a PNG screenshot, takeover/return, stale-ref rejection and session cleanup. No account, credentials, paid model or external messages are involved.
- React test: an unresolved handover cannot display "You have control"; failed return preserves ownership and offers close.
- Tool tests: opaque refs reach the backend, paused ownership never triggers HTTP fallback, and navigation-capable tools use execution risk.

The live test found and corrected an existing startup error: ChromeDriver requires `--port=<number>`, while the previous launcher passed the value as a separate argument. Runtime checks therefore cover actual driver startup, not only mocked tool calls.
