(function () {
  var overlay = null;
  var overlayFrame = null;

  function openTutorial(url) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:999999;background:rgba(4,6,9,0.88);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';

      var modal = document.createElement('div');
      modal.style.cssText = 'position:relative;width:100%;max-width:900px;height:100%;max-height:900px;background:#0a0d10;border:1px solid #26313a;border-radius:14px;overflow:hidden;';

      overlayFrame = document.createElement('iframe');
      overlayFrame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
      overlayFrame.title = 'Winfinity walkthrough';

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = String.fromCharCode(215);
      closeBtn.style.cssText = 'position:absolute;top:10px;right:10px;z-index:2;width:32px;height:32px;border-radius:50%;background:rgba(10,13,16,0.85);border:1px solid #26313a;color:#eef1f4;font-size:1.3rem;line-height:1;cursor:pointer;';
      closeBtn.addEventListener('click', closeTutorial);

      overlay.addEventListener('click', function (e) { if (e.target === overlay) closeTutorial(); });

      modal.appendChild(overlayFrame);
      modal.appendChild(closeBtn);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    }
    overlayFrame.src = url;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeTutorial() {
    overlay.style.display = 'none';
    overlayFrame.src = '';
    document.body.style.overflow = '';
  }

  window.addEventListener('message', function (e) {
    if (!e.data) return;
    // arsenal.html is itself embedded in a short, auto-height iframe (see
    // the height-resize handling below), sized just tall enough for its
    // own cards -- not the full page. A modal built inside that document
    // would be constrained to that modest height, not the visitor's
    // actual screen. arsenal.html's own "How to use" button posts this
    // message up to request a real, full-viewport overlay here instead,
    // in the top-level page's own document.
    if (e.data.wfOpenTutorial) {
      openTutorial(e.data.wfOpenTutorial);
      return;
    }
    if (e.data.wfEmbedId === 'arsenal' && typeof e.data.wfEmbedHeight === 'number') {
      var frame = document.getElementById('wfArsenalFrame');
      if (frame) frame.style.height = e.data.wfEmbedHeight + 'px';
    }
  });
})();
