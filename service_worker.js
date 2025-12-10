// service_worker.js
// ========================================================
// 🧠 PhishingNet Service Worker (FINAL STABLE)
// Handles auto-scan, manual scan, backend requests, and UI updates
// ========================================================

const BACKEND_BASE = "http://127.0.0.1:5000";
const ANALYZE_ENDPOINT = `${BACKEND_BASE}/analyze`;

const CLIP_KEY = "last_clipboard_scanned_text";
const CLIP_TIME_KEY = "last_clipboard_scanned_time";

// Helper functions for storage
function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setStorage(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// ========================================================
// 🔔 MAIN MESSAGE LISTENER
// ========================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (!message || !message.type) return;

      // ========================================================
      // 1️⃣ MANUAL SCAN (From popup “Scan Now”)
      // ========================================================
      
      if (message.type === "MANUAL_URL_SCAN") {
        const url = message.payload?.url?.trim();
        if (!url) return sendResponse({ ok: false, error: "Empty URL" });

        console.log("[PhishingNet] Manual scan:", url);

        const result = await analyze({ url, title: "", text: "" });

        if (!result) {
          sendResponse({ ok: false, error: "No result" });
          return;
        }

        await setStorage({ last_analysis: result, last_url: url });

        // ✅ Respond immediately to popup
        sendResponse({ ok: true, result });

        // Save to history
        chrome.storage.local.get(["history"], (data) => {
          const hist = Array.isArray(data.history) ? data.history : [];
          hist.push({
            url,
            score: result.score,
            phishing: result.phishing,
            time: Date.now(),
            source: "manual",
          });
          while (hist.length > 200) hist.shift();
          chrome.storage.local.set({ history: hist });
        });

        // Show alert + sound if phishing
        if (result.phishing) {
          const riskPercent = result.risk_percentage !== undefined ? result.risk_percentage : Math.round((result.score || 0) * 100);
          const explanation = result.explanation || `Phishing detected (score=${result.score.toFixed(2)})`;
          chrome.notifications.create({
            type: "basic",
            iconUrl: "icons/icon48.png",
            title: "⚠️ PhishingNet Warning - Phishing Detected!",
            message: `⚠️ Risk: ${riskPercent.toFixed(1)}% - ${explanation}`,
            priority: 2, // High priority for phishing warnings
          });

          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = tabs[0]?.id;
          if (tabId) {
            try {
              chrome.tabs.sendMessage(tabId, { type: "PLAY_WARN_SOUND" }, () => {
                // ignore if no listener is present on the tab
                void chrome.runtime.lastError;
              });
            } catch(_) {}
          }
        }
        return;
      }

      // ========================================================
      // 2️⃣ AUTO CLIPBOARD SCAN
      // ========================================================
    
      if (message.type === 'AUTO_CLIPBOARD_COPIED') {
        const text = (message.payload?.text || '').trim();
        if (!text) return sendResponse({ ok: false, reason: 'empty' });

        const cfg = await getStorage(['auto_scan_clipboard','notif_enabled','notif_phishing_only']);
        if (!cfg || !cfg.auto_scan_clipboard) {
          return sendResponse({ ok: false, reason: 'auto_scan_disabled' });
        }

        const s = await getStorage([CLIP_KEY, CLIP_TIME_KEY]);
        const prevText = s[CLIP_KEY] || '';
        const prevTime = s[CLIP_TIME_KEY] || 0;
        const now = Date.now();
        if (text === prevText && (now - prevTime) < 10000) {
          return sendResponse({ ok: false, reason: 'duplicate_recent' });
        }
        await setStorage({ [CLIP_KEY]: text, [CLIP_TIME_KEY]: now });

        // call backend (with fallback to heuristic)
        const result = await analyze({ url: text, title: '', text: '' });
        if (!result) return sendResponse({ ok: false, error: 'backend_failed' });

        await setStorage({ last_analysis: result, last_url: text });
        sendResponse({ ok: true, result });
         chrome.storage.local.get(['history'], (data) => {
          const hist = Array.isArray(data.history) ? data.history : [];
          hist.push({ url: text, score: result.score, phishing: result.phishing, time: Date.now(), source: 'clipboard' });
          while (hist.length > 200) hist.shift();
          chrome.storage.local.set({ history: hist, last_analysis: result, last_auto_scan_url: text, last_auto_scan_result: result });
        });

        // Show toast in active tab with detailed explanation and percentage
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (tabId) {
          // Build message with percentage
          let popupMsg = result.explanation || '';
          if (result.phishing && result.risk_percentage !== undefined) {
            popupMsg = `Risk: ${result.risk_percentage.toFixed(1)}% - ${popupMsg}`;
          } else if (!result.phishing && result.safety_percentage !== undefined) {
            popupMsg = `Safe: ${result.safety_percentage.toFixed(1)}% - ${popupMsg}`;
          }
          showPagePopup(tabId, text, result.phishing, popupMsg);
        }
        // Respect notification settings
        const notifEnabled = cfg.notif_enabled !== false; // default true
        const phishingOnly = cfg.notif_phishing_only === true;
        if (notifEnabled && (!phishingOnly || result.phishing)) {
          if (result.phishing) {
            // Phishing warning notification with prominent warning and risk percentage
            const riskPercent = result.risk_percentage !== undefined ? result.risk_percentage : Math.round((result.score || 0) * 100);
            const explanation = result.explanation || `Phishing detected (score=${result.score.toFixed(2)})`;
            try {
              chrome.notifications.create({ 
                type: 'basic', 
                iconUrl: 'icons/icon48.png', 
                title: '⚠️ PhishingNet Warning - Phishing Detected!',
                message: `⚠️ Risk: ${riskPercent.toFixed(1)}% - ${explanation}`,
                priority: 2 // High priority
              });
            } catch(_) {}
          } else {
            // Safe notification with safety percentage
            const safetyPercent = result.safety_percentage !== undefined ? result.safety_percentage : Math.round((1.0 - (result.score || 0)) * 100);
            try {
              chrome.notifications.create({ 
                type: 'basic', 
                iconUrl: 'icons/icon48.png', 
                title: '✅ PhishingNet Result',
                message: `✅ Safe: ${safetyPercent.toFixed(1)}% - Link appears safe`
              });
            } catch(_) {}
          }
        }
        return;
      }


      // ========================================================
      // 3️⃣ SOUND CONTROL
      // ========================================================
      if (["PLAY_WARN_SOUND", "PLAY_SAFE_SOUND", "STOP_SOUND"].includes(message.type)) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const t = tabs && tabs[0];
        if (t?.id) {
          try {
            chrome.tabs.sendMessage(t.id, { type: message.type }, () => {
              // ignore absence of receiver
              void chrome.runtime.lastError;
            });
          } catch(_) {}
        }
        // Also send to all tabs to ensure sound stops everywhere
        if (message.type === "STOP_SOUND") {
          try {
            const allTabs = await chrome.tabs.query({});
            allTabs.forEach(tab => {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, { type: 'STOP_SOUND' }, () => {
                  void chrome.runtime.lastError;
                });
              }
            });
          } catch(_) {}
        }
        return;
      }

      // ========================================================
      // 4️⃣ TOGGLE CLIPBOARD WATCHER (Fix ReferenceError)
      // ========================================================
      if (message.type === "AUTO_SCAN_CLIPBOARD_TOGGLE") {
        await toggleClipboardWatcher(Boolean(message.payload?.enabled));
        sendResponse({ ok: true });
        return;
      }

    } catch (err) {
      console.error("Service worker message error:", err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();

  return true; // keep channel open for async sendResponse
});

