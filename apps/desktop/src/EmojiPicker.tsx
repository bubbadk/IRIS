import { useState, useMemo, useRef, useEffect } from 'react';

export type EmojiItem = {
  emoji: string;
  name: string;
  category: 'smileys' | 'agents' | 'tools' | 'symbols';
  keywords: string[];
};

export const EMOJI_LIST: EmojiItem[] = [
  // Smileys & Reactions
  { emoji: '😀', name: 'grinning', category: 'smileys', keywords: ['smile', 'happy', 'face'] },
  { emoji: '😃', name: 'smiley', category: 'smileys', keywords: ['happy', 'joy'] },
  { emoji: '😄', name: 'smile', category: 'smileys', keywords: ['laugh', 'happy'] },
  { emoji: '😁', name: 'beam', category: 'smileys', keywords: ['grin', 'smile'] },
  { emoji: '😊', name: 'blush', category: 'smileys', keywords: ['proud', 'smile'] },
  { emoji: '😎', name: 'cool', category: 'smileys', keywords: ['sunglasses', 'awesome'] },
  { emoji: '🤔', name: 'thinking', category: 'smileys', keywords: ['reasoning', 'think', 'ponder'] },
  { emoji: '🧐', name: 'monocle', category: 'smileys', keywords: ['inspect', 'curious', 'analyze'] },
  { emoji: '🤩', name: 'star-struck', category: 'smileys', keywords: ['excited', 'wow'] },
  { emoji: '🥳', name: 'party', category: 'smileys', keywords: ['celebrate', 'done', 'cheer'] },
  { emoji: '🙌', name: 'hands up', category: 'smileys', keywords: ['cheer', 'success', 'praise'] },
  { emoji: '👍', name: 'thumbs up', category: 'smileys', keywords: ['approve', 'agree', 'yes', 'ok'] },
  { emoji: '👎', name: 'thumbs down', category: 'smileys', keywords: ['disapprove', 'no'] },
  { emoji: '👏', name: 'clap', category: 'smileys', keywords: ['applause', 'good job'] },
  { emoji: '🔥', name: 'fire', category: 'smileys', keywords: ['hot', 'fast', 'lit', 'awesome'] },
  { emoji: '💡', name: 'lightbulb', category: 'smileys', keywords: ['idea', 'insight', 'smart'] },
  { emoji: '✨', name: 'sparkles', category: 'smileys', keywords: ['magic', 'new', 'clean', 'ai'] },
  { emoji: '❤️', name: 'heart', category: 'smileys', keywords: ['love', 'favorite'] },
  { emoji: '🚀', name: 'rocket', category: 'smileys', keywords: ['deploy', 'launch', 'speed', 'fast'] },

  // Agents & Tech
  { emoji: '🤖', name: 'robot', category: 'agents', keywords: ['agent', 'bot', 'ai', 'cortex'] },
  { emoji: '🛸', name: 'ufo', category: 'agents', keywords: ['iris', 'desklet', 'flying', 'alien'] },
  { emoji: '🧠', name: 'brain', category: 'agents', keywords: ['cortex', 'memory', 'intelligence', 'mind'] },
  { emoji: '👾', name: 'alien monster', category: 'agents', keywords: ['game', 'pixel', 'retro'] },
  { emoji: '⚡', name: 'lightning', category: 'agents', keywords: ['fast', 'power', 'action', 'energy'] },
  { emoji: '🛰️', name: 'satellite', category: 'agents', keywords: ['space', 'telemetry', 'remote'] },
  { emoji: '🔮', name: 'crystal ball', category: 'agents', keywords: ['future', 'predict', 'oracle'] },
  { emoji: '🧙‍♂️', name: 'wizard', category: 'agents', keywords: ['expert', 'magic', 'senior'] },
  { emoji: '🧑‍💻', name: 'technologist', category: 'agents', keywords: ['coder', 'developer', 'hacker'] },
  { emoji: '🕵️', name: 'detective', category: 'agents', keywords: ['researcher', 'search', 'investigate'] },
  { emoji: '🧹', name: 'broom', category: 'agents', keywords: ['janitor', 'clean', 'tidy', 'maintenance'] },

  // Tools & Operations
  { emoji: '📁', name: 'folder', category: 'tools', keywords: ['file', 'workspace', 'directory'] },
  { emoji: '📄', name: 'document', category: 'tools', keywords: ['file', 'page', 'text'] },
  { emoji: '💻', name: 'laptop', category: 'tools', keywords: ['computer', 'pc', 'code'] },
  { emoji: '🖥️', name: 'desktop', category: 'tools', keywords: ['screen', 'display', 'workspace'] },
  { emoji: '🛠️', name: 'tools', category: 'tools', keywords: ['hammer', 'wrench', 'build', 'fix'] },
  { emoji: '🔧', name: 'wrench', category: 'tools', keywords: ['configure', 'settings', 'fix'] },
  { emoji: '⚙️', name: 'gear', category: 'tools', keywords: ['system', 'config', 'settings'] },
  { emoji: '🛡️', name: 'shield', category: 'tools', keywords: ['security', 'permission', 'safe', 'diff'] },
  { emoji: '🔒', name: 'lock', category: 'tools', keywords: ['auth', 'key', 'secret', 'secure'] },
  { emoji: '💾', name: 'floppy disk', category: 'tools', keywords: ['save', 'memory', 'persist'] },
  { emoji: '📦', name: 'package', category: 'tools', keywords: ['bundle', 'archive', 'tar', 'deb'] },
  { emoji: '🐳', name: 'whale', category: 'tools', keywords: ['docker', 'container', 'sandbox'] },
  { emoji: '🌐', name: 'globe', category: 'tools', keywords: ['web', 'network', 'internet', 'url'] },
  { emoji: '🔍', name: 'magnifying glass', category: 'tools', keywords: ['search', 'find', 'lookup'] },

  // Status & Symbols
  { emoji: '✅', name: 'check mark', category: 'symbols', keywords: ['done', 'ok', 'pass', 'success'] },
  { emoji: '❌', name: 'cross mark', category: 'symbols', keywords: ['fail', 'deny', 'error', 'cancel'] },
  { emoji: '⚠️', name: 'warning', category: 'symbols', keywords: ['warn', 'caution', 'alert'] },
  { emoji: '💬', name: 'speech bubble', category: 'symbols', keywords: ['chat', 'message', 'talk'] },
  { emoji: '📢', name: 'loudspeaker', category: 'symbols', keywords: ['announcement', 'bridge', 'broadcast'] },
  { emoji: '🎯', name: 'target', category: 'symbols', keywords: ['goal', 'objective', 'task'] },
  { emoji: '🌿', name: 'herb', category: 'symbols', keywords: ['eco', 'calm', 'ready', 'idle'] },
  { emoji: '💎', name: 'gem', category: 'symbols', keywords: ['premium', 'valuable', 'diamond'] },
];

