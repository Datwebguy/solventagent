// Wallet picker for any Solana wallet.
// - Finds wallets installed in this browser through the Wallet Standard (Phantom, Solflare,
//   Backpack, Glow, OKX, Jupiter, ...), plus the older window.* injections as a fallback.
// - On a phone browser with no wallet inside it, offers to open this page in a wallet app's
//   own browser (each wallet's official "browse" link), where the wallet can connect.
// Exposes window.SolWallet = { pick(), onChange(fn) }.
(() => {
  const CHAIN = "solana:mainnet";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

  // ---- Wallet Standard discovery ----
  const standard = [];
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => { try { fn(); } catch {} });
  function register(...wallets) {
    for (const w of wallets) {
      if (!w || standard.includes(w)) continue;
      const solana = (w.chains || []).some((c) => String(c).startsWith("solana:"));
      if (solana && w.features?.["standard:connect"]) { standard.push(w); changed(); }
    }
    return () => {};
  }
  const api = Object.freeze({ register });
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail?.(api); } catch {} });
  try { window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api })); } catch {}

  // ---- base58 (for signatures returned as bytes) ----
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58(bytes) {
    const digits = [0];
    for (const byte of bytes) {
      let carry = byte;
      for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
      while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = "";
    for (const byte of bytes) { if (byte === 0) out += "1"; else break; }
    for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
    return out;
  }
  const serialize = (tx) => (tx.version !== undefined ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false }));

  // ---- adapters: one shape for every wallet ----
  // { name, icon, connect() -> address, signAndSend(tx, web3, connection) -> signature, disconnect() }
  function fromStandard(w) {
    let account = null;
    return {
      name: w.name,
      icon: w.icon,
      async connect() {
        const res = await w.features["standard:connect"].connect();
        const accounts = res?.accounts?.length ? res.accounts : w.accounts;
        account = accounts?.find((a) => (a.chains || [CHAIN]).some((c) => String(c).startsWith("solana:"))) || accounts?.[0];
        if (!account) throw new Error("The wallet didn't share an account. Please try again.");
        return account.address;
      },
      async signAndSend(tx, web3, connection) {
        const bytes = serialize(tx);
        const send = w.features["solana:signAndSendTransaction"];
        if (send) {
          const [out] = await send.signAndSendTransaction({ account, chain: CHAIN, transaction: bytes });
          return typeof out.signature === "string" ? out.signature : b58(out.signature);
        }
        const sign = w.features["solana:signTransaction"];
        if (!sign) throw new Error("This wallet can't approve payments here. Please pick another wallet.");
        const [out] = await sign.signTransaction({ account, chain: CHAIN, transaction: bytes });
        return connection.sendRawTransaction(out.signedTransaction, { maxRetries: 3 });
      },
      async disconnect() { try { await w.features["standard:disconnect"]?.disconnect(); } catch {} },
    };
  }
  function fromLegacy(name, icon, p) {
    return {
      name,
      icon,
      async connect() {
        const res = await p.connect();
        const pk = res?.publicKey || p.publicKey;
        if (!pk) throw new Error("The wallet didn't share an account. Please try again.");
        return pk.toBase58 ? pk.toBase58() : String(pk);
      },
      async signAndSend(tx, web3, connection) {
        if (p.signAndSendTransaction) {
          const out = await p.signAndSendTransaction(tx);
          const sig = out?.signature ?? out;
          return typeof sig === "string" ? sig : b58(sig);
        }
        const signed = await p.signTransaction(tx);
        return connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
      },
      async disconnect() { try { await p.disconnect?.(); } catch {} },
    };
  }
  const legacyList = () => [
    ["Phantom", window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null)],
    ["Solflare", window.solflare?.isSolflare ? window.solflare : null],
    ["Backpack", window.backpack?.isBackpack ? window.backpack : null],
    ["Glow", window.glowSolana || null],
    ["OKX Wallet", window.okxwallet?.solana || null],
    ["Coinbase Wallet", window.coinbaseSolana || null],
    ["Trust Wallet", window.trustwallet?.solana || null],
    ["Solana wallet", window.solana || null],
  ];
  function detected() {
    const list = standard.map(fromStandard);
    const have = new Set(list.map((w) => w.name.toLowerCase()));
    const seen = new Set();
    for (const [name, p] of legacyList()) {
      if (!p || seen.has(p) || typeof p.connect !== "function") continue;
      seen.add(p);
      if ([...have].some((n) => n.includes(name.toLowerCase().split(" ")[0]))) continue;
      if (name === "Solana wallet" && list.length) continue;
      list.push(fromLegacy(name, null, p));
      have.add(name.toLowerCase());
    }
    return list;
  }

  // ---- wallet apps a phone can open this page in ----
  function appLinks() {
    const here = new URL(location.href);
    here.searchParams.set("connect", "1");
    const url = encodeURIComponent(here.toString());
    const ref = encodeURIComponent(location.origin);
    return [
      { name: "Phantom", color: "#ab9ff2", href: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
      { name: "Solflare", color: "#fc7227", href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
      { name: "Backpack", color: "#e33e3f", href: `https://backpack.app/ul/v1/browse/${url}?ref=${ref}` },
      { name: "Trust Wallet", color: "#3375bb", href: `https://link.trustwallet.com/open_url?coin_id=501&url=${url}` },
    ];
  }
  const GET = [
    { name: "Phantom", color: "#ab9ff2", href: "https://phantom.com/download" },
    { name: "Solflare", color: "#fc7227", href: "https://solflare.com/download" },
    { name: "Backpack", color: "#e33e3f", href: "https://backpack.app/downloads" },
  ];

  // ---- the picker ----
  const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeIcon = (src) => (typeof src === "string" && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/i.test(src.trim()) ? src.trim() : null);
  const badge = (name, color, icon) =>
    icon ? `<img class="wp-icon" src="${escHtml(icon)}" alt="" />` : `<span class="wp-icon wp-letter" style="background:${color || "var(--surface-2)"}">${escHtml(name[0])}</span>`;

  let dialog;
  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("div");
    dialog.className = "wp-backdrop";
    dialog.hidden = true;
    dialog.innerHTML = `<div class="wp-sheet" role="dialog" aria-modal="true" aria-labelledby="wpTitle">
      <div class="wp-head"><h2 id="wpTitle">Connect a wallet</h2><button class="icon-btn wp-close" type="button" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="wp-body"></div></div>`;
    document.body.appendChild(dialog);
    return dialog;
  }

  /** Opens the picker. Resolves with { name, address, signAndSend, disconnect } or rejects if closed. */
  function pick() {
    const d = ensureDialog();
    return new Promise((resolve, reject) => {
      const body = d.querySelector(".wp-body");
      let done = false;
      const close = (err) => {
        if (done) return;
        done = true;
        d.hidden = true;
        document.documentElement.classList.remove("wp-open");
        listeners.delete(render);
        document.removeEventListener("keydown", onKey);
        if (err) reject(err);
      };
      const onKey = (e) => { if (e.key === "Escape") close(Object.assign(new Error("closed"), { closed: true })); };

      function render() {
        const wallets = detected();
        let html = "";
        if (wallets.length) {
          html += `<p class="wp-note">Pick the wallet you want to use.</p><div class="wp-list">` +
            wallets.map((w, i) => `<button class="wp-item" type="button" data-i="${i}">${badge(w.name, null, safeIcon(w.icon))}<span>${escHtml(w.name)}</span><span class="wp-tag">Found</span></button>`).join("") +
            `</div>`;
        } else if (isMobile) {
          html += `<p class="wp-note">Choose your wallet app. This page opens inside it, and you can connect from there.</p><div class="wp-list">` +
            appLinks().map((a) => `<a class="wp-item" href="${escHtml(a.href)}" rel="noopener">${badge(a.name, a.color)}<span>${escHtml(a.name)}</span><span class="wp-tag">Open app</span></a>`).join("") +
            `</div>`;
        } else {
          html += `<p class="wp-note">We couldn't find a Solana wallet in this browser. Add one, then refresh this page.</p>`;
        }
        if (!wallets.length || !isMobile) {
          html += `<details class="wp-more"${wallets.length || isMobile ? "" : " open"}><summary>Don't have a wallet yet?</summary><div class="wp-list">` +
            GET.map((a) => `<a class="wp-item" href="${a.href}" target="_blank" rel="noopener">${badge(a.name, a.color)}<span>Get ${escHtml(a.name)}</span><span class="wp-tag">Free</span></a>`).join("") +
            `</div></details>`;
        }
        body.innerHTML = html;
        body.querySelectorAll("button.wp-item").forEach((b) => {
          b.onclick = async () => {
            const w = wallets[Number(b.dataset.i)];
            body.querySelectorAll("button.wp-item").forEach((x) => (x.disabled = true));
            b.querySelector(".wp-tag").textContent = "Approve in wallet…";
            try {
              const address = await w.connect();
              close();
              resolve({ name: w.name, address, signAndSend: w.signAndSend, disconnect: w.disconnect });
            } catch (e) {
              close(e);
            }
          };
        });
      }

      d.querySelector(".wp-close").onclick = () => close(Object.assign(new Error("closed"), { closed: true }));
      d.onclick = (e) => { if (e.target === d) close(Object.assign(new Error("closed"), { closed: true })); };
      document.addEventListener("keydown", onKey);
      listeners.add(render); // a wallet that registers late shows up straight away
      render();
      d.hidden = false;
      document.documentElement.classList.add("wp-open");
      d.querySelector(".wp-item, .wp-close")?.focus();
    });
  }

  window.SolWallet = { pick, isMobile, onChange: (fn) => listeners.add(fn), detected };
})();
