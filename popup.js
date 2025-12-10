// popup.js (updated)
// Replaces the existing popup.js. More robust handlers, loading state, and fallback to active tab URL.

const HISTORY_KEY = 'history'; // array of {url, score, phishing, time}

function formatDomain(u) {
  try { return new URL(u).hostname; } catch { return u; }
}

function formatWhen(ts) {
  try {
    const d = new Date(ts || Date.now());
    return d.toLocaleString();
  } catch { return ''; }
}

function renderHistory(listEl, entries) {
  if (!listEl) return;
  listEl.innerHTML = '';
  (entries || []).slice().reverse().forEach((e) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="meta"><span class="domain">${formatDomain(e.url)}</span><span class="time">${formatWhen(e.time)}</span></span><span class="status ${e.phishing ? 'phishing' : 'safe'}">${e.phishing ? 'PHISHING' : 'SAFE'}</span>`;
    listEl.appendChild(li);
  });
}

function sendMessageAsync(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        // chrome.runtime.lastError may be set
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      });
    } catch (err) {
      resolve({ error: err.message || String(err) });
    }
  });
}

function setToast(msg, phishing) {
  const toast = document.getElementById('popup-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = 'popup-toast' + (phishing ? ' phishing' : '');
  toast.style.display = '';
  clearTimeout(setToast._timer);
  setToast._timer = setTimeout(() => {
    toast.style.display = 'none';
  }, 2200);
}

// Listen for real-time auto-scan result updates when popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.last_auto_scan_result) {
    const result = changes.last_auto_scan_result.newValue;
    if (result && typeof result.phishing === 'boolean') {
      setToast(result.phishing ? 'PHISHING Detected!' : 'SAFE Link!', result.phishing);
      // If results view is open, live-update UI with accurate percentage
      const isSafe = !result.phishing;
      const safety = result.safety_percentage !== undefined ? result.safety_percentage : (isSafe ? 100 : Math.max(0, 100 - (result.score || 0) * 100));
      const risk = result.risk_percentage !== undefined ? result.risk_percentage : (!isSafe ? Math.max(0, (result.score || 0) * 100) : 0);
      
      if (document.getElementById('view-results') && document.getElementById('view-results').style.display !== 'none') {
        const resultPercent = document.getElementById('result-percent');
        const resultNote = document.getElementById('result-note');
        const finalState = document.getElementById('final-state');
        const pillLabel = document.getElementById('pill-label');
        const resultRisk = document.getElementById('result-risk');
        const resultRiskPercent = document.getElementById('result-risk-percent');
        
        if (pillLabel) pillLabel.textContent = isSafe ? 'Safety' : 'Risk';
        if (resultPercent) {
          if (isSafe) {
            animatePercent(resultPercent, safety);
          } else {
            animatePercent(resultPercent, risk);
          }
        }
        if (resultRisk && resultRiskPercent) {
          if (!isSafe && risk > 0) {
            resultRisk.style.display = 'flex';
            animatePercent(resultRiskPercent, risk);
          } else {
            resultRisk.style.display = 'none';
          }
        }
        if (resultNote) {
          const percentText = isSafe 
            ? `Safe: ${safety.toFixed(1)}% - ${result.explanation || 'Safe content'}`
            : `Risk: ${risk.toFixed(1)}% - ${result.explanation || 'Risky content'}`;
          resultNote.textContent = percentText;
        }
        // Display detailed reasons if available
        const reasonsEl = document.getElementById('result-reasons');
        if (reasonsEl && result && result.reasons && Array.isArray(result.reasons) && result.reasons.length > 0) {
          reasonsEl.innerHTML = '';
          result.reasons.slice(0, 3).forEach(reason => {
            if (typeof reason === 'object' && reason.title) {
              const reasonDiv = document.createElement('div');
              reasonDiv.className = `reason-item ${reason.type || 'medium'}`;
              reasonDiv.innerHTML = `
                <div class="reason-title">${reason.title}</div>
                <div class="reason-description">${reason.description || ''}</div>
              `;
              reasonsEl.appendChild(reasonDiv);
            }
          });
          reasonsEl.style.display = 'flex';
        } else if (reasonsEl) {
          reasonsEl.style.display = 'none';
        }
        if (finalState) { finalState.textContent = isSafe ? 'SAFE' : 'PHISHING'; finalState.className = `btn state-btn ${isSafe ? 'safe' : 'phishing'}`; }
      }
    }
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const $ = (id) => document.getElementById(id);

  // elements
  const bigStatus = $('big-status');
  const manualUrl = $('manual-url');
  const manualBtn = $('manual-scan');
  const lastScanned = $('last-scanned');
  const histEl = $('history');
  const lastAutoScan = $('last-auto-scan');
  const phishModal = $('phish-modal');
  const phishBack = $('phish-back');
  const phishProceed = $('phish-proceed');
  const notifPhishingOnly = $('notif-phishing-only');
  const notifSound = $('notif-sound');

  // nav & views
  const navHome = $('nav-home');
  const navHistory = $('nav-history');
  const navSettings = $('nav-settings');
  const viewHome = $('view-home');
  const viewResults = $('view-results');
  const viewHistory = $('view-history');
  const viewSettings = $('view-settings');

  // results
  const resultUrl = $('result-url');
  const resultPercent = $('result-percent');
  const resultNote = $('result-note');
  const finalState = $('final-state');

  // settings
  const autoScanToggle = $('auto-scan-clipboard');
  const notifToggle = $('notif-enabled');
  const backHome = $('back-home');

  // validate required nodes exist (graceful)
  if (!navHome || !navHistory || !navSettings) {
    // minimal fallback: ensure manual scan still works
    console.warn('Some nav elements missing in popup; continuing with core features.');
  }

  // helper to switch visible view
  function switchView(view) {
    if (viewHome) viewHome.style.display = (view === 'home') ? '' : 'none';
    if (viewResults) viewResults.style.display = (view === 'results') ? '' : 'none';
    if (viewHistory) viewHistory.style.display = (view === 'history') ? '' : 'none';
    if (viewSettings) viewSettings.style.display = (view === 'settings') ? '' : 'none';

    if (navHome) navHome.classList.toggle('active', view === 'home' || view === 'results');
    if (navHistory) navHistory.classList.toggle('active', view === 'history');
    if (navSettings) navSettings.classList.toggle('active', view === 'settings');
  }

  function isVisible(el){
    return !!el && el.offsetParent !== null;
  }

  // Smoothly animate percentage to target for better UX
  function animatePercent(targetEl, targetValue) {
    if (!targetEl) return;
    const clamp = (v)=>Math.max(0, Math.min(100, v));
    const startText = String(targetEl.textContent||'').replace(/[^0-9.]/g,'');
    const startVal = isNaN(parseFloat(startText)) ? 0 : parseFloat(startText);
    const from = clamp(startVal);
    const to = clamp(Number(targetValue));
    const duration = 700; // ms
    const start = performance.now();
    function step(now){
      const t = Math.min(1, (now - start) / duration);
      const val = from + (to - from) * t;
      targetEl.textContent = `${val.toFixed(1)}%`;
      if (t < 1 && isVisible(targetEl)) requestAnimationFrame(step);
      else targetEl.textContent = `${to.toFixed(1)}%`;
    }
    requestAnimationFrame(step);
  }

  // local popup playback (favored by autoplay policies when triggered by clicks)
  let popupAudio = null;
  let allAudioInstances = []; // Track all audio instances
  
  function playUiSound(kind){
    try{
      // Stop all existing audio first
      stopAllSounds();
      
      const file = (kind === 'warn') ? 'sounds/Warning sound.wav' : 'sounds/Safe sound.wav';
      const url = chrome.runtime.getURL(file);
      popupAudio = new Audio(url);
      allAudioInstances.push(popupAudio);
      
      // Remove from array when audio ends
      popupAudio.addEventListener('ended', () => {
        const index = allAudioInstances.indexOf(popupAudio);
        if (index > -1) allAudioInstances.splice(index, 1);
        popupAudio = null;
      });
      
      popupAudio.play().catch(()=>{});
    }catch(_){}
  }

  function stopAllSounds(){
    // Stop all popup audio instances immediately
    try { 
      allAudioInstances.forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch(_) {}
      });
      allAudioInstances = [];
      
      if (popupAudio) { 
        try {
          popupAudio.pause(); 
          popupAudio.currentTime = 0;
        } catch(_) {}
        popupAudio = null;
      } 
    } catch(_){}
    
    // Stop sound in content script (active tab) - send immediately
    try { 
      // Send STOP_SOUND to service worker
      chrome.runtime.sendMessage({ type: 'STOP_SOUND' }, () => {
        void chrome.runtime.lastError;
      });
      
      // Also send directly to active tab to stop content script audio
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) {
          // Send multiple times to ensure it's received
          chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_SOUND' }, () => {
            void chrome.runtime.lastError;
          });
          // Send again after small delay to catch any late messages
          setTimeout(() => {
            chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP_SOUND' }, () => {
              void chrome.runtime.lastError;
            });
          }, 50);
        }
      });
      
      // Also send to all tabs to be thorough
      chrome.tabs.query({}, (allTabs) => {
        if (allTabs) {
          allTabs.forEach(tab => {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, { type: 'STOP_SOUND' }, () => {
                void chrome.runtime.lastError;
              });
            }
          });
        }
      });
    } catch(_){}
  }

  function relaySound(kind){
    try { chrome.runtime.sendMessage({ type: kind === 'warn' ? 'PLAY_WARN_SOUND' : 'PLAY_SAFE_SOUND' }); } catch(_){}
  }

  // initial load from storage
  chrome.storage.local.get([
    HISTORY_KEY, 'auto_scan_clipboard', 'notif_enabled',
    'notif_phishing_only', 'notif_sound',
    'last_url', 'last_analysis', 'last_auto_scan_url', 'last_auto_scan_result'
  ], (data) => {
    if (autoScanToggle) autoScanToggle.checked = Boolean(data['auto_scan_clipboard']);
    if (notifToggle) notifToggle.checked = Boolean(data['notif_enabled']);
    if (notifPhishingOnly) notifPhishingOnly.checked = Boolean(data['notif_phishing_only']);
    if (notifSound) notifSound.checked = data['notif_sound'] !== false;
    if (histEl) renderHistory(histEl, data[HISTORY_KEY] || []);

    if (data.last_analysis && bigStatus && lastScanned) {
      const res = data.last_analysis;
      const verdictSafe = !res.phishing;
      bigStatus.textContent = verdictSafe ? 'SAFE' : 'PHISHING';
      bigStatus.className = `state ${verdictSafe ? 'safe' : 'phishing'}`;
      lastScanned.textContent = `Last scanned: ${data.last_url || '—'}`;
    }
    // NEW: show last auto-scan result
    if (lastAutoScan) {
      const url = data.last_auto_scan_url || '—';
      const r = data.last_auto_scan_result;
      let verdict = '';
      if (r) {
        verdict = r.phishing ? 'PHISHING' : 'SAFE';
      }
      lastAutoScan.textContent = `Last auto-scan: ${url}${verdict ? ` - ${verdict}` : ''}`;
    }
  });

  // helper to set loading state on button
  function setLoading(btn, isLoading) {
    if (!btn) return;
    btn.disabled = isLoading;
    btn.textContent = isLoading ? 'Scanning…' : 'Scan now';
    if (isLoading) btn.classList.add('loading'); else btn.classList.remove('loading');
  }

  // manual scan handler: requires manual URL input (no active-tab fallback)
  async function handleManualScan() {
    if (!manualBtn) return;
    setLoading(manualBtn, true);
    try {
      let url = (manualUrl && manualUrl.value || '').trim();
      if (!url) {
        // require user to enter a URL; do not fallback to active tab
        const msg = 'Please enter a URL to scan.';
        console.warn(msg);
        if (resultNote) resultNote.textContent = msg;
        if (finalState) { finalState.textContent = 'ERROR'; finalState.className = 'btn state-btn'; }
        if (manualUrl) {
          manualUrl.focus();
          manualUrl.classList.add('input-error');
          // remove error class after a short delay so user sees it
          setTimeout(() => manualUrl.classList.remove('input-error'), 1800);
        }
        setLoading(manualBtn, false);
        return;
      }

      const response = await sendMessageAsync({ 
  type: 'MANUAL_URL_SCAN', 
  payload: { url } 
});

      // debug log
      console.debug('Manual scan response:', response);

      if (!response) {
        // show error to user in results view
        const msg = 'No response from background/service worker.';
        console.warn(msg);
        if (resultNote) resultNote.textContent = msg;
        if (finalState) { finalState.textContent = 'ERROR'; finalState.className = 'btn state-btn'; }
        switchView('results');
        setLoading(manualBtn, false);
        return;
      }

      // prefer a returned result even if an error field is present (service worker may include a fallback)
      const res = response.result || response; // background may return {result: {...}} or {...}
      if (response.error && !response.result) {
        const msg = response.error || 'Unknown error from background.';
        console.warn('Error response from background:', msg);
        if (resultNote) resultNote.textContent = `Error: ${msg}`;
        if (finalState) { finalState.textContent = 'ERROR'; finalState.className = 'btn state-btn'; }
        switchView('results');
        setLoading(manualBtn, false);
        return;
      }

      // if we have a result but the backend also reported an error, indicate it's a fallback
      if (response.error && response.result) {
        if (resultNote) resultNote.textContent = `Notice: backend unreachable (${response.error}). Showing heuristic result.`;
      }
      if (!res) {
        const msg = 'No result returned from analysis.';
        console.warn(msg, response);
        if (resultNote) resultNote.textContent = msg;
        if (finalState) { finalState.textContent = 'ERROR'; finalState.className = 'btn state-btn'; }
        switchView('results');
        setLoading(manualBtn, false);
        return;
      }

      const isSafe = !res.phishing;
      // Use percentages from backend if available, otherwise calculate
      const safety = res.safety_percentage !== undefined ? res.safety_percentage : ((!res.phishing) ? 100 : Math.max(0, 100 - (res.score || 0) * 100));
      const risk = res.risk_percentage !== undefined ? res.risk_percentage : (res.phishing ? Math.max(0, (res.score || 0) * 100) : 0);

      // update UI
      if (bigStatus) { bigStatus.textContent = isSafe ? 'SAFE' : 'PHISHING'; bigStatus.className = `state ${isSafe ? 'safe' : 'phishing'}`; }
      if (lastScanned) lastScanned.textContent = `Last scanned: ${url}`;

      if (resultUrl) resultUrl.textContent = url;
      
      // Update safety percentage
      const pillLabel = document.getElementById('pill-label');
      if (pillLabel) pillLabel.textContent = isSafe ? 'Safety' : 'Risk';
      
      if (resultPercent) {
        if (isSafe) {
          animatePercent(resultPercent, safety);
        } else {
          animatePercent(resultPercent, risk);
        }
      }
      
      // Show/hide risk percentage
      const resultRisk = document.getElementById('result-risk');
      const resultRiskPercent = document.getElementById('result-risk-percent');
      if (resultRisk && resultRiskPercent) {
        if (!isSafe && risk > 0) {
          resultRisk.style.display = 'flex';
          animatePercent(resultRiskPercent, risk);
        } else {
          resultRisk.style.display = 'none';
        }
      }
      
      if (resultNote) {
        const percentText = isSafe 
          ? `Safe: ${safety.toFixed(1)}% - ${(res && res.explanation) ? res.explanation : 'Safe content'}`
          : `Risk: ${risk.toFixed(1)}% - ${(res && res.explanation) ? res.explanation : 'Risky content'}`;
        resultNote.textContent = percentText;
      }
      if (finalState) { finalState.textContent = isSafe ? 'SAFE' : 'PHISHING'; finalState.className = `btn state-btn ${isSafe ? 'safe' : 'phishing'}`; }
      
      // Display detailed reasons if available
      const reasonsEl = document.getElementById('result-reasons');
      if (reasonsEl && res && res.reasons && Array.isArray(res.reasons) && res.reasons.length > 0) {
        reasonsEl.innerHTML = '';
        res.reasons.slice(0, 3).forEach(reason => {
          if (typeof reason === 'object' && reason.title) {
            const reasonDiv = document.createElement('div');
            reasonDiv.className = `reason-item ${reason.type || 'medium'}`;
            reasonDiv.innerHTML = `
              <div class="reason-title">${reason.title}</div>
              <div class="reason-description">${reason.description || ''}</div>
            `;
            reasonsEl.appendChild(reasonDiv);
          }
        });
        reasonsEl.style.display = 'flex';
      } else if (reasonsEl) {
        reasonsEl.style.display = 'none';
      }

      // show phishing warning modal if risky
				if (!isSafe && phishModal) {
        // Play locally (user interaction) and also via active tab
        chrome.storage.local.get(['notif_sound'], (cfg) => {
          if (cfg.notif_sound !== false) { playUiSound('warn'); relaySound('warn'); }
        });
        phishModal.style.display = '';
					if (phishBack) {
            // Remove any existing handlers and add new one with immediate sound stop
            phishBack.onclick = null;
            phishBack.addEventListener('click', function(e) {
              e.preventDefault();
              e.stopImmediatePropagation();
              // STOP SOUND IMMEDIATELY - FIRST THING, BEFORE ANYTHING ELSE
              stopAllSounds();
              phishModal.style.display = 'none';
              // Keep the Results view visible so user can review details
              switchView('results');
            }, true); // Use capture phase for immediate execution
          }
					if (phishProceed) {
            // Remove any existing handlers and add new one with immediate sound stop
            phishProceed.onclick = null;
            phishProceed.addEventListener('click', function(e) {
              e.preventDefault();
              e.stopImmediatePropagation();
              // STOP SOUND IMMEDIATELY - FIRST THING, BEFORE ANYTHING ELSE
              stopAllSounds();
              const confirmMsg = 'Warning: This link was flagged as phishing. Do you still want to proceed?';
              const proceed = window.confirm(confirmMsg);
              if (proceed) {
                try {
                  // Ensure protocol to avoid chrome rejecting bare domains
                  const openUrl = /^https?:\/\//i.test(url) ? url : `http://${url}`;
                  chrome.tabs.create({ url: openUrl });
                } catch (_) {
                  try { window.open(url, '_blank', 'noopener'); } catch(_) {}
                }
                phishModal.style.display = 'none';
                // Keep popup open on Results so the user can still see details
                switchView('results');
              } else {
                phishModal.style.display = 'none';
                // Stay on Results even if user cancels proceed
                switchView('results');
              }
            }, true); // Use capture phase for immediate execution
          }
      }

      // play safe sound when link is safe
      if (isSafe) {
        chrome.storage.local.get(['notif_sound'], (cfg) => {
          if (cfg.notif_sound !== false) { playUiSound('safe'); relaySound('safe'); }
        });
      }

      // update history
      chrome.storage.local.get([HISTORY_KEY], (data) => {
        const hist = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
        hist.push({ url, score: res.score, phishing: res.phishing, time: Date.now() });
        while (hist.length > 100) hist.shift();
        chrome.storage.local.set({ [HISTORY_KEY]: hist }, () => { if (histEl) renderHistory(histEl, hist); });
      });

      // switch to results view
      switchView('results');
    } catch (err) {
      console.error('Manual scan failed:', err);
    } finally {
      setLoading(manualBtn, false);
    }
  }

  // wire manual button click
  if (manualBtn) {
    manualBtn.addEventListener('click', (e) => {
      e.preventDefault();
      handleManualScan();
    });
  }

  // allow Enter key to trigger scan when focus on manual-url
  if (manualUrl) {
    manualUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (manualBtn) manualBtn.click();
      }
    });
  }

  // settings toggles
  if (autoScanToggle) autoScanToggle.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    chrome.storage.local.set({ 'auto_scan_clipboard': enabled });
    chrome.runtime.sendMessage({type:'AUTO_SCAN_CLIPBOARD_TOGGLE', payload: { enabled }});
  });
  if (notifToggle) notifToggle.addEventListener('change', (e) => {
    chrome.storage.local.set({ 'notif_enabled': e.target.checked });
  });
  if (notifPhishingOnly) notifPhishingOnly.addEventListener('change', (e) => {
    chrome.storage.local.set({ 'notif_phishing_only': e.target.checked });
  });
  if (notifSound) notifSound.addEventListener('change', (e) => {
    chrome.storage.local.set({ 'notif_sound': e.target.checked });
  });
  if (backHome) backHome.addEventListener('click', () => switchView('home'));

  // nav clicks (safe guards if elements missing)
  if (navHome) navHome.addEventListener('click', () => switchView('home'));
  if (navHistory) navHistory.addEventListener('click', () => switchView('history'));
  if (navSettings) navSettings.addEventListener('click', () => switchView('settings'));
});

