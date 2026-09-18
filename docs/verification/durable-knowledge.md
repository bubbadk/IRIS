# Durable project knowledge and preferences

Working-tree feature for version 0.2.11, not a published release.

Memory → Knowledge & preferences contains global entries. Projects → Project knowledge & preferences contains project-scoped entries. Facts and preferences carry a topic, content, source/reference, optional expiry and originating user or agent turn/tool call. Agent proposals and user drafts are inactive until explicitly approved. Approval permits contextual use; it does not certify the factual correctness of the content.

Creating a revision makes a new proposal and leaves the old active content untouched. Approval displays the active entries it will replace and atomically archives them. Matching is deterministic by scope, kind and normalized topic, plus the explicit previous-entry identity. It is not semantic contradiction detection. Historical content is retained. Native SQLite transactions reject changed review revisions and changed conflict sets, including competing desktop windows. Invalid stored data and durable write failures are surfaced.

Each new turn with saved-memory read access uses up to 20 active, unexpired entries, preferences first and then newer entries. Ordinary agent turns receive global knowledge as a distinct, inspectable context source; the context repository retains the actual entry identities, revisions and provenance. Project turns combine global and selected-project entries, preferring project values on the same kind/topic, and include the actual selected entries in the saved worker prompt. Other projects' entries are excluded. Current task instructions and permission decisions take precedence. Knowledge is contextual data and never grants execution permission.

Expired, proposed and archived entries are excluded; omissions beyond the context limit are reported. Running turns and saved checkpoints retain what they previously saw. New turns refresh knowledge from storage, and the prompt identifies the current snapshot as replacing older saved-knowledge versions. Corrupt or unavailable knowledge storage blocks affected context construction rather than silently dropping approved constraints.

The agent tools `knowledge.propose` and `knowledge.read` use the existing tool permission policy. Proposals require a real turn and tool call, validate project identities, and cannot activate or overwrite knowledge. Reads require memory read access. Agents cannot invoke human approval through these tools.

## Verification

- Domain: inactive/expired/archive exclusion, topic conflict review, stale revisions, scope isolation, project precedence, source provenance, UTF-8 size and context omissions.
- Repository: concurrent conflicting approvals have one winner; both proposals remain, and failed durable writes preserve the active entry.
- Context: no reads without memory access, fresh revisions on new turns, exclusion of unrelated project data, visible store failure, exact context-source round-trip through persistence.
- UI: proposal → approval → revision → conflict replacement retains the old content in history.
- Tools: actual agent proposals stay inactive; access checks, project identity and provenance requirements cannot be bypassed by input fields.
- Browser: the actual app's global and project flows, approval, conflict replacement and reload were exercised in an isolated profile with labelled test content.
- Native startup: two boots with SQLite integrity and retained memory, documents and approved knowledge. No paid model requests or external messages were sent.
