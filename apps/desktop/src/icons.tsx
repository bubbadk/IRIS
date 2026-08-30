import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function IrisMark(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <path d="M12 3.5v4.3M20.5 12h-4.3M12 20.5v-4.3M3.5 12h4.3" />
    </svg>
  );
}

export function HomeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m4 10 8-6 8 6v9H7v-7h10v7" />
    </svg>
  );
}
export function AgentsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="8" r="2.2" />
      <path d="M4 19c.7-3.1 2.5-4.8 5-4.8s4.3 1.7 5 4.8M14.3 14.2c2.8-.7 4.8.8 5.7 3.8" />
    </svg>
  );
}
export function ProjectsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="9" r="2" />
      <circle cx="9" cy="18" r="2" />
      <path d="m7.8 6.8 8.3 1.5M7 7.8l1.3 8.3M16.7 10.5l-6.2 6" />
    </svg>
  );
}
export function WorkspaceIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3.5 7.5h6l1.8 2H20.5v8.8a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7V7.5Z" />
      <path d="M3.5 7.5V5.7A1.7 1.7 0 0 1 5.2 4h4.2l1.8 2h7.6a1.7 1.7 0 0 1 1.7 1.7v1.8" />
    </svg>
  );
}
export function ModelsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M8 9h8M8 12h5M8 15h7" />
    </svg>
  );
}
export function MemoryIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 6.5a4 4 0 0 1 7.4-2.1A4.2 4.2 0 0 1 19 8.5a4 4 0 0 1-1.5 7.7A4.2 4.2 0 0 1 10 18a4.2 4.2 0 0 1-5-4.1A4.2 4.2 0 0 1 8 6.5Z" />
      <path d="M10 7.5v9M14.5 6.5c-2 1.1-2.2 3.2-.4 4.4-2 1.1-2.1 3.2-.6 4.4" />
    </svg>
  );
}
export function SkillsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m12 3 2.2 4.7L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.3L12 3Z" />
      <path d="m18 15 .9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15Z" />
    </svg>
  );
}
export function ConnectionsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="4.5" width="17" height="6.4" rx="2" />
      <rect x="3.5" y="13.1" width="17" height="6.4" rx="2" />
      <path d="M7 7.7h.01M7 16.3h.01" />
      <path d="M10.5 7.7h6M10.5 16.3h6" />
    </svg>
  );
}
export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7.6 7.6 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5l-.4 3.1a8 8 0 0 0-1.7 1L5 6.1 3 9.5 5.1 11a7.6 7.6 0 0 0 0 2L3 14.5l2 3.4 2.4-1a8 8 0 0 0 1.7 1l.4 3.1h5l.4-3.1a8 8 0 0 0 1.7-1l2.4 1 2-3.4-2.1-1.5c.1-.3.1-.7.1-1Z" />
    </svg>
  );
}
export function CloseIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}
export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}
