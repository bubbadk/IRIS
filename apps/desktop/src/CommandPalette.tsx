import { useEffect, useMemo, useRef, useState } from 'react';
import type { IrisObjectType } from '@iris/core';

export interface PaletteCommand {
  type: IrisObjectType | 'welcome';
  label: string;
  description: string;
}

/**
 * ⌘K quick launcher: filters the desktop objects by label or description and opens
 * the chosen one as a window. Keyboard-first (arrows + Enter, Escape to close),
 * click works too.
 */
export function CommandPalette({
  open,
  commands,
  onClose,
  onSelect,
}: {
  open: boolean;
  commands: readonly PaletteCommand[];
  onClose: () => void;
  onSelect: (type: PaletteCommand['type']) => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter(
      (command) =>
        command.label.toLowerCase().includes(needle) ||
        command.description.toLowerCase().includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Focus after mount so the overlay is in the DOM before it takes the keyboard.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  function choose(type: PaletteCommand['type']) {
    onSelect(type);
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter' && results[activeIndex]) {
      event.preventDefault();
      choose(results[activeIndex].type);
    }
  }

  return (
    <div
      className="command-palette-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Quick open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command-palette">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Open an object…"
          aria-label="Search objects"
          autoComplete="off"
        />
        <div className="command-palette-results" role="listbox" aria-label="Objects">
          {results.length === 0 && <p className="command-palette-empty">No matching object.</p>}
          {results.map((command, index) => (
            <button
              key={command.type}
              role="option"
              aria-selected={index === activeIndex}
              className={`command-palette-item ${index === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(command.type)}
            >
              <span className="command-palette-label">{command.label}</span>
              <span className="command-palette-description">{command.description}</span>
            </button>
          ))}
        </div>
        <footer className="command-palette-footer">
          <kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close
        </footer>
      </div>
    </div>
  );
}
