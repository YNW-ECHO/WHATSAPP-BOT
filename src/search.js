const { config } = require('./config');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function decodeEntities(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

async function googleSearch(query) {
  const url =
    'https://www.googleapis.com/customsearch/v1' +
    `?key=${encodeURIComponent(config.googleKey)}&cx=${encodeURIComponent(config.googleCx)}&num=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  const data = await res.json();
  if (!data.items) return [];
  return data.items.map((it) => ({ title: it.title, snippet: it.snippet || '', link: it.link || '' }));
}

async function duckDuckGoSearch(query) {
  const res = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), {
    headers: { 'user-agent': UA },
  });
  const html = await res.text();
  const results = [];
  const blocks = html.split('<div class="result"').slice(1);
  for (const block of blocks) {
    const title = (block.match(/<a[^>]*rel="nofollow"[^>]*>([\s\S]*?)<\/a>/) || [])[1];
    const snippet = (block.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/) || [])[1];
    const link = (block.match(/uddg=([^&"']+)/) || [])[1];
    if (!title && !snippet) continue;
    results.push({
      title: decodeEntities(title),
      snippet: decodeEntities(snippet),
      link: link ? decodeURIComponent(link) : '',
    });
    if (results.length >= 4) break;
  }
  return results;
}

async function searchWeb(query) {
  try {
    if (config.googleKey && config.googleCx) return await googleSearch(query);
    return await duckDuckGoSearch(query);
  } catch (e) {
    return [];
  }
}

module.exports = { searchWeb };