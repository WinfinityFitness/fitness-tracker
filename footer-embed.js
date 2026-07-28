(function () {
  var SUPABASE_URL = 'https://mzkjboplfalauivwcnni.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_YwHBnvbBjd8Oj8hgPXb_JA_buurC92v';
  var TAGLINES = [
    "The only bad workout is the one that didn't happen.",
    "Don't stop when you're tired. Stop when you're done.",
    "Your body can stand almost anything. It's your mind that you have to convince.",
    "Fitness is not about being better than someone else. It's about being better than you were yesterday.",
    "Motivation is what gets you started. Habit is what keeps you going.",
    "Success starts with self-discipline.",
    "Push yourself because no one else is going to do it for you.",
    "It does not matter how slowly you go as long as you do not stop.",
    "Transformation is not five minutes from now; it's a present activity. In this moment, you can make a different choice, and it will lead to a different result.",
    "Believe in yourself and all that you are. Know that there is something inside you that is greater than any obstacle.",
  ];

  document.getElementById('wfFooterYear').textContent = new Date().getFullYear();

  function startRotation() {
    var el = document.getElementById('wfFooterTagline');
    var lastIdx = -1;
    setInterval(function () {
      var idx;
      do { idx = Math.floor(Math.random() * TAGLINES.length); } while (idx === lastIdx && TAGLINES.length > 1);
      lastIdx = idx;
      el.textContent = '"' + TAGLINES[idx] + '"';
    }, 15000);
  }

  function applyLink(id, url) {
    var el = document.getElementById(id);
    if (!url) return;
    el.href = url;
    el.hidden = false;
    el.target = '_blank';
    el.rel = 'noopener';
  }

  function loadFooterSettings(sb) {
    sb.from('ad_settings')
      .select('footer_tagline, footer_webpage_url, footer_facebook_url, footer_instagram_url, footer_affiliate_url')
      .eq('id', 1).maybeSingle()
      .then(function (result) {
        var data = result.data;
        if (data && data.footer_tagline) {
          document.getElementById('wfFooterTagline').textContent = '"' + data.footer_tagline + '"';
        } else {
          startRotation();
        }
        if (data) {
          applyLink('wfFooterWebpage', data.footer_webpage_url);
          applyLink('wfFooterFacebook', data.footer_facebook_url);
          applyLink('wfFooterInstagram', data.footer_instagram_url);
          applyLink('wfFooterAffiliate', data.footer_affiliate_url);
        }
      })
      .catch(function () { startRotation(); });
  }

  // Deliberately does NOT check "if (window.supabase) reuse it" -- some
  // other unrelated plugin on the real site already loads its own bundled
  // Supabase library into window.supabase before this script runs, so that
  // check always saw something already there and reused it assuming it was
  // the real SDK. window.supabase.createClient(...) then threw (that
  // plugin's copy isn't shaped the same) -- an uncaught error right at the
  // top of this script, silently killing everything below it in this same
  // block (Donate/Contact/Share too, not just the visit counter).
  //
  // Always appends a fresh <script> instead, every time, regardless of
  // whatever's already on window.supabase -- the CDN's UMD build
  // unconditionally overwrites window.supabase with the real SDK once IT
  // finishes loading, so by the time this onload fires it's guaranteed to
  // be ours, not whatever was there before. (A dynamic import() of the
  // ESM build was tried first as a cleaner fix, but still didn't work on
  // the live site -- reverted to this plainer approach instead.)
  var sbScript = document.createElement('script');
  sbScript.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
  sbScript.onload = function () {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      console.error('[wf-footer] supabase-js loaded but window.supabase is not the expected SDK shape:', window.supabase);
      startRotation();
      return;
    }
    try {
      var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      loadFooterSettings(sb);
      initVisitCounter(sb);
    } catch (e) {
      console.error('[wf-footer] error initializing after supabase-js load:', e);
      startRotation();
    }
  };
  sbScript.onerror = function () {
    console.error('[wf-footer] supabase-js script failed to load from CDN (network/CSP blocked?)');
    startRotation();
  };
  document.head.appendChild(sbScript);

  // ---------------------------------------------------------------------
  // Site visit counter -- runs for every visitor (record_site_visit()) and
  // the count is shown to everyone, no admin unlock required.
  // ---------------------------------------------------------------------
  var VISIT_SESSION_KEY = 'wf_site_visit_recorded';

  function showVisitCount(count) {
    var el = document.getElementById('wfVisitCount');
    el.textContent = count + ' visits';
    el.hidden = false;
  }

  function initVisitCounter(sb) {
    // Guarded by sessionStorage, not localStorage -- counts once per
    // browsing session (this tab/window until closed), not once ever, so
    // it still climbs across repeat visits like a normal visit counter.
    if (!sessionStorage.getItem(VISIT_SESSION_KEY)) {
      sessionStorage.setItem(VISIT_SESSION_KEY, '1');
      sb.rpc('record_site_visit').then(function (result) {
        if (result.data != null) showVisitCount(result.data);
      }).catch(function () { /* best effort -- counter just won't move this visit */ });
    } else {
      sb.rpc('get_site_visit_count').then(function (result) {
        if (result.data != null) showVisitCount(result.data);
      }).catch(function () { /* best effort */ });
    }
  }

  // Donate / Contact popups
  function openOverlay(id) { document.getElementById(id).hidden = false; }
  function closeOverlay(el) { el.hidden = true; }
  document.getElementById('wfFooterDonate').addEventListener('click', function () { openOverlay('wfDonateOverlay'); });
  document.getElementById('wfFooterContact').addEventListener('click', function () { openOverlay('wfContactOverlay'); });
  document.querySelectorAll('.wf-footer-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeOverlay(overlay); });
    overlay.querySelector('[data-wf-close]').addEventListener('click', function () { closeOverlay(overlay); });
  });

  // Share -- native share sheet if available, otherwise copy the link
  document.getElementById('wfFooterShare').addEventListener('click', function () {
    var shareBtn = this;
    var shareData = { title: 'Winfinity Fitness', text: 'Check out Winfinity Fitness!', url: 'https://winfinityfitness.com' };
    if (navigator.share) {
      navigator.share(shareData).catch(function () { /* user cancelled -- ignore */ });
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(shareData.url).then(function () {
        var original = shareBtn.innerHTML;
        shareBtn.textContent = 'Link copied!';
        setTimeout(function () { shareBtn.innerHTML = original; }, 1800);
      });
    }
  });
})();
