const AUTH_KEY = 'rudraas-auth';
const AUTH_TOKEN = 'UkRSUzJrMjYh'; // btoa('RDRS2k26!')

function injectAuthStyles(): void {
  if (document.getElementById('rudraas-auth-styles')) return;
  const style = document.createElement('style');
  style.id = 'rudraas-auth-styles';
  style.textContent = `
    #rudraas-auth-gate {
      position: fixed;
      inset: 0;
      background: #050505;
      z-index: 100000;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Inter', system-ui, sans-serif;
      transition: opacity 0.6s ease;
    }
    .auth-panel {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 48px 40px;
      border: 1px solid #1B2E5E;
      background: #070a12;
      max-width: 420px;
      width: 90%;
    }
    .auth-emblem {
      width: 80px;
      height: 80px;
      object-fit: contain;
      filter: drop-shadow(0 0 12px rgba(192,192,192,0.4));
    }
    .auth-restricted {
      color: #ef4444;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-align: center;
      text-transform: uppercase;
    }
    .auth-title {
      color: #9099b0;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 4px;
      text-transform: uppercase;
      text-align: center;
      margin-bottom: 8px;
    }
    .auth-form {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
      width: 100%;
    }
    .auth-input {
      background: #0d0d0b;
      border: 1px solid #1e2a45;
      color: #d0d4e0;
      padding: 12px 14px;
      font-size: 15px;
      font-family: 'Courier New', monospace;
      letter-spacing: 3px;
      outline: none;
      text-align: center;
      transition: border-color 0.2s;
      width: 100%;
      box-sizing: border-box;
    }
    .auth-input:focus {
      border-color: #C0C0C0;
    }
    .auth-btn {
      background: #1B2E5E;
      color: #C0C0C0;
      border: none;
      padding: 13px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 3px;
      cursor: pointer;
      text-transform: uppercase;
      transition: background 0.2s;
      width: 100%;
    }
    .auth-btn:hover {
      background: #243a78;
    }
    .auth-btn:active {
      background: #152248;
    }
    .auth-error {
      color: #ef4444;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1.5px;
      text-align: center;
      min-height: 16px;
      text-transform: uppercase;
    }
    @keyframes auth-shake {
      0%, 100% { transform: translateX(0); }
      15%, 45%, 75% { transform: translateX(-10px); }
      30%, 60%, 90% { transform: translateX(10px); }
    }
    .auth-shake {
      animation: auth-shake 0.5s ease;
    }
  `;
  document.head.appendChild(style);
}

export function isAuthenticated(): boolean {
  return localStorage.getItem(AUTH_KEY) === AUTH_TOKEN;
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY);
}

export function showAuthGate(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (isAuthenticated()) {
      resolve();
      return;
    }

    injectAuthStyles();

    const overlay = document.createElement('div');
    overlay.id = 'rudraas-auth-gate';
    overlay.innerHTML = `
      <div class="auth-panel">
        <img src="/Rudraas_Dynamics_EMBLEM.png" class="auth-emblem" alt="RUDRAAS" onerror="this.style.display='none'" />
        <div class="auth-restricted">⚠ RESTRICTED ACCESS — AUTHORIZED PERSONNEL ONLY</div>
        <div class="auth-title">RUDRAAS INTELLIGENCE COMMAND</div>
        <div class="auth-form">
          <input
            type="password"
            id="authPassword"
            class="auth-input"
            placeholder="ENTER ACCESS CODE"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
          />
          <button id="authSubmit" class="auth-btn">AUTHENTICATE</button>
          <div id="authError" class="auth-error" aria-live="polite"></div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector<HTMLInputElement>('#authPassword')!;
    const btn = overlay.querySelector<HTMLButtonElement>('#authSubmit')!;
    const errorEl = overlay.querySelector<HTMLDivElement>('#authError')!;
    const panel = overlay.querySelector<HTMLDivElement>('.auth-panel')!;

    setTimeout(() => input.focus(), 80);

    function tryAuth(): void {
      const pw = input.value;
      try {
        if (btoa(pw) === AUTH_TOKEN) {
          localStorage.setItem(AUTH_KEY, AUTH_TOKEN);
          errorEl.textContent = '';
          overlay.style.opacity = '0';
          setTimeout(() => {
            overlay.remove();
            resolve();
          }, 620);
        } else {
          onWrongPassword();
        }
      } catch {
        onWrongPassword();
      }
    }

    function onWrongPassword(): void {
      errorEl.textContent = 'ACCESS DENIED — INVALID CREDENTIALS';
      input.value = '';
      panel.classList.remove('auth-shake');
      void panel.offsetWidth; // force reflow to restart animation
      panel.classList.add('auth-shake');
      panel.addEventListener('animationend', () => panel.classList.remove('auth-shake'), { once: true });
      setTimeout(() => input.focus(), 20);
    }

    btn.addEventListener('click', tryAuth);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryAuth();
      if (errorEl.textContent) errorEl.textContent = '';
    });
  });
}
