(function () {
  var SUPABASE_URL = 'https://mzkjboplfalauivwcnni.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_YwHBnvbBjd8Oj8hgPXb_JA_buurC92v';
  // Set once supabase-js finishes loading (see sbScript.onload below) --
  // openLinksPopup checks for it since Team/Affiliate/Careers/Contact Us
  // can technically be tapped before that finishes.
  var sb = null;
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

  function loadFooterSettings(sb) {
    // Only the tagline still comes from ad_settings -- Website/Facebook/
    // Instagram used to be single-URL ad_settings fields fetched here too,
    // retired in favor of the same list-based footer_links popup Team/
    // Affiliate/Careers/Contact Us use (see openLinksPopup below).
    sb.from('ad_settings')
      .select('footer_tagline')
      .eq('id', 1).maybeSingle()
      .then(function (result) {
        var data = result.data;
        if (data && data.footer_tagline) {
          document.getElementById('wfFooterTagline').textContent = '"' + data.footer_tagline + '"';
        } else {
          startRotation();
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
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
  // the count is shown to everyone, no admin unlock required. Combined
  // with the app's own open count (app_stats.open_count, publicly
  // readable) into one figure -- same combined "Visits" total shown on
  // the FT app's Nexus tab, so the two surfaces agree with each other.
  // ---------------------------------------------------------------------
  var VISIT_SESSION_KEY = 'wf_site_visit_recorded';

  function showVisitCount(siteVisits, appOpens) {
    var el = document.getElementById('wfVisitCount');
    el.textContent = (siteVisits + appOpens) + ' visits';
    el.hidden = false;
  }

  function fetchAppOpens(sb) {
    return sb.from('app_stats').select('open_count').eq('id', 1).single()
      .then(function (result) { return (result.data && typeof result.data.open_count === 'number') ? result.data.open_count : 0; })
      .catch(function () { return 0; });
  }

  function initVisitCounter(sb) {
    // Guarded by sessionStorage, not localStorage -- counts once per
    // browsing session (this tab/window until closed), not once ever, so
    // it still climbs across repeat visits like a normal visit counter.
    var siteVisits = !sessionStorage.getItem(VISIT_SESSION_KEY)
      ? (function () {
          sessionStorage.setItem(VISIT_SESSION_KEY, '1');
          return sb.rpc('record_site_visit').then(function (result) { return result.data != null ? result.data : 0; }).catch(function () { return 0; });
        })()
      : sb.rpc('get_site_visit_count').then(function (result) { return result.data != null ? result.data : 0; }).catch(function () { return 0; });

    Promise.all([siteVisits, fetchAppOpens(sb)]).then(function (results) {
      showVisitCount(results[0], results[1]);
    });
  }

  // Donate popup
  function openOverlay(id) { document.getElementById(id).hidden = false; }
  function closeOverlay(el) { el.hidden = true; }
  document.getElementById('wfFooterDonate').addEventListener('click', function () { openOverlay('wfDonateOverlay'); });
  document.querySelectorAll('.wf-footer-overlay').forEach(function (overlay) {
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeOverlay(overlay); });
    overlay.querySelector('[data-wf-close]').addEventListener('click', function () { closeOverlay(overlay); });
  });

  // Team / Affiliate / Careers / Contact Us -- all four share one popup,
  // listing admin-managed entries (icon + name, linking out) for whichever
  // category was tapped. Entries are managed from the Coach Portal's
  // "Footer Links" tab (see coach-portal.html + supabase_footer_links_
  // migration.sql). An empty category shows a plain empty-state message
  // instead of a dead button.
  function renderLinksList(rows) {
    var listEl = document.getElementById('wfLinksList');
    var emptyEl = document.getElementById('wfLinksEmpty');
    listEl.innerHTML = '';
    if (!rows || !rows.length) { emptyEl.hidden = false; return; }
    emptyEl.hidden = true;
    rows.forEach(function (row) {
      var a = document.createElement('a');
      a.className = 'wf-footer-link-item';
      a.href = row.url;
      a.target = '_blank';
      a.rel = 'noopener';
      var img = '';
      if (row.logo_url) img = '<img src="' + row.logo_url + '" alt="">';
      a.innerHTML = img + '<span></span>';
      a.querySelector('span').textContent = row.name;
      listEl.appendChild(a);
    });
  }
  function openLinksPopup(category, title) {
    var overlay = document.getElementById('wfLinksOverlay');
    document.getElementById('wfLinksTitle').textContent = title;
    document.getElementById('wfLinksEmpty').hidden = true;
    document.getElementById('wfLinksList').innerHTML = '<p class="wf-footer-loading">Loading…</p>';
    overlay.hidden = false;
    if (!sb) {
      document.getElementById('wfLinksList').innerHTML = '';
      document.getElementById('wfLinksEmpty').hidden = false;
      return;
    }
    sb.rpc('get_footer_links', { p_category: category })
      .then(function (result) { renderLinksList(result.data); })
      .catch(function () { renderLinksList([]); });
  }
  document.getElementById('wfFooterTeam').addEventListener('click', function () { openLinksPopup('team', 'Team'); });
  document.getElementById('wfFooterAffiliate').addEventListener('click', function () { openLinksPopup('affiliate', 'Affiliate'); });
  document.getElementById('wfFooterCareers').addEventListener('click', function () { openLinksPopup('careers', 'Careers'); });
  document.getElementById('wfFooterContact').addEventListener('click', function () { openLinksPopup('contact', 'Contact Us'); });
  document.getElementById('wfFooterWebsite').addEventListener('click', function () { openLinksPopup('website', 'Website'); });
  document.getElementById('wfFooterFacebook').addEventListener('click', function () { openLinksPopup('facebook', 'Facebook'); });
  document.getElementById('wfFooterInstagram').addEventListener('click', function () { openLinksPopup('instagram', 'Instagram'); });

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