export function EmojiPicker({
  onSelect,
  onClose,
  darkMode = false,
}: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  darkMode?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'smileys' | 'agents' | 'tools' | 'symbols'>('all');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const filteredEmojis = useMemo(() => {
    const query = search.trim().toLowerCase();
    return EMOJI_LIST.filter((item) => {
      const matchesTab = activeTab === 'all' || item.category === activeTab;
      if (!matchesTab) return false;
      if (!query) return true;
      return (
        item.name.toLowerCase().includes(query) ||
        item.keywords.some((k) => k.toLowerCase().includes(query)) ||
        item.emoji.includes(query)
      );
    });
  }, [search, activeTab]);

  return (
    <div
      ref={containerRef}
      className={`emoji-picker-popover ${darkMode ? 'dark-mode' : ''}`}
      role="dialog"
      aria-label="Emoji Picker"
    >
      <div className="emoji-picker-header">
        <input
          type="text"
          className="emoji-search-input"
          placeholder="Search emojis (e.g. smile, rocket, bot)…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <button
          type="button"
          className="emoji-close-btn"
          onClick={onClose}
          aria-label="Close emoji picker"
        >
          ×
        </button>
      </div>

      <div className="emoji-category-tabs">
        <button
          type="button"
          className={`emoji-tab ${activeTab === 'all' ? 'active' : ''}`}
          onClick={() => setActiveTab('all')}
        >
          All
        </button>
        <button
          type="button"
          className={`emoji-tab ${activeTab === 'smileys' ? 'active' : ''}`}
          onClick={() => setActiveTab('smileys')}
          title="Smileys & Reactions"
        >
          😀 Smileys
        </button>
        <button
          type="button"
          className={`emoji-tab ${activeTab === 'agents' ? 'active' : ''}`}
          onClick={() => setActiveTab('agents')}
          title="Agents & Tech"
        >
          🤖 Agents
        </button>
        <button
          type="button"
          className={`emoji-tab ${activeTab === 'tools' ? 'active' : ''}`}
          onClick={() => setActiveTab('tools')}
          title="Tools & Work"
        >
          🛠️ Tools
        </button>
        <button
          type="button"
          className={`emoji-tab ${activeTab === 'symbols' ? 'active' : ''}`}
          onClick={() => setActiveTab('symbols')}
          title="Symbols & Status"
        >
          ✨ Symbols
        </button>
      </div>

      <div className="emoji-grid">
        {filteredEmojis.length > 0 ? (
          filteredEmojis.map((item) => (
            <button
              key={`${item.name}-${item.emoji}`}
              type="button"
              className="emoji-grid-btn"
              title={`${item.name} (${item.emoji})`}
              onClick={() => {
                onSelect(item.emoji);
                onClose();
              }}
            >
              {item.emoji}
            </button>
          ))
        ) : (
          <div className="emoji-empty-state">No emojis found</div>
        )}
      </div>
    </div>
  );
}

export function QuickReactionsBar({
  onReact,
  activeReactions = {},
}: {
  onReact: (emoji: string) => void;
  activeReactions?: Record<string, number>;
}) {
  const quickList = ['👍', '🔥', '💡', '🚀', '❤️', '🤖'];

  return (
    <div className="quick-reactions-bar">
      {quickList.map((emoji) => {
        const count = activeReactions[emoji] || 0;
        return (
          <button
            key={emoji}
            type="button"
            className={`quick-reaction-btn ${count > 0 ? 'is-active' : ''}`}
            onClick={() => onReact(emoji)}
            title={`React with ${emoji}`}
          >
            <span className="reaction-emoji">{emoji}</span>
            {count > 0 && <span className="reaction-count">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
