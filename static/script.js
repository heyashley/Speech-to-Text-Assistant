/* =============================================
   AI Speech to Text — script.js
   ============================================= */

let isRecording     = false;
let recognition     = null;
let finalTranscript = '';

const micBtn        = document.getElementById('micBtn');
const micRing       = document.getElementById('micRing');
const waveform      = document.getElementById('waveform');
const micLabel      = document.getElementById('micLabel');
const resultBox     = document.getElementById('result');
const sentimentChip = document.getElementById('sentimentChip');
const sentimentMeta = document.getElementById('sentimentMeta');
const toneChip      = document.getElementById('toneChip');
const toneMeta      = document.getElementById('toneMeta');
const audioFile     = document.getElementById('audioFile');
const uploadZone    = document.getElementById('uploadZone');
const uploadText    = document.getElementById('uploadText');

/* ══════════════════════════════════════════
   SPEECH RECOGNITION
══════════════════════════════════════════ */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';

  recognition.onstart = () => setRecordingUI(true);

  recognition.onend = () => {
    if (isRecording) { recognition.start(); return; }
    setRecordingUI(false);
    if (finalTranscript.trim()) fetchSentiment(finalTranscript.trim());
  };

  recognition.onresult = (event) => {
    let interim = '';
    finalTranscript = '';
    for (let i = 0; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += t + ' ';
      else interim += t;
    }
    const full = (finalTranscript + interim).trim();
    setTranscript(full);
    updateStats(full);
  };

  recognition.onerror = (event) => {
    isRecording = false;
    setRecordingUI(false);
    showError('Microphone error: ' + event.error);
  };
}

function toggleMic() {
  if (!SpeechRecognition) {
    showError('Speech recognition not supported. Use Chrome or Edge.');
    return;
  }
  isRecording = !isRecording;
  if (isRecording) {
    finalTranscript = '';
    clearOutput();
    recognition.start();
  } else {
    recognition.stop();
  }
}

function fetchSentiment(text) {
  fetch('/sentiment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  })
    .then(r => r.json())
    .then(data => {
      if (data.sentiment) {
        setSentiment(data.sentiment.label, data.sentiment.meta || '');
        setTone(data.sentiment.label);
      }
    })
    .catch(err => console.error('Sentiment error:', err));
}

/* ══════════════════════════════════════════
   FILE UPLOAD
══════════════════════════════════════════ */

function uploadAudio() {
  const file = audioFile.files[0];
  if (file) sendFile(file);
}

function sendFile(file) {
  if (!file.type.startsWith('audio/')) {
    showError('Please upload a valid audio file (MP3, WAV, M4A, OGG, FLAC).');
    return;
  }

  uploadText.textContent = 'Uploading ' + file.name + '…';
  uploadZone.style.borderColor = '#a78bfa';
  clearOutput();

  const fd = new FormData();
  fd.append('audio', file);

  fetch('/upload', { method: 'POST', body: fd })
    .then(r => {
      if (!r.ok) throw new Error('Server error: ' + r.status);
      return r.json();
    })
    .then(data => {
      uploadZone.style.borderColor = '';
      if (data.error) { showError(data.error); uploadText.textContent = 'Drop file here or click to browse'; return; }

      uploadText.textContent = 'Done: ' + file.name;

      if (data.transcript) {
        setTranscript(data.transcript);
        updateStats(data.transcript);
      }
      if (data.sentiment) {
        setSentiment(data.sentiment.label, data.sentiment.meta || '');
        setTone(data.sentiment.label);
      }
    })
    .catch(err => {
      uploadZone.style.borderColor = '';
      uploadText.textContent = 'Drop file here or click to browse';
      showError('Upload failed: ' + err.message);
    });
}

uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', ()  => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) sendFile(file);
});

/* ══════════════════════════════════════════
   TRANSLATION
══════════════════════════════════════════ */

const LANG_NAMES = {
  en: 'English', hi: 'Hindi', fr: 'French', es: 'Spanish',
  de: 'German', zh: 'Chinese', ar: 'Arabic', pt: 'Portuguese',
  ru: 'Russian', ja: 'Japanese', ko: 'Korean', it: 'Italian',
  tr: 'Turkish', nl: 'Dutch', pl: 'Polish', sv: 'Swedish',
  bn: 'Bengali', ur: 'Urdu', ta: 'Tamil', te: 'Telugu'
};

function translateTranscript() {
  const text = resultBox.textContent.trim();

  if (!text || text === 'Your transcript will appear here…') {
    showTranslateError('No transcript available. Please record or upload audio first.');
    return;
  }

  const sourceLang = document.getElementById('sourceLang').value;
  const targetLang = document.getElementById('targetLang').value;

  if (sourceLang === targetLang) {
    showTranslateError('Source and target languages are the same. Please choose different languages.');
    return;
  }

  setTranslateLoading(true);

  fetch('/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, source_lang: sourceLang, target_lang: targetLang })
  })
    .then(r => r.json())
    .then(data => {
      setTranslateLoading(false);
      if (data.error) {
        showTranslateError('Translation failed: ' + data.error);
        return;
      }
      setTranslatedText(data.translated_text, sourceLang, targetLang);
    })
    .catch(err => {
      setTranslateLoading(false);
      showTranslateError('Network error: ' + err.message);
    });
}