// ========================================================
// 📋 TOGGLE CLIPBOARD WATCHER (safe stub)
// ========================================================
async function toggleClipboardWatcher(enabled) {
  console.log("Clipboard watcher is now", enabled ? "ON" : "OFF");
  await setStorage({ auto_scan_clipboard: enabled });
}

// ========================================================
// 🧠 ANALYSIS LOGIC (Backend + Heuristic Fallback)
// ========================================================
async function analyze(body) {
  try {
    const resp = await fetch(ANALYZE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error('backend returned non-ok');
    const result = await resp.json();
    // Add explanation if backend doesn't provide one
    if (!result || typeof result !== 'object') return result;
    if (!result.explanation) {
      try { result.explanation = buildExplanation(body?.url || '', result); } catch(_) {}
    }
    return result;
  } catch (e) {
    console.warn("Backend unreachable, using heuristic:", e);
    return heuristicAnalyze(body);
  }
}

function heuristicAnalyze(body) {
  const url = (body?.url || '').toLowerCase();
  let score = 0.08;
  const flags = [];
  const reasons = [];
  
  // Enhanced detection - more thorough
  const suspiciousKeywords = /\b(login|signin|secure|update|verify|account|confirm|bank|paypal|webscr|password|reset|unlock|suspended|expired|urgent)\b/;
  const keywordMatches = (url.match(suspiciousKeywords) || []).length;
  if (keywordMatches > 0) {
    score += Math.min(0.45, keywordMatches * 0.15);
    flags.push(`Suspicious keywords in URL (${keywordMatches} found)`);
    if (keywordMatches >= 3) {
      reasons.push({
        type: 'high',
        title: 'Multiple Suspicious Keywords',
        description: 'The URL contains multiple phishing-related keywords. Legitimate sites rarely combine these words in URLs.'
      });
    } else {
      reasons.push({
        type: 'medium',
        title: 'Suspicious Keywords Detected',
        description: 'The URL contains keywords commonly used in phishing attacks to create urgency or mimic trusted services.'
      });
    }
  }
  
  try {
    const fullUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    const h = new URL(fullUrl).hostname;
    
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      score += 0.35;
      flags.push('IP address used as hostname');
      reasons.push({
        type: 'critical',
        title: 'IP Address in URL',
        description: 'Legitimate websites use domain names, not IP addresses. This is a strong indicator of phishing.'
      });
    }
    
    const dotCount = (h.match(/\./g)||[]).length;
    if (dotCount >= 3) {
      score += 0.15;
      flags.push('Unusually many subdomains');
      reasons.push({
        type: 'medium',
        title: 'Too Many Subdomains',
        description: 'The URL has an excessive number of subdomains, which is uncommon for legitimate sites.'
      });
    }
    
    if (/^xn--/.test(h)) {
      score += 0.12;
      flags.push('Punycode domain (look-alike risk)');
      reasons.push({
        type: 'medium',
        title: 'Punycode Domain Detected',
        description: 'This domain uses Punycode encoding, which can be used to create look-alike domains that appear legitimate but are actually different.'
      });
    }
    
    const suspiciousTlds = /\.(zip|mov|ru|tk|cn|top|gq|ml|ga|cf|xyz|click)(?:[:/]|$)/;
    if (suspiciousTlds.test(url)) {
      score += 0.1;
      const tldMatch = url.match(/\.([a-z]{2,6})(?:[:/]|$)/i);
      const tld = tldMatch ? tldMatch[1] : 'suspicious TLD';
      flags.push(`Suspicious or abused TLD (.${tld})`);
      reasons.push({
        type: 'high',
        title: `Suspicious Top-Level Domain (.${tld})`,
        description: `This TLD is frequently abused by phishers because it's cheap and has lax registration policies.`
      });
    }
    
    // Check for URL shorteners
    const shorteners = ['bit.ly', 'tinyurl', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'short.link', 'cutt.ly'];
    if (shorteners.some(s => url.includes(s))) {
      score += 0.25;
      flags.push('URL shortener detected');
      reasons.push({
        type: 'high',
        title: 'URL Shortener Detected',
        description: 'URL shorteners hide the true destination, making it impossible to verify legitimacy before clicking.'
      });
    }
    
  } catch (_) {}
  
  if (url.length > 75) {
    score += 0.12;
    flags.push('Very long URL');
    if (!reasons.some(r => r.title.includes('Long URL'))) {
      reasons.push({
        type: 'medium',
        title: 'Very Long URL',
        description: 'The URL is unusually long, which phishers use to hide malicious content or make URLs look complex.'
      });
    }
  }
  
  if ((url.match(/[-_]/g)||[]).length > 6) {
    score += 0.08;
    flags.push('Excessive separators (- or _)');
  }
  
  if (/^http:\/\//.test(url)) {
    score += 0.08;
    flags.push('Not using HTTPS');
    reasons.push({
      type: 'high',
      title: 'No HTTPS Encryption',
      description: 'This site uses HTTP instead of HTTPS, meaning your connection is not encrypted. Legitimate sites handling sensitive information always use HTTPS.'
    });
  } else if (/^https:\/\//.test(url) && !reasons.length) {
    // Only add safe reason if no phishing reasons found
    reasons.push({
      type: 'positive',
      title: 'Uses HTTPS Encryption',
      description: 'The site uses HTTPS, which encrypts your connection and is a standard security practice.'
    });
  }
  
  if (score > 1) score = 1;
  
  // CRITICAL: Check for critical indicators that ALWAYS flag as phishing
  const criticalFlags = [
    /^\d+\.\d+\.\d+\.\d+$/.test((() => {
      try {
        const fullUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
        return new URL(fullUrl).hostname;
      } catch { return ''; }
    })()),  // IP address
    url.includes('@'),  // @ symbol
    keywordMatches >= 3,  // 3+ suspicious keywords
    shorteners.some(s => url.includes(s)),  // URL shortener
    suspiciousTlds.test(url),  // Suspicious TLD
    /^http:\/\//.test(url) && !/^https:\/\//.test(url),  // HTTP only
  ];
  
  // If any critical indicator is present, ALWAYS flag as phishing
  const hasCritical = criticalFlags.some(flag => flag === true);
  const phishing = hasCritical || score > 0.25; // More aggressive threshold
  
  // Calculate safety and risk percentages
  const safety_percentage = Math.max(0, Math.min(100, (1.0 - score) * 100));
  const risk_percentage = Math.max(0, Math.min(100, score * 100));
  
  return {
    score: Number(score.toFixed(3)),
    phishing,
    heuristic: true,
    safety_percentage: Math.round(safety_percentage * 10) / 10, // Round to 1 decimal
    risk_percentage: Math.round(risk_percentage * 10) / 10, // Round to 1 decimal
    explanation: buildExplanation(url, { score, phishing, reasons: flags }),
    reasons: reasons.length > 0 ? reasons : undefined
  };
}

