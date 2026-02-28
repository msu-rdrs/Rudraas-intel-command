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

/**
 * Index-based text extraction — avoids the closing-</div> trap.
 * Finds the first matching class marker, locates its > boundary,
 * then reads up to the footer div (or 3 KB) to get full content.
 */
function extractText(block: string): string {
  const markers = [
    'tgme_widget_message_text',
    'js-message_text',
    'message_media_not_supported_label',
  ];

  for (const marker of markers) {
    const markerIdx = block.indexOf(marker);
    if (markerIdx === -1) continue;

    // Skip forward to the > that closes the opening tag
    const gtIdx = block.indexOf('>', markerIdx);
    if (gtIdx === -1) continue;

    // Use the footer as the end boundary — avoids grabbing counts/buttons
    const footerIdx = block.indexOf('tgme_widget_message_footer', gtIdx);
    const endIdx = footerIdx !== -1 ? footerIdx : Math.min(gtIdx + 3000, block.length);

    const text = stripHtml(block.slice(gtIdx + 1, endIdx));
    if (text.length > 2) return text;
  }

  // Media-only post: no text div, but has a media element
  if (
    block.includes('tgme_widget_message_photo') ||
    block.includes('tgme_widget_message_video') ||
    block.includes('tgme_widget_message_document') ||
    block.includes('tgme_widget_message_poll')
  ) {
    return '[Media]';
  }

  return '';
}

/**
 * Extract the message date permalink.
 * Looks for the tgme_widget_message_date class and grabs the href
 * within the next 200 chars — robust regardless of attribute order.
 */
function extractLink(block: string): string {
  const dateIdx = block.indexOf('tgme_widget_message_date');
  if (dateIdx === -1) return '';
  const hrefMatch = block.slice(dateIdx, dateIdx + 300).match(/href="([^"]+)"/);
  return hrefMatch ? hrefMatch[1] : '';
}

function parseMessages(html: string): TelegramProxyMessage[] {
  const results: TelegramProxyMessage[] = [];

  // Primary: split by data-post=" which is on every message wrapper div.
  // Each segment [i ≥ 1] starts with "Channel/msgId" followed by the message HTML.
  let parts = html.split('data-post="');

  // Fallback: split by the message wrap class if data-post isn't found
  if (parts.length < 2) {
    parts = html.split('tgme_widget_message_wrap');
  }

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];

    // --- Date ---
    const timeMatch = block.match(/<time[^>]+datetime="([^"]+)"/);
    if (!timeMatch) continue;
    const date = timeMatch[1];

    // --- Link ---
    const link = extractLink(block);
    if (!link) continue; // no permalink → skip (e.g. grouped media sub-blocks)

    // --- Text ---
    let text = extractText(block);
    if (!text) continue;
    if (text.length > 800) text = text.slice(0, 800) + '…';

    results.push({ text, date, link });
  }

  // Deduplicate by link (grouped messages can produce duplicate blocks)
  const seen = new Set<string>();
  const deduped = results.filter((m) => {
    if (seen.has(m.link)) return false;
    seen.add(m.link);
    return true;
  });

  // Return last 20 messages (oldest first, most-recent last)
  return deduped.slice(-20);
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

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

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
  const debug   = searchParams.get('debug') === '1';

  if (!channel || !ALLOWED_CHANNELS.has(channel)) {
    return new Response(JSON.stringify({ error: 'Channel not in allowlist' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const tgUrl = `https://t.me/s/${encodeURIComponent(channel)}`;

  try {
    const res = await fetchWithTimeout(tgUrl, { headers: FETCH_HEADERS }, 15_000);

    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: `Telegram returned ${res.status}` }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...cors } }
      );
    }

    const html = await res.text();

    // Debug mode: return the raw HTML so you can inspect Telegram's actual structure.
    // Usage: /api/telegram-proxy?channel=MeghUpdates&debug=1
    if (debug) {
      // Cap at 80 KB to keep the response sane
      const snippet = html.length > 80_000 ? html.slice(0, 80_000) + '\n<!-- TRUNCATED -->' : html;
      return new Response(snippet, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          ...cors,
        },
      });
    }

    const messages = parseMessages(html);

    // Also surface parsing diagnostics when messages are empty
    const diagnostics = messages.length === 0
      ? {
          htmlLength: html.length,
          hasDataPost: html.includes('data-post="'),
          hasWrap: html.includes('tgme_widget_message_wrap'),
          hasTime: html.includes('datetime='),
          hasMsgText: html.includes('tgme_widget_message_text'),
        }
      : undefined;

    return new Response(
      JSON.stringify({ channel, messages, ...(diagnostics ? { diagnostics } : {}) }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30, stale-while-revalidate=60',
          ...cors,
        },
      }
    );
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
