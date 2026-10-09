import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const root = new URL('../public/', import.meta.url);
const pages = fs.readdirSync(root).filter(name => name.endsWith('.html'));
const prompt = 'Read https://soldenai.com and explain what Solden does, who it’s for, and how its finance department-as-a-service offering works, starting with financial close.';
const providers = [
  ['ChatGPT', 'https://chatgpt.com/?q='], ['Claude', 'https://claude.ai/new?q='],
  ['Gemini', 'https://gemini.google.com/app?q='], ['Grok', 'https://grok.x.ai/?q='],
  ['Perplexity', 'https://www.perplexity.ai?q='],
];
const script = fs.readFileSync(new URL('assets/site.js', root), 'utf8');
const footerScript = script.slice(script.indexOf('// AI summary hand-off:'));

test('every footer carries identical accessible AI links, encoded prompt and no-JS fallback', () => {
  let reference;
  for (const page of pages) {
    const html = fs.readFileSync(new URL(page, root), 'utf8');
    const footer = html.match(/<section class="footer-ai"[\s\S]*?<\/section>/)?.[0];
    assert.ok(footer, page);
    if (reference) assert.equal(footer, reference, page); else reference = footer;
    for (const [name, base] of providers) {
      const href = base + encodeURIComponent(prompt);
      assert.ok(footer.includes(`href="${href}" target="_blank" rel="noopener noreferrer" aria-label="Ask ${name} about Solden (opens in a new tab)"`));
      assert.equal(new URL(href).searchParams.get('q'), prompt);
    }
    assert.match(footer, /data-ai-copy hidden/);
    assert.ok(footer.includes(`<p class="footer-ai-copy" data-ai-prompt>${prompt}</p>`));
    assert.match(footer, /<details[\s\S]*?<summary>View or copy the prompt<\/summary>/);
    assert.match(footer, /data-ai-status role="status" aria-live="polite"/);
  }
});

function harness(clipboard) {
  let click;
  const button = { hidden: true, disabled: false, addEventListener: (_, fn) => { click = fn; } };
  const status = { textContent: '' };
  const nodes = { '[data-ai-prompt]': { textContent: ` ${prompt} ` }, '[data-ai-copy]': button, '[data-ai-status]': status };
  const summary = { querySelector: selector => nodes[selector] };
  vm.runInNewContext(footerScript, { document: { querySelectorAll: () => [summary] }, navigator: { clipboard } });
  return { button, status, click: () => click() };
}

test('copy prompt handles success, repeated clicks and a pending operation', async () => {
  let resolve;
  const values = [];
  const h = harness({ writeText: text => { values.push(text); return new Promise(done => { resolve = done; }); } });
  assert.equal(h.button.hidden, false);
  const pending = h.click();
  assert.equal(h.button.disabled, true);
  await h.click();
  assert.equal(values.length, 1);
  resolve(); await pending;
  assert.equal(values[0], prompt);
  assert.match(h.status.textContent, /Prompt copied/);
  assert.equal(h.button.disabled, false);
  const again = h.click(); resolve(); await again;
  assert.equal(values.length, 2);
});

test('missing or denied clipboard shows manual fallback and allows retry', async () => {
  for (const clipboard of [undefined, { writeText: async () => { throw new Error('denied'); } }]) {
    const h = harness(clipboard);
    await h.click();
    assert.match(h.status.textContent, /Select and copy/);
    assert.equal(h.button.disabled, false);
    await h.click();
    assert.equal(h.button.disabled, false);
  }
});

test('Google and Bing verification remain present', () => {
  const home = fs.readFileSync(new URL('index.html', root), 'utf8');
  assert.ok(home.includes('<meta name="msvalidate.01" content="FBB40A39281F2967A862F7788C8DE6FD" />'));
  assert.ok(home.includes('<meta name="google-site-verification" content="ROc4f1EjHw5jcWaMG3Gsl5n_hcWUImGno03acgf5BPE" />'));
});
