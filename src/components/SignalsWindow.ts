import { fetchChannelMessages, formatFeedDate } from '@/services/telegram-feed';
import type { TelegramFeedMessage } from '@/services/telegram-feed';
import { escapeHtml } from '@/utils/sanitize';

interface ChannelConfig {
  handle: string;
  label: string;
  title: string;
}

const CHANNELS: ChannelConfig[] = [
  { handle: 'goreunit',              label: '@goreunit',              title: 'GoRe Unit'       },
  { handle: 'MeghUpdates',           label: '@MeghUpdates',           title: 'Megh Updates'    },
  { handle: 'Middle_East_Spectator', label: '@Middle_East_Spectator', title: 'ME Spectator'    },
  { handle: 'wfwitness',             label: '@wfwitness',             title: 'War Field Witness'},
];

const POLL_INTERVAL = 60_000; // 60 s

export class SignalsWindow {
  private overlay: HTMLElement | null = null;
  private activeIndex = 0;
  private readonly escapeHandler: (e: KeyboardEvent) => void;
  // Per-channel: loaded flag + interval id
  private loaded = new Set<number>();
  private pollTimers = new Map<number, ReturnType<typeof setInterval>>();

  constructor() {
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.close();
    };
  }

  getButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'signals-btn';
    btn.id = 'signalsBtn';
    btn.title = 'SIGNALS INTELLIGENCE — Live Telegram Feeds';
    btn.innerHTML = `<span class="signals-btn-dot"></span>📡 SIGNALS`;
    btn.addEventListener('click', () => this.toggle());
    return btn;
  }

  toggle(): void {
    if (this.overlay) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    if (this.overlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'signals-overlay';
    overlay.id = 'signalsOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Signals Intelligence Live Feeds');

    overlay.innerHTML = `
      <div class="signals-panel">
        <div class="signals-header">
          <div class="signals-header-title">
            <span class="signals-live-dot"></span>
            SIGNALS INTELLIGENCE — LIVE FEEDS
          </div>
          <button class="signals-close" id="signalsClose" title="Close">✕</button>
        </div>
        <div class="signals-tabs" role="tablist" id="signalsTabs">
          ${CHANNELS.map((ch, i) => `
            <button
              class="signals-tab${i === this.activeIndex ? ' active' : ''}"
              role="tab"
              aria-selected="${i === this.activeIndex}"
              data-idx="${i}"
              title="${ch.title}"
            >
              <span class="signals-tab-dot"></span>
              <span class="signals-tab-label">${escapeHtml(ch.label)}</span>
            </button>
          `).join('')}
        </div>
        <div class="signals-panes" id="signalsPanes">
          ${CHANNELS.map((ch, i) => `
            <div
              class="signals-pane${i === this.activeIndex ? ' active' : ''}"
              role="tabpanel"
              data-pane="${i}"
            >
              <div class="signals-feed" id="signalsFeed-${i}" data-channel="${ch.handle}">
                <div class="signals-loading">FETCHING SIGNALS...</div>
              </div>
              <div class="signals-footer-bar">
                <a
                  href="https://t.me/${ch.handle}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="signals-open-link"
                >
                  OPEN IN TELEGRAM ↗
                </a>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    this.overlay = overlay;
    document.addEventListener('keydown', this.escapeHandler);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });

    overlay.querySelector('#signalsClose')?.addEventListener('click', () => this.close());

    overlay.querySelector('#signalsTabs')?.addEventListener('click', (e) => {
      const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-idx]');
      if (!tab) return;
      const idx = parseInt(tab.dataset.idx ?? '0', 10);
      this.switchTab(idx);
    });

    // Load the initially-active tab
    this.loadChannel(this.activeIndex);
  }

  private switchTab(idx: number): void {
    if (!this.overlay) return;
    this.activeIndex = idx;

    this.overlay.querySelectorAll<HTMLElement>('.signals-tab').forEach((tab, i) => {
      const active = i === idx;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });

    this.overlay.querySelectorAll<HTMLElement>('.signals-pane').forEach((pane, i) => {
      pane.classList.toggle('active', i === idx);
    });

    this.loadChannel(idx);
  }

  private loadChannel(idx: number): void {
    if (!this.overlay) return;

    // Start polling if not already running for this channel
    if (!this.pollTimers.has(idx)) {
      const timer = setInterval(() => this.fetchAndRender(idx), POLL_INTERVAL);
      this.pollTimers.set(idx, timer);
    }

    // Always fetch immediately on first load; subsequent renders come from polling
    if (!this.loaded.has(idx)) {
      this.fetchAndRender(idx);
    }
  }

  private async fetchAndRender(idx: number): Promise<void> {
    const ch = CHANNELS[idx];
    if (!ch || !this.overlay) return;

    const feedEl = this.overlay.querySelector<HTMLElement>(`#signalsFeed-${idx}`);
    if (!feedEl) return;

    try {
      const messages = await fetchChannelMessages(ch.handle);
      this.loaded.add(idx);

      if (!this.overlay) return; // closed while fetching

      this.renderMessages(feedEl, messages, ch.handle);
    } catch (err) {
      console.error(`[Signals] fetchAndRender failed for channel idx=${idx} (${ch.handle}):`, err);
      if (!this.overlay) return;
      if (!this.loaded.has(idx)) {
        const msg = err instanceof Error ? err.message : String(err);
        feedEl.innerHTML = `<div class="signals-error">⚠ FEED UNAVAILABLE — RETRY IN ${Math.round(POLL_INTERVAL / 1000)}s<br><small style="opacity:.5;font-size:9px">${escapeHtml(msg)}</small></div>`;
      }
      // If we already had content, keep it (don't wipe on transient error)
    }
  }

  private renderMessages(
    container: HTMLElement,
    messages: TelegramFeedMessage[],
    channel: string
  ): void {
    if (messages.length === 0) {
      container.innerHTML = '<div class="signals-empty">NO SIGNALS INTERCEPTED</div>';
      return;
    }

    const wasAtBottom = this.isScrolledToBottom(container);

    container.innerHTML = messages
      .map(
        (msg) => `
          <div class="signals-msg">
            <div class="signals-msg-header">
              <span class="signals-msg-time">${escapeHtml(formatFeedDate(msg.date))}</span>
              <a
                href="${escapeHtml(msg.link)}"
                target="_blank"
                rel="noopener noreferrer"
                class="signals-msg-link"
                title="Open on Telegram"
              >↗</a>
            </div>
            <div class="signals-msg-text">${escapeHtml(msg.text)}</div>
          </div>
        `
      )
      .join('');

    // Scroll to bottom on first load or if already at bottom
    if (wasAtBottom || !this.loaded.has(CHANNELS.findIndex((c) => c.handle === channel))) {
      container.scrollTop = container.scrollHeight;
    }
  }

  private isScrolledToBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }

  close(): void {
    if (!this.overlay) return;

    // Clear all polling timers
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();
    this.loaded.clear();

    document.removeEventListener('keydown', this.escapeHandler);
    this.overlay.remove();
    this.overlay = null;
  }

  isOpen(): boolean {
    return this.overlay !== null;
  }
}
