function injectSplashStyles(): void {
  if (document.getElementById('rudraas-splash-styles')) return;
  const style = document.createElement('style');
  style.id = 'rudraas-splash-styles';
  style.textContent = `
    #rudraas-splash {
      position: fixed;
      inset: 0;
      background: #050505;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: 'Inter', system-ui, sans-serif;
      overflow: hidden;
      opacity: 1;
      transition: opacity 0.8s ease;
    }
    #rudraas-splash::before {
      content: '';
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        to bottom,
        transparent 0px,
        transparent 3px,
        rgba(0, 0, 0, 0.12) 3px,
        rgba(0, 0, 0, 0.12) 4px
      );
      pointer-events: none;
      z-index: 1;
    }
    .splash-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      position: relative;
      z-index: 2;
    }
    .splash-emblem {
      width: 120px;
      height: 120px;
      object-fit: contain;
      animation: splash-pulse-glow 2.2s ease-in-out infinite;
      margin-bottom: 28px;
    }
    @keyframes splash-pulse-glow {
      0%, 100% { filter: drop-shadow(0 0 18px rgba(192,192,192,0.45)); }
      50%       { filter: drop-shadow(0 0 38px rgba(192,192,192,0.9)); }
    }
    .splash-title {
      color: #1B2E5E;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 8px;
      text-transform: uppercase;
      margin-bottom: 10px;
      text-align: center;
    }
    .splash-tagline {
      color: #C0C0C0;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 6px;
      text-transform: uppercase;
      margin-bottom: 40px;
      text-align: center;
    }
    .splash-terminal {
      font-family: 'Courier New', Courier, monospace;
      font-size: 11px;
      color: #4A90D9;
      text-align: left;
      width: 440px;
      max-width: 88vw;
      min-height: 108px;
    }
    .splash-terminal-line {
      margin: 5px 0;
      opacity: 0;
      transform: translateX(-6px);
      animation: splash-line-in 0.25s ease forwards;
    }
    .splash-terminal-line.done {
      color: #C0C0C0;
    }
    @keyframes splash-line-in {
      to { opacity: 1; transform: translateX(0); }
    }
    .splash-progress-track {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: #0d1020;
      z-index: 2;
    }
    .splash-progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(to right, #1B2E5E 0%, #4A90D9 100%);
      transition: width 4.5s linear;
    }
  `;
  document.head.appendChild(style);
}

const BOOT_LINES = [
  '> INITIALIZING RUDRAAS INTELLIGENCE COMMAND...',
  '> LOADING GEOPOLITICAL DATA FEEDS...',
  '> ESTABLISHING SECURE CONNECTIONS...',
  '> CALIBRATING THREAT ASSESSMENT MATRIX...',
  '> SYNCHRONIZING DEFENSE INTELLIGENCE NODES...',
  '> ALL SYSTEMS OPERATIONAL — CLASSIFIED LEVEL 5',
];

const LINE_INTERVAL = 550; // ms between each line
const TOTAL_DURATION = 5200; // ms before fade starts
const FADE_DURATION = 800; // ms for fade-out

export function showSplash(): Promise<void> {
  return new Promise<void>((resolve) => {
    injectSplashStyles();

    const overlay = document.createElement('div');
    overlay.id = 'rudraas-splash';
    overlay.innerHTML = `
      <div class="splash-content">
        <img
          src="/Rudraas_Dynamics_EMBLEM.png"
          class="splash-emblem"
          alt="RUDRAAS"
          onerror="this.style.display='none'"
        />
        <div class="splash-title">RUDRAAS INTELLIGENCE COMMAND</div>
        <div class="splash-tagline">ENGINEERED DOMINANCE</div>
        <div class="splash-terminal" id="splashTerminal"></div>
      </div>
      <div class="splash-progress-track">
        <div class="splash-progress-fill" id="splashProgressFill"></div>
      </div>
    `;

    document.body.appendChild(overlay);

    const terminal = overlay.querySelector<HTMLDivElement>('#splashTerminal')!;
    const progressFill = overlay.querySelector<HTMLDivElement>('#splashProgressFill')!;

    // Kick off progress bar animation (transition takes 4.5s)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        progressFill.style.width = '100%';
      });
    });

    // Sequentially add boot lines
    BOOT_LINES.forEach((line, i) => {
      setTimeout(() => {
        const el = document.createElement('div');
        el.className = 'splash-terminal-line';
        el.textContent = line;
        // Last line gets different color
        if (i === BOOT_LINES.length - 1) el.classList.add('done');
        terminal.appendChild(el);
      }, 400 + i * LINE_INTERVAL);
    });

    // Fade out and resolve
    setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, FADE_DURATION);
    }, TOTAL_DURATION);
  });
}
