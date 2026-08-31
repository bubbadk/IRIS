# IRIS v0.2.5 — Subtitle Studio & Intelligent Chunk-Based Translator

IRIS v0.2.5 brings a brand-new, first-class **Subtitle Studio** for translating subtitles (`.srt` and `.vtt`) with zero timestamp drift and natural conversational tone.

---

### ✨ Key Features in v0.2.5

- 💬 **Subtitle Studio Window & Dock Icon**:
  - Direct access via the new Subtitles icon in the left dock or by typing "oversæt undertekster" / "translate srt" in the command bar.
- 🧩 **Sliding Context Chunker (`@iris/subtitles`)**:
  - Splits subtitle files into digestible batches (default 25 cues) while preserving preceding dialogue context so the AI retains character voice, idioms, and pronouns.
- ⏱️ **Deterministic SRT/VTT Reassembly**:
  - Reassembles the final subtitle file with 100% of original start/end timestamps and index order intact.
- ⚡ **Dual-Pane Live Translation Visualizer**:
  - Side-by-side view with live progress, pause/resume controls, and direct 1-click download of translated `.srt` and `.vtt` files.
- 🚀 **1-Click Auto-Updater**:
  - Immediate update notification and seamless background install via `@tauri-apps/plugin-updater`.

---

### 📦 Release Assets & Manifests
- `iris-linux-x86_64-v0.2.5.tar.gz`: Linux x86_64 binary.
- `latest.json`: Auto-updater manifest.
