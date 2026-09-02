(function () {
  var SUPABASE_URL = 'https://mzkjboplfalauivwcnni.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_YwHBnvbBjd8Oj8hgPXb_JA_buurC92v';

  var root = document.getElementById('wfResultsSlideshow');
  if (!root || typeof supabase === 'undefined') return;

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var imgEl = document.getElementById('wfResultsImg');
  var captionEl = document.getElementById('wfResultsCaption');
  var dotsEl = document.getElementById('wfResultsDots');
  var emptyEl = document.getElementById('wfResultsEmpty');

  var photos = [];
  var current = 0;
  var timer = null;
  var ADVANCE_MS = 4500;

  function renderDots() {
    dotsEl.innerHTML = photos.map(function (_, i) {
      return '<span class="wf-results-dot' + (i === current ? ' is-active' : '') + '" data-i="' + i + '"></span>';
    }).join('');
    dotsEl.querySelectorAll('.wf-results-dot').forEach(function (dot) {
      dot.addEventListener('click', function () {
        show(Number(dot.dataset.i));
        restartTimer();
      });
    });
  }

  function show(i) {
    current = (i + photos.length) % photos.length;
    var photo = photos[current];
    imgEl.style.opacity = 0;
    setTimeout(function () {
      imgEl.src = photo.image_url;
      captionEl.textContent = photo.caption || '';
      captionEl.style.display = photo.caption ? 'block' : 'none';
      imgEl.style.opacity = 1;
    }, 200);
    renderDots();
  }

  function restartTimer() {
    if (timer) clearInterval(timer);
    if (photos.length > 1) timer = setInterval(function () { show(current + 1); }, ADVANCE_MS);
  }

  sb.rpc('get_client_results_photos').then(function (res) {
    if (res.error || !res.data || !res.data.length) {
      emptyEl.style.display = 'block';
      return;
    }
    photos = res.data;
    imgEl.style.display = 'block';
    dotsEl.style.display = 'flex';
    show(0);
    restartTimer();
  }).catch(function () {
    emptyEl.style.display = 'block';
  });
})();
