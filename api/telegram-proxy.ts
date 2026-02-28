// Telegram public channel proxy — server-side HTML scraper
// Fetches https://t.me/s/{channel} and returns parsed messages as JSON.
// No bot token required; works with any public Telegram channel.

import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';

export const config = { runtime: 'edge' };

// Whitelist — only these channels can be proxied (prevents open SSRF)
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

function parseMessages(html: string): TelegramProxyMessage[] {
  const results: TelegramProxyMessage[] = [];

  // Each message block starts with "tgme_widget_message_wrap" in the HTML.
  // Splitting on this string gives us isolated per-message sections.
  const parts = html.split('tgme_widget_message_wrap');

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];

    // Extract message permalink + ISO datetime from the date anchor
    // HTML structure: class="tgme_widget_message_date"><a href="LINK"><time datetime="ISO">
    const dateMatch = block.match(
      /tgme_widget_message_date[^>]*>\s*<a[^>]+href="([^"]+)"[\s\S]{0,300}?<time[^>]+datetime="([^"]+)"/
    );
    if (!dateMatch) continue;

    const link = dateMatch[1];
    const date = dateMatch[2];

    // Extract message text — not present on media-only posts
    let text = '';
    const textMatch = block.match(
      /tgme_widget_message_text[^"]*"[^>]*dir="auto"[^>]*>([\s\S]*?)<\/div>/
    );
    if (textMatch) {
      text = stripHtml(textMatch[1]);
    }

    // For media-only posts, use a short placeholder so the card still renders
    if (!text) {
      const hasMedia =
        block.includes('tgme_widget_message_photo') ||
        block.includes('tgme_widget_message_video') ||
        block.includes('tgme_widget_message_document');
      text = hasMedia ? '[Media]' : '';
    }

    if (!text) continue;
    if (text.length > 800) text = text.slice(0, 800) + '…';

    results.push({ text, date, link });
  }

  // Return last 20 messages (most recent last)
  return results.slice(-20);
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 15_000
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

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

  const tgUrl = `https://t.me/s/${encodeURIComponent(channel)}`;

  try {
    const res = await fetchWithTimeout(
      tgUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      },
      15_000
    );

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Telegram returned ${res.status}` }),
        {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...cors },
        }
      );
    }

    const html = await res.text();
    const messages = parseMessages(html);

    return new Response(JSON.stringify({ channel, messages }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // 30 s fresh, serve stale for up to 60 s while revalidating
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
      }
    );
  }
}
