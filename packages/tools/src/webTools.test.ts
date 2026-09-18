import { expect, it } from 'vitest';
import { createWebSearchTool, type WebSearchOutput } from './webTools';
const context = { agentId: 'test', agentName: 'Controlled test' };
it('reads current search markup and decodes redirect URLs only once', async () => {
  const html =
    '<h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%2520b&amp;rut=x">Actual title</a></h2><a class="result__snippet" href="/">Actual <b>snippet</b></a>';
  const tool = createWebSearchTool(async () => new Response(html));
  const result = (await tool.run({ query: 'sample' }, context)) as WebSearchOutput;
  expect(result.results).toEqual([
    { title: 'Actual title', url: 'https://example.com/a%20b', snippet: 'Actual snippet' },
  ]);
});
it('reports human challenges and unknown HTML as failures, never as empty successful searches', async () => {
  for (const html of [
    '<form id="challenge-form">Select ducks</form>',
    '<html>Gateway problem</html>',
  ]) {
    const tool = createWebSearchTool(async () => new Response(html, { status: 202 }));
    await expect(tool.run({ query: 'sample' }, context)).rejects.toThrow(/challenge|unreadable/);
  }
});
it('permits verified empty results and rejects invalid limits', async () => {
  const tool = createWebSearchTool(
    async () => new Response('<div class="no-results">No results found</div>'),
  );
  expect(((await tool.run({ query: 'sample' }, context)) as WebSearchOutput).count).toBe(0);
  await expect(tool.run({ query: 'sample', limit: -1 }, context)).rejects.toThrow('limit');
});
