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
  // DDG HTML changed over time: match any anchor with rel=nofollow + the
  // result-link marker, regardless of attribute order or quote style, then
  // grab the snippet from the following result-snippet cell.
  const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < 4) {
    const tag = m[0];
    if (!/rel\s*=\s*["']nofollow["']/i.test(tag) || !/\bresult-link\b/i.test(tag)) continue;
    const href = (tag.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    const title = decodeEntities(m[1].replace(/<[^>]*>/g, ''));
    const uddg = href.match(/uddg=([^&]+)/);
    const after = html.slice(linkRe.lastIndex);
    const snip = after.match(/class\s*=\s*["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/i);
    results.push({
      title,
      snippet: decodeEntities(snip ? snip[1].replace(/<[^>]*>/g, '') : ''),
      link: uddg ? decodeURIComponent(uddg[1]) : decodeEntities(href),
    });
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