function swapLanguages() {
  const src = document.getElementById('sourceLang');
  const tgt = document.getElementById('targetLang');
  const tmp = src.value;
  src.value = tgt.value;
  tgt.value = tmp;
}

function setTranslateLoading(loading) {
  const btn = document.getElementById('translateBtn');
  if (loading) {
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner"></span> Translating…';
  } else {
    btn.disabled = false;
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
        <circle cx="12" cy="12" r="10"/>
        <line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
      Translate`;
  }
}

function setTranslatedText(text, srcLang, tgtLang) {
  const output      = document.getElementById('translationOutput');
  const translated  = document.getElementById('translatedText');
  const badge       = document.getElementById('translationLangBadge');
  const copyBtn     = document.getElementById('copyTranslationBtn');
  const meta        = document.getElementById('translateMeta');

  translated.textContent  = text;
  translated.classList.add('filled');
  badge.textContent       = (LANG_NAMES[srcLang] || srcLang) + ' → ' + (LANG_NAMES[tgtLang] || tgtLang);
  meta.textContent        = 'Translated via MyMemory';
  output.classList.add('has-content');
  copyBtn.style.display   = 'flex';
  copyBtn.classList.remove('copied');
  copyBtn.innerHTML       = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
    </svg>
    Copy`;
}

function showTranslateError(msg) {
  const translated = document.getElementById('translatedText');
  const meta       = document.getElementById('translateMeta');
  translated.textContent = '⚠ ' + msg;
  translated.classList.remove('filled');
  meta.textContent = '';
  document.getElementById('copyTranslationBtn').style.display = 'none';
}

function copyTranslation() {
  const text    = document.getElementById('translatedText').textContent;
  const copyBtn = document.getElementById('copyTranslationBtn');
  if (!text || text.startsWith('⚠')) return;

  navigator.clipboard.writeText(text).then(() => {
    copyBtn.classList.add('copied');
    copyBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      Copied!`;
    setTimeout(() => {
      copyBtn.classList.remove('copied');
      copyBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
        Copy`;
    }, 2000);
  }).catch(() => {
    /* fallback for older browsers */
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

/* ══════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════ */

function setRecordingUI(active) {
  micBtn.classList.toggle('recording', active);
  micRing.classList.toggle('recording', active);
  waveform.classList.toggle('active', active);
  micLabel.classList.toggle('active', active);
  micLabel.textContent = active ? 'Recording… click to stop' : 'Click to record';
}

function setTranscript(text) {
  resultBox.textContent = text || 'Your transcript will appear here…';
  resultBox.classList.toggle('filled', !!text);
  document.getElementById('transcriptPanel').classList.toggle('has-content', !!text);
}

function setSentiment(label, meta) {
  const map = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral' };
  sentimentChip.className = 'sentiment-chip ' + label;
  sentimentChip.innerHTML = '<span class="dot"></span>' + (map[label] || label);
  sentimentMeta.textContent = meta || '';
}

function setTone(sentimentLabel) {
  const tones = {
    positive: { label: 'Enthusiastic', color: 'positive' },
    negative: { label: 'Critical',     color: 'negative' },
    neutral:  { label: 'Informative',  color: 'neutral'  }
  };
  const t = tones[sentimentLabel] || tones.neutral;
  toneChip.className = 'sentiment-chip ' + t.color;
  toneChip.innerHTML = '<span class="dot"></span>' + t.label;
  toneMeta.textContent = 'Detected tone from transcript';
}

function updateStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const secs  = Math.round((words / 150) * 60);
  const mins  = Math.floor(secs / 60);
  const rem   = secs % 60;
  document.getElementById('statWords').textContent = words || '—';
  document.getElementById('statChars').textContent = chars || '—';
  document.getElementById('statDur').textContent   = words ? (mins > 0 ? mins + 'm ' + rem + 's' : rem + 's') : '—';
}

function clearOutput() {
  setTranscript('');
  updateStats('');
  sentimentChip.className = 'sentiment-chip';
  sentimentChip.innerHTML = '<span class="dot"></span>Awaiting transcript';
  sentimentMeta.textContent = '';
  toneChip.className = 'sentiment-chip';
  toneChip.innerHTML = '<span class="dot"></span>Awaiting transcript';
  toneMeta.textContent = '';

  /* also clear translation */
  const translated = document.getElementById('translatedText');
  const badge      = document.getElementById('translationLangBadge');
  const meta       = document.getElementById('translateMeta');
  const output     = document.getElementById('translationOutput');
  const copyBtn    = document.getElementById('copyTranslationBtn');
  translated.textContent = 'Translated text will appear here…';
  translated.classList.remove('filled');
  badge.textContent = '—';
  meta.textContent  = '';
  output.classList.remove('has-content');
  copyBtn.style.display = 'none';
}

function showError(msg) {
  resultBox.textContent = '⚠ ' + msg;
  resultBox.classList.remove('filled');
}