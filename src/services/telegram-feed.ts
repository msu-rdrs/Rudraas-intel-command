export interface TelegramFeedMessage {
  text: string;
  date: string;  // ISO 8601
  link: string;  // message permalink on t.me
}

// Per-channel cache (TTL: 60 s)
const cache = new Map<string, { messages: TelegramFeedMessage[]; fetchedAt: number }>();
const CACHE_TTL = 60_000;

export async function fetchChannelMessages(channel: string): Promise<TelegramFeedMessage[]> {
  const cached = cache.get(channel);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    console.log('[Signals] cache hit for', channel, '—', cached.messages.length, 'messages');
    return cached.messages;
  }

  const url = '/api/telegram-proxy?channel=' + channel;
  console.log('[Signals] fetching', url);

  const res = await fetch(url);
  console.log('[Signals] response', res.status, res.statusText, 'content-type:', res.headers.get('content-type'));

  // Read as text first so we can log the raw body on any parse failure.
  // res.json() in Safari routes through a WebKit XML parser internally and can
  // throw "The string did not match the expected pattern" on non-JSON bodies.
  const text = await res.text();
  console.log('[Signals] raw body (first 500):', text.slice(0, 500));

  if (!res.ok) {
    throw new Error(`telegram-proxy ${res.status} for ${channel}: ${text.slice(0, 200)}`);
  }

  let data: { channel: string; messages: TelegramFeedMessage[] };
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error('[Signals] JSON.parse failed:', e);
    throw new Error(`Response is not JSON for ${channel}. Body starts: ${text.slice(0, 100)}`);
  }

  console.log('[Signals] parsed', data.messages?.length ?? 0, 'messages for', channel);

  const messages: TelegramFeedMessage[] = data.messages ?? [];
  cache.set(channel, { messages, fetchedAt: Date.now() });
  return messages;
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
