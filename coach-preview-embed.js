// Coach Portal preview trigger/modal logic, for coach-preview-embed.html's
// <script src> tag on winfinityfitness.com. Hosted externally rather than
// an inline <script> block for the same reason arsenal-embed.js is
// external (see arsenal-embed.html's own comment): WordPress's content
// pipeline can silently rewrite plain quote characters wherever it finds
// them in pasted content, which corrupts JS string literals into a syntax
// error. A <script src> pointing at a GitHub-Pages-hosted file is immune
// to that.
function wfCoachPreviewInit() {
  var trigger = document.getElementById('wfCoachPreviewBtn');
  var overlay = document.getElementById('wfCoachPreviewOverlay');
  var closeBtn = document.getElementById('wfCoachPreviewClose');
  var frame = document.getElementById('wfCoachPreviewFrame');
  if (!trigger || !overlay || !closeBtn || !frame) return;

  function open() {
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    // Deferred until first open rather than loaded eagerly on page load --
    // this is a marketing page, not the app, so no reason to spend a
    // Supabase-JS + full page load on every visitor who never taps Preview.
    if (frame.src === 'about:blank' || !frame.src) frame.src = frame.dataset.src;
  }
  function close() {
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  trigger.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) close(); });
}

// Deferred to DOMContentLoaded rather than running immediately -- this
// <script src> tag sits ABOVE the button/modal markup in the pasted
// WordPress block (right after the arsenal-embed.js line), so a plain
// immediately-invoked version ran before those elements existed in the
// DOM yet, silently found nothing via getElementById, and never attached
// any listeners at all. Waiting for DOMContentLoaded makes this correct
// regardless of where the script tag ends up relative to the markup.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wfCoachPreviewInit);
} else {
  wfCoachPreviewInit();
}
