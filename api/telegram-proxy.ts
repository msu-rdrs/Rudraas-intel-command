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
    const title   = stripHtml(xmlField(block, 'title'));
    const desc    = stripHtml(xmlField(block, 'description'));

    if (!link) continue;

    // Prefer description (full content) over title (may be truncated)
    let text = desc.length > title.length ? desc : title;
    if (!text) continue;
    if (text.length > 800) text = text.slice(0, 800) + '…';

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

    const xml      = await res.text();
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
