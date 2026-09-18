// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalRecordSummary, ApprovalSummaryView } from './ApprovalSummaryView';

function render(element: React.ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(element);
  return host;
}

describe('ApprovalSummaryView', () => {
  it('puts the concrete command and isolation on screen', () => {
    const view = render(
      <ApprovalSummaryView
        toolId="shell.exec"
        toolName="Shell execute"
        risk="execute"
        input={{ command: 'systemctl restart docker', isolation: 'host' }}
        agentName="IRIS"
      />,
    );
    expect(view.textContent).toContain('Run shell command · isolation: host');
    expect(view.textContent).toContain('Command · systemctl restart docker');
    expect(view.querySelector('pre')?.textContent).toContain('systemctl restart docker');
  });

  it('never renders a credential value', () => {
    const view = render(
      <ApprovalSummaryView
        toolId="shell.exec"
        toolName="Shell execute"
        input={{ command: 'curl https://example.com', apiKey: 'sk-live-abcdef123456' }}
      />,
    );
    expect(view.textContent).toContain('curl https://example.com');
    expect(view.textContent).toContain('[REDACTED]');
    expect(view.innerHTML).not.toContain('sk-live-abcdef123456');
  });

  it('renders a stored approval from its own immutable input', () => {
    const view = render(
      <ApprovalRecordSummary
        approval={{
          toolId: 'workspace.delete',
          toolName: 'Delete workspace entry',
          agentName: 'IRIS',
          input: { path: 'notes/private' },
        }}
      />,
    );
    expect(view.textContent).toContain('Delete path · notes/private');
  });

  it('describes a Janitor invocation with both target and command', () => {
    const view = render(
      <ApprovalSummaryView
        toolId="janitor.command"
        toolName="Run Janitor command"
        input={{ target: 'unraid', command: 'docker system prune -af' }}
      />,
    );
    expect(view.textContent).toContain('Run Janitor command on unraid');
    expect(view.textContent).toContain('docker system prune -af');
  });
});
