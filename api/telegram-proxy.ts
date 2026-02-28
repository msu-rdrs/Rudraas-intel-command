// Telegram channel proxy — parses RSSHub RSS feeds for public channels.
// No bot token or JS rendering required.
// RSSHub endpoint: https://rsshub.app/telegram/channel/{channel}

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

const ALLOWED_CHANNELS = new Set([
  'goreunit',
  'MeghUpdates',
  'Middle_East_Spectator',
  'wfwitness',
]);

export interface TelegramProxyMessage {
  text: string;
  date: string;  // ISO 8601
  link: string;  // message permalink
}

// ── XML helpers ──────────────────────────────────────────────────────────────

/** Extract the inner content of a single XML tag (handles CDATA). */
function xmlField(block: string, tag: string): string {
  // CDATA variant: <tag><![CDATA[...]]></tag>
  const cdata = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata) return cdata[1].trim();

  // Plain text variant: <tag>...</tag>
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (plain) return plain[1].trim();

  return '';
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Post-HTML-strip cleaning:
 *  1. Decode numeric HTML entities  &#33; → !
 *  2. Remove trailing reaction counts  🔥103👍10
 *  3. Remove duplicate URLs
 *  4. Trim + truncate to 300 chars
 */
function cleanText(s: string): string {
  // 1. Decode decimal and hex numeric entities (e.g. &#33; &#x21;)
  s = s.replace(/&#(\d+);/g, (_, n) => {
    try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; }
  });
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
  });

  // 2. Strip trailing reaction counts: one or more (emoji + number) groups at end
  //    e.g. "🔥103👍10" or "👁7.7K🔥45" — always at end, never mid-sentence
  s = s.replace(/(\s*\p{Emoji_Presentation}\uFE0F?\d[\d.,]*[KkMm]?\s*)+$/u, '');

  // 3. Remove duplicate URLs (same URL appearing more than once)
  const seen = new Set<string>();
  s = s.replace(/https?:\/\/\S+/g, (url) => {
    if (seen.has(url)) return '';
    seen.add(url);
    return url;
  });

  // 4. Trim and truncate
  s = s.trim();
  if (s.length > 300) s = s.slice(0, 300) + '...';

  return s;
}

/**
 * Full pipeline for RSS description/title fields:
 *  - Cut at any trailing HTML fragment before stripping
 *  - Strip HTML
 *  - Clean and truncate
 */
function processField(raw: string): string {
  // Cut everything from the first <div class=" onward (trailing HTML fragments
  // that weren't closed, e.g. leftover footer markup from RSSHub output)
  const divIdx = raw.indexOf('<div class="');
  const clipped = divIdx !== -1 ? raw.slice(0, divIdx) : raw;
  return cleanText(stripHtml(clipped));
}

/** Convert RSS pubDate (RFC 2822) to ISO 8601. */
function toIso(pubDate: string): string {
  if (!pubDate) return new Date().toISOString();
  try {
    const d = new Date(pubDate);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ── RSS parser ────────────────────────────────────────────────────────────────

function parseRss(xml: string): TelegramProxyMessage[] {
  const results: TelegramProxyMessage[] = [];

  // Split on <item> boundaries; index 0 is the channel header, skip it
  const items = xml.split(/<item[\s>]/i);

  for (let i = 1; i < items.length; i++) {
    const block = items[i];

    const link    = xmlField(block, 'link').trim();
    const pubDate = xmlField(block, 'pubDate');
    const title   = processField(xmlField(block, 'title'));
    const desc    = processField(xmlField(block, 'description'));

    if (!link) continue;

    // Prefer description (full content) over title (may be truncated)
    let text = desc.length > title.length ? desc : title;
    if (!text) continue;

    results.push({ text, date: toIso(pubDate), link });
  }

  // Oldest first, newest last; cap at 20
  return results.slice(-20);
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const { searchParams } = new URL(req.url);
  const channel = (searchParams.get('channel') ?? '').trim();

  if (!channel || !ALLOWED_CHANNELS.has(channel)) {
    return new Response(JSON.stringify({ error: 'Channel not in allowlist' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const rssUrl = `https://rsshub.app/telegram/channel/${encodeURIComponent(channel)}`;

  try {
    const res = await fetchWithTimeout(
      rssUrl,
      {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
          'Accept-Charset': 'utf-8',
          'User-Agent': 'RUDRAASIntelCommand/2.0 (RSS reader)',
        },
      },
      15_000,
    );

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `RSSHub returned ${res.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...cors } },
      );
    }

    // Force UTF-8 decoding — res.text() uses the Content-Type charset which
    // may be absent or wrong, causing emoji to come out as e.g. ðŸ"¥ instead of 🔥
    const xml = new TextDecoder('utf-8').decode(await res.arrayBuffer());
    const messages = parseRss(xml);

    return new Response(JSON.stringify({ channel, messages }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
        ...cors,
      },
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return new Response(
      JSON.stringify({ error: isAbort ? 'Request timed out' : 'Fetch failed' }),
      {
        status: isAbort ? 504 : 502,
        headers: { 'Content-Type': 'application/json', ...cors },
      },
    );
  }
}
