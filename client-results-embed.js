(function () {
  var SUPABASE_URL = 'https://mzkjboplfalauivwcnni.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_YwHBnvbBjd8Oj8hgPXb_JA_buurC92v';

  var root = document.getElementById('wfResultsSlideshow');
  if (!root || typeof supabase === 'undefined') return;

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var layerA = document.getElementById('wfResultsImgA');
  var layerB = document.getElementById('wfResultsImgB');
  var captionEl = document.getElementById('wfResultsCaption');
  var dotsEl = document.getElementById('wfResultsDots');
  var emptyEl = document.getElementById('wfResultsEmpty');
  var prevZone = document.getElementById('wfResultsPrev');
  var nextZone = document.getElementById('wfResultsNext');
  if (!layerA || !layerB) return;

  var layers = [layerA, layerB];
  var activeLayer = 0; // index into layers[] of the currently-visible image
  var photos = [];
  var current = 0;
  var started = false;
  var timer = null;
  var ADVANCE_MS = 4500;

  function renderDots() {
    dotsEl.innerHTML = photos.map(function (_, i) {
      return '<span class="wf-results-dot' + (i === current ? ' is-active' : '') + '" data-i="' + i + '"></span>';
    }).join('');
    dotsEl.querySelectorAll('.wf-results-dot').forEach(function (dot) {
      dot.addEventListener('click', function () {
        var target = Number(dot.dataset.i);
        show(target, target >= current ? 1 : -1);
        restartTimer();
      });
    });
  }

  // Two stacked <img> layers crossfade + slide against each other instead
  // of the old single-<img> hide/swap/show, which had a blank gap while
  // the src changed. The incoming layer waits for its own load event
  // before animating in, so a slow network never shows a half-loaded or
  // blank frame mid-transition -- it just holds the current photo a beat
  // longer instead.
  function show(i, direction) {
    if (!photos.length) return;
    var nextIndex = (i + photos.length) % photos.length;
    current = nextIndex;
    renderDots();
    var photo = photos[nextIndex];
    var dir = direction || 1;

    var outgoing = layers[activeLayer];
    var incoming = layers[1 - activeLayer];

    function animateIn() {
      incoming.classList.remove('enter-from-left', 'enter-from-right');
      // Force a reflow so the enter-from-* starting transform is actually
      // applied before the transition to is-active runs, not collapsed
      // into a single no-op frame by the browser.
      void incoming.offsetWidth;
      incoming.classList.add('is-active');
      if (started) {
        outgoing.classList.remove('is-active');
        outgoing.classList.add(dir < 0 ? 'exit-to-right' : 'exit-to-left');
      }
      activeLayer = 1 - activeLayer;
      started = true;
    }

    incoming.classList.remove('is-active', 'exit-to-left', 'exit-to-right');
    incoming.classList.add(dir < 0 ? 'enter-from-left' : 'enter-from-right');
    incoming.onload = animateIn;
    incoming.src = photo.image_url;
    if (incoming.complete && incoming.naturalWidth) animateIn();

    captionEl.textContent = photo.caption || '';
    captionEl.style.display = photo.caption ? 'block' : 'none';
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    if (photos.length > 1) timer = setInterval(function () { show(current + 1, 1); }, ADVANCE_MS);
  }

  if (prevZone) prevZone.addEventListener('click', function () { show(current - 1, -1); restartTimer(); });
  if (nextZone) nextZone.addEventListener('click', function () { show(current + 1, 1); restartTimer(); });

  sb.rpc('get_client_results_photos').then(function (res) {
    if (res.error || !res.data || !res.data.length) {
      emptyEl.style.display = 'block';
      return;
    }
    photos = res.data;
    dotsEl.style.display = 'flex';
    show(0, 1);
    restartTimer();
  }).catch(function () {
    emptyEl.style.display = 'block';
  });
})();
