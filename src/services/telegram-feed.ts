import { proxyUrl } from '@/utils';
import { isDesktopRuntime } from '@/services/runtime';

export interface TelegramFeedMessage {
  text: string;
  date: string;  // ISO 8601
  link: string;  // message permalink on t.me
}

export interface TelegramFeedResult {
  channel: string;
  messages: TelegramFeedMessage[];
  fetchedAt: number;
}

// Per-channel cache (TTL: 60 s)
const cache = new Map<string, TelegramFeedResult>();
const CACHE_TTL = 60_000;

function proxyEndpoint(channel: string): string {
  const path = `/api/telegram-proxy?channel=${encodeURIComponent(channel)}`;
  return isDesktopRuntime() ? proxyUrl(path) : path;
}

export async function fetchChannelMessages(
  channel: string
): Promise<TelegramFeedResult> {
  const cached = cache.get(channel);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  const res = await fetch(proxyEndpoint(channel), {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`telegram-proxy ${res.status} for ${channel}`);
  }

  const json = await res.json() as { channel: string; messages: TelegramFeedMessage[] };

  const result: TelegramFeedResult = {
    channel: json.channel,
    messages: json.messages ?? [],
    fetchedAt: Date.now(),
  };

  cache.set(channel, result);
  return result;
}

export function invalidateChannel(channel: string): void {
  cache.delete(channel);
}

/** Format ISO date string into "DD Mon · HH:MM UTC" for display */
export function formatFeedDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const day = d.getUTCDate();
    const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${day} ${mon} · ${hh}:${mm} UTC`;
  } catch {
    return iso;
  }
}
