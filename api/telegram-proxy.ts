// Telegram channel proxy — fetches public channel messages via three approaches:
//   1. tg.i-c-a.su  (Telegram-native RSS service)
//   2. telegramrss.com
//   3. Direct t.me/s/{channel} HTML scraping (JS-free subset)
// No bot token required.

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

// ── Text-cleaning helpers ─────────────────────────────────────────────────────

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
  s = s.replace(/(\s*\p{Emoji_Presentation}\uFE0F?\d[\d.,]*[KkMm]?\s*)+$/u, '');

  // 3. Remove duplicate URLs
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
 *  0. Strip any CDATA wrappers (defense-in-depth — xmlField may miss them if
 *     whitespace sits between the tag and <![CDATA[)
 *  1. Cut at any trailing HTML fragment before stripping
 *  2. Strip HTML → clean → truncate
 */
function processField(raw: string): string {
  // 0. Unwrap CDATA: <![CDATA[...]]> → inner content
  const noCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const divIdx = noCdata.indexOf('<div class="');
  const clipped = divIdx !== -1 ? noCdata.slice(0, divIdx) : noCdata;
  return cleanText(stripHtml(clipped));
}

/** Convert RSS pubDate (RFC 2822) or any date string to ISO 8601. */
function toIso(pubDate: string): string {
  if (!pubDate) return new Date().toISOString();
  try {
    const d = new Date(pubDate);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// ── RSS parser (shared by approach 1 & 2) ────────────────────────────────────

/** Extract the inner content of a single XML tag (handles CDATA). */
function xmlField(block: string, tag: string): string {
  const cdata = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i'));
  if (cdata && cdata[1] !== undefined) return cdata[1].trim();
  const plain = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (plain && plain[1] !== undefined) return plain[1].trim();
  return '';
}

function parseRss(xml: string): TelegramProxyMessage[] {
  const results: TelegramProxyMessage[] = [];

  // Strip all CDATA wrappers globally before any field extraction.
  // This handles feeds (e.g. tg.i-c-a.su) where whitespace between the
  // opening tag and <![CDATA[ defeats the per-tag CDATA regex in xmlField().
  const cleanXml = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // Split on <item> boundaries; index 0 is channel header, skip it
  const items = cleanXml.split(/<item[\s>]/i);

  for (let i = 1; i < items.length; i++) {
    const block = items[i];
    if (block === undefined) continue;

    const rawLink = xmlField(block, 'link').trim();
    // Some feeds put the link as plain text between tags; try guid as fallback
    const link = rawLink || xmlField(block, 'guid').trim();
    if (!link) continue;

    const pubDate = xmlField(block, 'pubDate');
    const title   = processField(xmlField(block, 'title'));
    const desc    = processField(xmlField(block, 'description'));

    // Prefer whichever field has more content
    const text = desc.length > title.length ? desc : title;
    if (!text) continue;

    results.push({ text, date: toIso(pubDate), link });
  }

  // Oldest first, newest last; cap at 20
  return results.slice(-20);
}

// ── HTML parser (approach 3 — t.me/s/ scraping) ───────────────────────────────

function parseTmeSPage(html: string): TelegramProxyMessage[] {
  const results: TelegramProxyMessage[] = [];

  // Split on data-post= boundaries — each block is one message widget
  const blocks = html.split(/data-post=/i);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    if (block === undefined) continue;

    // data-post="channel/123" — extract the post ID to build the permalink
    const postMatch = block.match(/^["']([^"']+)["']/);
    if (!postMatch || postMatch[1] === undefined) continue;
    const postPath = postMatch[1]; // e.g. "MeghUpdates/1234"
    const link = `https://t.me/${postPath}`;

    // Date: <time datetime="2024-01-14T09:35:00+00:00"
    const dateMatch = block.match(/<time[^>]+datetime=["']([^"']+)["']/i);
    const date = dateMatch && dateMatch[1] !== undefined
      ? toIso(dateMatch[1])
      : new Date().toISOString();

    // Message text: find tgme_widget_message_text block
    // Use indexOf to avoid the nested-div regex trap
    const textMarker = 'tgme_widget_message_text';
    const markerIdx = block.indexOf(textMarker);
    if (markerIdx === -1) continue;

    // Advance past the opening tag (find the closing >)
    const openTagEnd = block.indexOf('>', markerIdx);
    if (openTagEnd === -1) continue;

    // Take up to the next </div> that closes this block (or 2000 chars)
    const textStart = openTagEnd + 1;
    const closeIdx = block.indexOf('</div>', textStart);
    const rawText = closeIdx !== -1
      ? block.slice(textStart, closeIdx)
      : block.slice(textStart, textStart + 2000);

    const text = cleanText(stripHtml(rawText));
    if (!text) continue;

    results.push({ text, date, link });
  }

  // Oldest first, newest last; cap at 20
  return results.slice(-20);
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
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

  const rssHeaders = {
    Accept: 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Charset': 'utf-8',
    'User-Agent': 'RUDRAASIntelCommand/2.0 (RSS reader)',
  };

  // ── Approach 1: tg.i-c-a.su ────────────────────────────────────────────────
  try {
    const res = await fetchWithTimeout(
      `https://tg.i-c-a.su/rss/${encodeURIComponent(channel)}`,
      { headers: rssHeaders },
      8_000,
    );
    if (res.ok) {
      const xml = new TextDecoder('utf-8').decode(await res.arrayBuffer());
      if (xml.includes('<item')) {
        const messages = parseRss(xml);
        return new Response(JSON.stringify({ channel, messages }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60', ...cors },
        });
      }
    }
  } catch {
    // fall through to approach 2
  }

  // ── Approach 2: telegramrss.com ─────────────────────────────────────────────
  try {
    const res = await fetchWithTimeout(
      `https://www.telegramrss.com/rss/${encodeURIComponent(channel)}`,
      { headers: rssHeaders },
      8_000,
    );
    if (res.ok) {
      const xml = new TextDecoder('utf-8').decode(await res.arrayBuffer());
      if (xml.includes('<item')) {
        const messages = parseRss(xml);
        return new Response(JSON.stringify({ channel, messages }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60', ...cors },
        });
      }
    }
  } catch {
    // fall through to approach 3
  }

  // ── Approach 3: t.me/s/ HTML scraping ──────────────────────────────────────
  try {
    const res = await fetchWithTimeout(
      `https://t.me/s/${encodeURIComponent(channel)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Referer': 'https://t.me/',
        },
      },
      10_000,
    );
    if (res.ok) {
      const html = new TextDecoder('utf-8').decode(await res.arrayBuffer());
      const messages = parseTmeSPage(html);
      if (messages.length > 0) {
        return new Response(JSON.stringify({ channel, messages }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60', ...cors },
        });
      }
    }
  } catch {
    // all approaches exhausted
  }

  return new Response(
    JSON.stringify({ error: 'All fetch approaches failed for ' + channel }),
    { status: 502, headers: { 'Content-Type': 'application/json', ...cors } },
  );
}
