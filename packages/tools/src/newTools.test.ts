import { describe, expect, it } from 'vitest';
import { createWebSearchTool, createWebExtractTool, cleanHtmlToMarkdown } from './webTools';
import { createImageGenerationTool } from './imageTools';
import {
  createBrowserNavigateTool,
  createBrowserClickTool,
  createBrowserTypeTool,
  createBrowserVisionTool,
} from './browserTools';

describe('Web Tools', () => {
  it('cleans HTML into readable Markdown', () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <script>console.log("bad");</script>
          <h1>Hello World</h1>
          <p>This is a <a href="https://example.com">link</a> to somewhere.</p>
          <ul>
            <li>First point</li>
            <li>Second point</li>
          </ul>
        </body>
      </html>
    `;
    const md = cleanHtmlToMarkdown(html);
    expect(md).toContain('# Hello World');
    expect(md).toContain('This is a [link](https://example.com) to somewhere.');
    expect(md).toContain('- First point');
    expect(md).not.toContain('console.log');
  });

  it('runs web.search with mock fetch', async () => {
    const mockHtml = `
      <div class="result">
        <a class="result__url" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.ycombinator.com"></a>
        <h2 class="result__title"><a href="#">Hacker News</a></h2>
        <a class="result__snippet">Social news website focusing on computer science.</a>
      </div>
    `;
    const mockFetch = async () =>
      new Response(mockHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });

    const searchTool = createWebSearchTool(mockFetch as any);
    const result = (await searchTool.run(
      { query: 'Hacker News' },
      { agentId: 'test', agentName: 'Tester' },
    )) as any;

    expect(result.query).toBe('Hacker News');
    expect(result.count).toBeGreaterThan(0);
    expect(result.results[0].title).toBe('Hacker News');
    expect(result.results[0].url).toBe('https://news.ycombinator.com');
  });

  it('runs web.extract with mock fetch', async () => {
    const mockHtml = `
      <html>
        <head><title>Documentation Guide</title></head>
        <body>
          <h1>API Quickstart</h1>
          <p>Get started with our autonomous AI runtime in 2 minutes.</p>
        </body>
      </html>
    `;
    const mockFetch = async () =>
      new Response(mockHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });

    const extractTool = createWebExtractTool(mockFetch as any);
    const result = (await extractTool.run(
      { url: 'https://example.com/docs' },
      { agentId: 'test', agentName: 'Tester' },
    )) as any;

    expect(result.title).toBe('Documentation Guide');
    expect(result.markdown).toContain('# API Quickstart');
  });
});

describe('Image Generation Tool', () => {
  it('generates an image URL with flux model fallback', async () => {
    const mockFetch = async () => new Response(null, { status: 200 });
    const imageTool = createImageGenerationTool(mockFetch as any);

    const result = (await imageTool.run(
      { prompt: 'A futuristic glass desklet on a calm ivory desktop', size: '1024x1024' },
      { agentId: 'test', agentName: 'Tester' },
    )) as any;

    expect(result.status).toBe('completed');
    expect(result.url).toContain('pollinations.ai');
    expect(result.prompt).toBe('A futuristic glass desklet on a calm ivory desktop');
    expect(result.dimensions).toBe('1024x1024');
  });
});

describe('Browser Tools', () => {
  it('navigates and extracts structure from mock webpage', async () => {
    const mockHtml = `
      <html>
        <head><title>Interactive App</title></head>
        <body>
          <h2>Dashboard Overview</h2>
          <button>Deploy Now</button>
          <a href="https://example.com/settings">Settings</a>
          <p>System status is nominal.</p>
        </body>
      </html>
    `;
    const mockFetch = async () =>
      new Response(mockHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });

    const navTool = createBrowserNavigateTool(mockFetch as any);
    const navResult = (await navTool.run(
      { url: 'https://example.com/app' },
      { agentId: 'test', agentName: 'Tester' },
    )) as any;

    expect(navResult.title).toBe('Interactive App');
    expect(navResult.headings).toContain('Dashboard Overview');
    expect(navResult.interactiveElements.some((e: any) => e.text === 'Deploy Now')).toBe(true);
    expect(navResult.interactiveElements.some((e: any) => e.href === 'https://example.com/settings')).toBe(true);

    const clickTool = createBrowserClickTool();
    const clickResult = (await clickTool.run(
      { url: 'https://example.com/app', text: 'Deploy Now' },
      { agentId: 'test', agentName: 'Tester' },
    )) as any;
    expect(clickResult.success).toBe(true);
    expect(clickResult.action).toBe('clicked');

    const typeTool = createBrowserTypeTool();
    const typeResult = (await typeTool.run(
      { url: 'https://example.com/app', selector: '#search', text: 'query string' },
      { agentId: 'test', agentName: 'Tester' },
    )) as any;
    expect(typeResult.success).toBe(true);
    expect(typeResult.textLength).toBe(12);

    const visionTool = createBrowserVisionTool(mockFetch as any);
    const visionResult = (await visionTool.run(
      { url: 'https://example.com/app' },
      { agentId: 'test', agentName: 'Tester' },
    )) as any;
    expect(visionResult.pageStructure.headings).toContain('Dashboard Overview');
    expect(visionResult.pageStructure.buttonsCount).toBe(1);
  });
});
