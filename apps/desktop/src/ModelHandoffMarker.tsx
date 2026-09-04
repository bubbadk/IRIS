import type { ConversationMessage } from '@iris/agents';

export function ModelHandoffMarker({ message }: { message: ConversationMessage }) {
  const handoff = message.handoff;
  if (!handoff) return null;
  const timestamp = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(handoff.at));
  return (
    <section className="model-handoff-marker" aria-label="Model handoff">
      <div>
        <span className="model-handoff-label">Model handoff</span>
        <strong>{handoff.from.model} → {handoff.to.model}</strong>
      </div>
      <small title={`${handoff.from.providerId} → ${handoff.to.providerId}`}>{timestamp}</small>
      <p>Saved conversation history continues from here.</p>
    </section>
  );
}
