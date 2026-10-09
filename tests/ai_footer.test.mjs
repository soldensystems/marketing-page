import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const root = new URL('../public/', import.meta.url);
const pages = fs.readdirSync(root).filter(name => name.endsWith('.html'));
const prompt = "I am a CFO / Controller evaluating Solden (https://soldenai.com) to help my team get finance work done with less manual effort, starting with month-end close. Explain the service in concrete, operational terms, not marketing language. Walk me through the experience step by step: What I receive when I engage Solden, starting with financial close; What data and systems it needs access to; What work Solden takes responsibility for and what my team still does; How AI, software and accountant review work together; How exceptions, decisions and approvals are handled; What visibility I have into progress and outstanding issues; What completed work and supporting evidence I receive; How the service is intended to improve speed, quality and control; and What scope of finance work it covers today and what is planned. Use https://soldenai.com to explain how Solden could help my finance team, using concrete examples from the website.";
const providers = [
  ['ChatGPT', 'https://chatgpt.com/?q='], ['Claude', 'https://claude.ai/new?q='],
  ['Gemini', 'https://gemini.google.com/app?q='], ['Grok', 'https://grok.x.ai/?q='],
  ['Perplexity', 'https://www.perplexity.ai?q='],
];

test('every footer has the same compact icon-only summary row below its brand line', () => {
  let reference;
  for (const page of pages) {
    const html = fs.readFileSync(new URL(page, root), 'utf8');
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0];
    const ai = footer.match(/<div class="footer-ai">[\s\S]*?<\/div>/)?.[0];
    assert.ok(ai, page);
    if (reference) assert.equal(ai, reference, page); else reference = ai;
    assert.ok(footer.indexOf('class="footer-ai"') < footer.indexOf('class="footer-nav"'));
    assert.match(ai, /<p>Request an AI summary of Solden\.<\/p>/);
    assert.equal((ai.match(/<a /g) || []).length, 5);
    assert.equal((ai.match(/<svg /g) || []).length, 5);
    assert.equal((ai.match(/aria-hidden="true" focusable="false"/g) || []).length, 5);
    for (const [name, base] of providers) {
      const href = base + encodeURIComponent(prompt);
      assert.ok(ai.includes(`href="${href}" target="_blank" rel="noopener noreferrer" aria-label="Request a summary of Solden from ${name} (opens in a new tab)" title="${name}"><svg`));
      assert.equal(new URL(href).searchParams.get('q'), prompt);
    }
    assert.doesNotMatch(ai, /<h2|<button|<details|<summary|data-ai-/);
    assert.doesNotMatch(ai, />ChatGPT<|>Claude<|>Gemini<|>Grok<|>Perplexity</);
  }
});

test('the prompt disclosure and clipboard enhancement are removed completely', () => {
  for (const page of pages) {
    const html = fs.readFileSync(new URL(page, root), 'utf8');
    assert.doesNotMatch(html, /View or copy the prompt|Copy prompt|data-ai-copy|data-ai-prompt|data-ai-status/);
  }
  const js = fs.readFileSync(new URL('assets/site.js', root), 'utf8');
  assert.doesNotMatch(js, /navigator\.clipboard|data-ai-summary|data-ai-copy|data-ai-prompt|data-ai-status/);
  const css = fs.readFileSync(new URL('assets/site.css', root), 'utf8');
  assert.doesNotMatch(css, /footer-ai-copy|footer-ai-prompt|footer-ai-status/);
});

test('Google and Bing verification remain present', () => {
  const home = fs.readFileSync(new URL('index.html', root), 'utf8');
  assert.ok(home.includes('<meta name="msvalidate.01" content="FBB40A39281F2967A862F7788C8DE6FD" />'));
  assert.ok(home.includes('<meta name="google-site-verification" content="ROc4f1EjHw5jcWaMG3Gsl5n_hcWUImGno03acgf5BPE" />'));
});
