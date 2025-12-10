// content_script.js
// Robust copy/paste/keyboard listener that sends URL-like text to the service worker

(() => {
  // Regex to detect typical URLs or domain-like strings
  const URL_REGEX = /\b(?:https?:\/\/|www\.)[^\s/$.?#].[^\s]*\b/i;
  const DOMAIN_LIKE = /\b[a-z0-9.-]+\.[a-z]{2,6}(?:\/[^\s]*)?\b/i;

  // small local de-dupe so same event doesn't fire repeatedly
  let lastSent = '';
  let lastSentAt = 0;
  let polling = false;

  function looksLikeUrl(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (URL_REGEX.test(t)) return true;
    if (DOMAIN_LIKE.test(t) && /[./]/.test(t)) return true;
    return false;
  }

  async function readClipboardIfAllowed() {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const txt = await navigator.clipboard.readText();
        return txt || '';
      }
    } catch (e) {
      // may fail due to permissions - ignore
    }
    return '';
  }

  async function sendIfUrl(text) {
    if (!text) return;
    const trimmed = text.trim();
    if (!looksLikeUrl(trimmed)) return;
    const now = Date.now();
    if (trimmed === lastSent && (now - lastSentAt) < 3000) return;
    lastSent = trimmed;
    lastSentAt = now;

    try {
      chrome.runtime.sendMessage({ type: 'AUTO_CLIPBOARD_COPIED', payload: { text: trimmed } });
    } catch (e) {
      // runtime might not be available (very rare) — ignore
    }
  }

  // Handler used from copy / cut / paste events (we try event.clipboardData first)
  async function handleClipboardEvent(e) {
    try {
      let text = '';
      if (e && e.clipboardData && typeof e.clipboardData.getData === 'function') {
        text = e.clipboardData.getData('text/plain') || '';
      }
      if (!text) {
        // fallback: selection text
        const sel = window.getSelection && window.getSelection();
        text = sel ? String(sel) : '';
      }
      // as last resort try navigator.clipboard.readText (may require user gesture)
      if (!text) {
        const cb = await readClipboardIfAllowed();
        text = cb || '';
      }
      await sendIfUrl(text);
    } catch (err) {
      // ignore
    }
  }

  // When user presses Ctrl/Cmd+C - schedule a clipboard read (some browsers allow)
  function handleKeydown(e) {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const combo = isMac ? e.metaKey && e.key === 'c' : e.ctrlKey && e.key === 'c';
    if (combo) {
      // small timeout so clipboard is populated
      setTimeout(async () => {
        const txt = await readClipboardIfAllowed();
        await sendIfUrl(txt);
      }, 40);
    }
  }

  // Also listen for paste events (paste may contain link)
  async function handlePaste(e) {
    try {
      let text = '';
      if (e && e.clipboardData && typeof e.clipboardData.getData === 'function') {
        text = e.clipboardData.getData('text/plain') || '';
      }
      if (!text) {
        text = await readClipboardIfAllowed();
      }
      await sendIfUrl(text);
    } catch (err) {}
  }

  // Hook listeners (capture phase to maximize chances)
  window.addEventListener('copy', handleClipboardEvent, true);
  window.addEventListener('cut', handleClipboardEvent, true);
  window.addEventListener('paste', handlePaste, true);
  window.addEventListener('keydown', handleKeydown, true);

  // Optional polling to catch context-menu copy cases
  async function pollClipboardLoop(){
    if (polling) return; polling = true;
    while (polling) {
      try {
        const txt = await readClipboardIfAllowed();
        await sendIfUrl(txt);
      } catch(_){}
      await new Promise(r=>setTimeout(r, 1200));
    }
  }

  function startPolling(){ if (!polling) pollClipboardLoop(); }
  function stopPolling(){ polling = false; }

  // React to auto-scan toggle
  try {
    chrome.storage.local.get(['auto_scan_clipboard'], (d)=>{
      if (d && d.auto_scan_clipboard) startPolling();
    });
    chrome.storage.onChanged.addListener((changes, area)=>{
      if (area !== 'local') return;
      if (changes.auto_scan_clipboard){
        const enabled = Boolean(changes.auto_scan_clipboard.newValue);
        if (enabled) startPolling(); else stopPolling();
      }
    });
  } catch(_){}

  // Store audio references so we can stop them
  let currentAudio = null;
  let allAudioInstances = []; // Track all audio instances

  // Play notification sounds on demand
  function playSound(kind){
    try{
      // Stop any currently playing sound immediately
      stopSound();
      
      const file = kind === 'warn' ? 'sounds/Warning sound.wav' : 'sounds/Safe sound.wav';
      const url = chrome.runtime.getURL(file);
      currentAudio = new Audio(url);
      allAudioInstances.push(currentAudio);
      
      // Remove from array when audio ends
      currentAudio.addEventListener('ended', () => {
        const index = allAudioInstances.indexOf(currentAudio);
        if (index > -1) allAudioInstances.splice(index, 1);
        currentAudio = null;
      });
      
      currentAudio.play().catch(()=>{});
    }catch(_){ }
  }

  // Stop currently playing sound - AGGRESSIVE STOP
  function stopSound(){
    // Stop all audio instances
    allAudioInstances.forEach(audio => {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch(_) {}
    });
    allAudioInstances = [];
    
    // Stop current audio
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
      } catch(_) {}
    }
    
    // Also try to stop any audio elements on the page
    try {
      const pageAudios = document.querySelectorAll('audio');
      pageAudios.forEach(audio => {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch(_) {}
      });
    } catch(_) {}
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'PLAY_WARN_SOUND') playSound('warn');
      if (msg.type === 'PLAY_SAFE_SOUND') playSound('safe');
      if (msg.type === 'STOP_SOUND') stopSound();
    });
  } catch(_){}

  // Optional: log that content script loaded (for debugging)
  try { console.debug('PhishingNet content script loaded'); } catch (e) {}
})();