// Build a concise human explanation from flags/score
function buildExplanation(url, result){
  const reasons = Array.isArray(result?.reasons) ? result.reasons.slice(0) : [];
  const u = (url||'').toLowerCase();
  
  // If we have structured reasons (from backend or enhanced heuristic), use them
  if (result?.reasons && Array.isArray(result.reasons) && result.reasons.length > 0 && typeof result.reasons[0] === 'object') {
    const critical = result.reasons.find(r => r.type === 'critical');
    const high = result.reasons.find(r => r.type === 'high');
    const topReason = critical || high || result.reasons[0];
    return topReason ? `${topReason.title}. ${topReason.description}` : 'Multiple risk signals detected.';
  }
  
  // Derive reasons if not provided (fallback)
  if (!reasons.length){
    try {
      const host = new URL(/^https?:\/\//i.test(u)?u:`http://${u}`).hostname;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) reasons.push('IP address used as hostname');
      if ((host.match(/\./g)||[]).length >= 3) reasons.push('Unusually many subdomains');
      if (/^xn--/.test(host)) reasons.push('Punycode domain (look-alike risk)');
    } catch(_) {}
    if (/\b(login|signin|secure|update|verify|account|confirm|bank|paypal|webscr)\b/.test(u)) reasons.push('Suspicious keywords in URL');
    if (u.length > 75) reasons.push('Very long URL');
    if ((u.match(/[-_]/g)||[]).length > 6) reasons.push('Excessive separators (- or _)');
    if (/^http:\/\//.test(u)) reasons.push('Not using HTTPS');
  }
  
  const isSafe = !result?.phishing;
  if (isSafe) {
    return '✅ SAFE: No suspicious patterns detected. Uses expected domain structure and appears safe.';
  }
  if (!reasons.length) return '⚠️ PHISHING DETECTED: Multiple risk signals detected in the URL structure.';
  // Return top 2-3 reasons
  const top = reasons.slice(0,3).join('; ');
  return `⚠️ PHISHING DETECTED: ${top}.`;
}

// ========================================================
// 🔔 PAGE TOAST POPUP (Enhanced with detailed info)
// ========================================================
async function showPagePopup(tabId, message, isPhishing, explanation) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg, phishing, expl) => {
        const old = document.getElementById("phn-toast");
        if (old) old.remove();
        const toast = document.createElement("div");
        toast.id = "phn-toast";
        
        // Create toast content with explanation
        const shortMsg = msg.length > 50 ? msg.substring(0, 47) + '...' : msg;
        const displayText = expl && expl.length > 0 ? expl : (phishing ? `⚠️ PHISHING DETECTED` : `✅ SAFE LINK`);
        
        toast.innerHTML = `
          <div style="font-weight: 600; margin-bottom: 4px;">${displayText}</div>
          <div style="font-size: 12px; opacity: 0.9;">${shortMsg}</div>
        `;
        
        toast.style.cssText = `
          position:fixed;bottom:20px;right:20px;
          background:${phishing ? "#c0392b" : "#27ae60"};
          color:white;padding:12px 18px;border-radius:8px;
          font-family:sans-serif;font-size:14px;
          z-index:9999999;box-shadow:0 4px 12px rgba(0,0,0,.4);
          max-width: 320px;
          line-height: 1.4;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 6000); // Show longer for detailed info
      },
      args: [message, isPhishing, explanation],
    });
  } catch (err) {
    console.warn("Popup inject failed:", err);
  }
}

// ========================================================
// ✅ END OF SERVICE WORKER
// ========================================================
