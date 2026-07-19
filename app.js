'use strict';

// Bump this alongside sw.js's CACHE_NAME on every edit — shown on the Status
// tab as a real build marker instead of decorative placeholder text.
const APP_VERSION = 'WF_SYS_V.1.2.0';

/* ---------------------------------------------------------------- */
/* Storage                                                           */
/* ---------------------------------------------------------------- */
const KEYS = { profile: 'wft_profile', logs: 'wft_logs', reviews: 'wft_reviews', dailyReviews: 'wft_daily_reviews' };

// A one-time ?variant=clean on the URL permanently flags this install (via
// localStorage, since the query string itself won't survive a re-open from
// the home screen) so the Facebook/Instagram footer links and the "leave a
// review on Facebook" popup never show for this device again — used for
// sharing the app with someone specific without those links attached, distinct
// from the per-Digital-ID admin toggle (applyFooterSocialLinksVisibility),
// which needs an existing account and only touches the footer, not the popup.
const CLEAN_VARIANT_KEY = 'wft_variant_clean';
function isCleanShareVariant() {
  return localStorage.getItem(CLEAN_VARIANT_KEY) === '1';
}
function initCleanVariantFlag() {
  if (new URLSearchParams(location.search).get('variant') === 'clean') {
    localStorage.setItem(CLEAN_VARIANT_KEY, '1');
  }
}
initCleanVariantFlag();

/* ---------------------------------------------------------------- */
/* Desktop Shell (wellness.winfinityfitness.com only)                */
/* ---------------------------------------------------------------- */
// The reverse-proxied desktop subdomain (see wordpress-proxy/) serves this
// exact same file — the hostname check below (mirrored synchronously in
// index.html's <head> so there's no flash of the mobile layout) is the only
// thing that branches behavior. Everything under initDesktopShell is fully
// self-contained (its own wds*-prefixed IDs/classes) and never touches the
// mobile app's DOM, storage keys, or init flow, so the mobile app and plain
// GitHub Pages URL run completely unaffected by any of this.
const DESKTOP_SHELL_HOST = 'wellness.winfinityfitness.com';
const isDesktopShellSite = location.hostname === DESKTOP_SHELL_HOST;

// Set only after a successful desktop sign-in (see signInWithWebSync below)
// to the payload returned by web_sync_get_dashboard — {profile, theme, skin,
// logs, reviews, dailyReviews}. Everywhere else this stays null forever, so
// getProfile/getLogs/getReviews/getDailyReviews below fall through to their
// normal localStorage reads unchanged. This is what lets the desktop shell
// reuse the mobile app's own calculation functions (weight trend, macro
// targets, body fat %, etc.) against a signed-in operator's real remote data
// without touching any of those functions' call sites.
let wdsRemoteData = null;

// Desktop Messenger-style chat (DMs + group chatrooms) — reuses the exact
// same chat_rooms/chat_room_members tables and RPCs (start_dm_by_name,
// create_chat_room, invite_to_chat_room, leave_chat_room, delete_chat_room,
// kick_chat_room_member) the mobile app's own group-chat feature already
// uses, just with new wds*-prefixed state so it never collides with
// mobile's own currentChatRoomId/chatRoomMeta globals (Global Chat itself
// is untouched — it still runs on the pre-existing refreshWdsChat() path).
let wdsChatRoomMeta = {}; // roomId -> {name, isDm, createdByKey, joinedByMe, lastMessage, lastMessageAt}
let wdsChatLastRead = {}; // roomId -> ISO timestamp, persisted below
try { wdsChatLastRead = JSON.parse(localStorage.getItem('wft_web_chat_last_read')) || {}; } catch (e) { wdsChatLastRead = {}; }
function wdsSaveChatLastRead() { localStorage.setItem('wft_web_chat_last_read', JSON.stringify(wdsChatLastRead)); }
let wdsOpenChatPopupIds = [];
let wdsPopupPendingImages = {}; // roomId -> data URL, per-popup since several can be open at once
let wdsChatListTab = 'all';
let wdsChatListSearchText = '';
let wdsNewGroupInviteIds = [];
let wdsChatUserMenuTarget = null;
let wdsChatUserMenuTargetKey = null;

// Preview build: the dashboard below is illustrative/sample data, not real
// per-operator records — full per-operator data needs a real cloud-sync
// backend keyed to Digital ID, which doesn't exist yet (today everything
// lives in local device storage only). Sign-in here just gates the preview
// behind a Digital ID prompt and remembers it for the tab session; it does
// not verify anything server-side yet.
// Converts the {date, data} array shape web_sync_get_dashboard returns for
// logs/reviews/dailyReviews back into the date-keyed object shape
// getLogs()/getReviews()/getDailyReviews() normally return locally.
function wdsArrayToDateMap(arr) {
  const map = {};
  (arr || []).forEach(item => { if (item && item.date) map[item.date] = item.data; });
  return map;
}

function initDesktopShell() {
  const shell = document.getElementById('wdsShell');
  if (!shell) return;

  const gate = document.getElementById('wdsGate');
  const dashboard = document.getElementById('wdsDashboard');
  const idInput = document.getElementById('wdsDigitalIdInput');
  const pinInput = document.getElementById('wdsPinInput');
  const signInBtn = document.getElementById('wdsSignInBtn');
  const signOutBtn = document.getElementById('wdsSignOutBtn');
  const errorEl = document.getElementById('wdsGateError');
  const operatorNameEl = document.getElementById('wdsOperatorName');
  const modeIconEl = document.getElementById('wdsUserModeIcon');
  const modeIconImgEl = document.getElementById('wdsUserModeIconImg');
  modeIconEl.addEventListener('click', openWdsProfilePage);
  const profileBackBtn = document.getElementById('btnWdsProfileBack');
  if (profileBackBtn) profileBackBtn.addEventListener('click', closeWdsProfilePage);
  const brandEl = document.getElementById('wdsTopnavBrand');
  if (brandEl) {
    brandEl.addEventListener('click', closeWdsProfilePage);
    brandEl.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeWdsProfilePage(); } });
  }

  const SESSION_ID_KEY = 'wds_operator_id';
  const SESSION_PIN_KEY = 'wds_operator_pin';
  let wdsInitialRouteChecked = false;

  // Fetches the real synced payload via web_sync_get_dashboard, wires it up
  // as wdsRemoteData (so every calc function getProfile/getLogs/etc. already
  // reuses picks it up automatically), applies the operator's own real
  // theme/skin, and renders every real-data tile. Returns true on success.
  async function enterDashboard(digitalId, pin) {
    const cleanId = digitalId.trim().toUpperCase();
    const cleanPin = pin.trim();
    if (!cleanId || !cleanPin) return false;
    errorEl.hidden = true;
    if (!sbConfigured()) {
      errorEl.textContent = 'Not connected — check your internet connection and try again.';
      errorEl.hidden = false;
      return false;
    }
    try {
      const { data, error } = await sb.rpc('web_sync_get_dashboard', {
        p_public_id: cleanId, p_pin: cleanPin, p_days: 90,
      });
      if (error) throw error;
      wdsRemoteData = {
        publicId: cleanId,
        shareKey: data.shareKey || null,
        profile: data.profile || null,
        theme: data.theme || 'dark',
        skin: data.skin || 'default',
        logsObj: wdsArrayToDateMap(data.logs),
        reviewsObj: wdsArrayToDateMap(data.reviews),
        dailyReviewsObj: wdsArrayToDateMap(data.dailyReviews),
      };
    } catch (e) {
      errorEl.textContent = (e && e.message) || 'Sign-in failed — check your Digital ID and PIN.';
      errorEl.hidden = false;
      return false;
    }
    sessionStorage.setItem(SESSION_ID_KEY, cleanId);
    sessionStorage.setItem(SESSION_PIN_KEY, cleanPin);
    // Not applyTheme()/applySkin() — those also touch mobile-only Settings
    // elements (themeIcon/themeToggle/skinSelect) that don't exist in this
    // markup. Setting the attributes directly gets the same CSS repaint
    // (every token in style.css keys off data-theme/data-skin) without it.
    document.documentElement.setAttribute('data-theme', wdsRemoteData.theme);
    document.documentElement.setAttribute('data-skin', wdsRemoteData.skin);
    const displayName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || cleanId;
    operatorNameEl.textContent = displayName;
    const mode = getFitnessMode();
    const myPhoto = wdsRemoteData.profile && wdsRemoteData.profile.photoDataUrl;
    modeIconImgEl.src = myPhoto || MODE_ICON[mode] || MODE_ICON.beginner;
    modeIconEl.classList.toggle('wds-user-mode-icon--photo', !!myPhoto);
    modeIconEl.title = myPhoto ? 'View profile' : (MODE_LABEL[mode] || mode);
    const composerAvatarEl = document.getElementById('wdsComposerAvatar');
    wdsSetAvatarVisual(composerAvatarEl, wdsRemoteData.profile && wdsRemoteData.profile.photoDataUrl, displayName.trim().charAt(0).toUpperCase());
    const composerInputEl = document.getElementById('wdsComposerInput');
    if (composerInputEl) composerInputEl.placeholder = `What's on your mind, ${displayName.split(' ')[0]}?`;
    renderWdsDashboard();
    gate.hidden = true;
    dashboard.hidden = false;
    // Deep-link support: a bookmarked/shared /<DigitalID> URL only makes
    // sense to check once, right after the FIRST successful sign-in — not
    // on every 2-minute poll refresh, which would otherwise re-open the
    // profile page out from under someone who'd since navigated away.
    if (!wdsInitialRouteChecked) {
      wdsInitialRouteChecked = true;
      const path = location.pathname.replace(/^\/|\/$/g, '');
      if (path && path.toUpperCase() === cleanId.toUpperCase()) wdsShowProfilePage();
    }
    startWdsDashboardPolling();
    startWdsChatPolling();
    startWdsFeedPolling();
    return true;
  }

  // The dashboard tiles don't otherwise auto-update — a full re-sync from
  // the app has to actually reach the server first. Polling every 2 minutes
  // is a light middle ground between "fully manual" and real push, without
  // an actual realtime backend. Stops itself if a poll ever fails (e.g. the
  // PIN was changed elsewhere) instead of repeatedly hitting
  // web_sync_get_dashboard with a now-wrong PIN and compounding the
  // account's failed-attempt lockout counter.
  let wdsDashboardPollId = null;
  function startWdsDashboardPolling() {
    stopWdsDashboardPolling();
    wdsDashboardPollId = setInterval(async () => {
      const id = sessionStorage.getItem(SESSION_ID_KEY);
      const pin = sessionStorage.getItem(SESSION_PIN_KEY);
      if (!id || !pin) { stopWdsDashboardPolling(); return; }
      const ok = await enterDashboard(id, pin);
      if (!ok) stopWdsDashboardPolling();
    }, 120000);
  }
  function stopWdsDashboardPolling() {
    if (wdsDashboardPollId) { clearInterval(wdsDashboardPollId); wdsDashboardPollId = null; }
  }

  const trySignIn = () => { enterDashboard(idInput.value, pinInput.value); };
  signInBtn.addEventListener('click', trySignIn);
  [idInput, pinInput].forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter') trySignIn();
  }));

  signOutBtn.addEventListener('click', () => {
    if (!confirm('Log out?')) return;
    sessionStorage.removeItem(SESSION_ID_KEY);
    sessionStorage.removeItem(SESSION_PIN_KEY);
    wdsRemoteData = null;
    stopWdsDashboardPolling();
    stopWdsChatPolling();
    stopWdsFeedPolling();
    dashboard.hidden = true;
    gate.hidden = false;
    idInput.value = '';
    pinInput.value = '';
    idInput.focus();
  });

  // No more tabs — everything lives on one page now, so chat polling just
  // runs continuously for as long as the dashboard is signed in (started
  // alongside dashboard polling in enterDashboard, stopped on sign-out).

  // Nexus chat — send (text + optional image), react/unsend (long-press or
  // double-click a bubble).
  const chatInput = document.getElementById('wdsChatInput');
  const chatSendBtn = document.getElementById('btnWdsChatSend');
  const chatAttachBtn = document.getElementById('btnWdsChatAttachImage');
  const chatImageInput = document.getElementById('wdsChatImageInput');
  const chatPendingImage = document.getElementById('wdsChatPendingImage');
  const chatPendingImagePreview = document.getElementById('wdsChatPendingImagePreview');
  const chatPendingImageRemoveBtn = document.getElementById('btnWdsChatPendingImageRemove');
  let wdsPendingChatImageDataUrl = null;

  const clearWdsPendingChatImage = () => {
    wdsPendingChatImageDataUrl = null;
    chatPendingImage.hidden = true;
    chatImageInput.value = '';
  };
  const readWdsChatImageFile = file => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      wdsPendingChatImageDataUrl = reader.result;
      chatPendingImagePreview.src = wdsPendingChatImageDataUrl;
      chatPendingImage.hidden = false;
    };
    reader.readAsDataURL(file);
  };
  chatAttachBtn.addEventListener('click', () => chatImageInput.click());
  chatImageInput.addEventListener('change', () => readWdsChatImageFile(chatImageInput.files[0]));
  chatPendingImageRemoveBtn.addEventListener('click', clearWdsPendingChatImage);
  // Ctrl+V a copied image straight into the message box — same pending-
  // image slot the attach button fills, so preview/remove/send all work
  // identically regardless of how the image got there.
  chatInput.addEventListener('paste', e => {
    const file = wdsGetPastedImageFile(e);
    if (file) { e.preventDefault(); readWdsChatImageFile(file); }
  });

  const sendWdsChat = async () => {
    if (!wdsRemoteData || !wdsRemoteData.shareKey || !sbConfigured()) return;
    const text = chatInput.value;
    const image = wdsPendingChatImageDataUrl;
    if (!text.trim() && !image) return;
    chatSendBtn.disabled = true;
    try {
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      await postChatMessage(text, image, wdsRemoteData.shareKey, codeName);
      chatInput.value = '';
      clearWdsPendingChatImage();
      await refreshWdsChat();
    } catch (e) { /* best effort — message just won't appear, input keeps the typed text so nothing is lost */ }
    finally { chatSendBtn.disabled = false; }
  };
  chatSendBtn.addEventListener('click', sendWdsChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendWdsChat(); });
  initWdsChatReactionMenu();

  // Nexus Feed — composer (text + optional image) and the post/like/comment
  // event delegation set up in initWdsFeed.
  const composerInput = document.getElementById('wdsComposerInput');
  const composerPostBtn = document.getElementById('btnWdsComposerPost');
  const composerAttachBtn = document.getElementById('btnWdsComposerAttach');
  const composerImageInput = document.getElementById('wdsComposerImageInput');
  const composerPendingImage = document.getElementById('wdsComposerPendingImage');
  let wdsPendingPostImageDataUrls = [];

  const renderWdsPendingPostImages = () => {
    if (!wdsPendingPostImageDataUrls.length) { composerPendingImage.hidden = true; composerPendingImage.innerHTML = ''; return; }
    composerPendingImage.hidden = false;
    composerPendingImage.innerHTML = wdsPendingPostImageDataUrls.map((url, i) => `
      <div class="wds-composer-pending-image-item">
        <img src="${url}" alt="">
        <button type="button" data-remove-pending-image="${i}" aria-label="Remove image">✕</button>
      </div>`).join('');
  };
  const clearWdsPendingPostImage = () => {
    wdsPendingPostImageDataUrls = [];
    composerImageInput.value = '';
    renderWdsPendingPostImages();
  };
  composerAttachBtn.addEventListener('click', () => composerImageInput.click());
  // Multiple photos per post — each selected file reads independently, so
  // the preview strip fills in as each finishes rather than waiting on
  // the slowest one.
  composerImageInput.addEventListener('change', () => {
    Array.from(composerImageInput.files || []).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => { wdsPendingPostImageDataUrls.push(reader.result); renderWdsPendingPostImages(); };
      reader.readAsDataURL(file);
    });
  });
  composerPendingImage.addEventListener('click', e => {
    const removeBtn = e.target.closest('[data-remove-pending-image]');
    if (!removeBtn) return;
    wdsPendingPostImageDataUrls.splice(Number(removeBtn.dataset.removePendingImage), 1);
    renderWdsPendingPostImages();
  });

  // Live link preview — debounced scan for the first URL as the user
  // types, skipped for YouTube/Facebook video links (those already embed
  // directly at render time via wdsExtractVideoEmbed, no card needed).
  const composerLinkPreviewBox = document.getElementById('wdsComposerLinkPreview');
  let wdsComposerPreviewTimer = null;
  let wdsComposerPreviewUrl = null;
  let wdsComposerLinkPreview = null;

  const renderWdsComposerLinkPreview = () => {
    if (!wdsComposerLinkPreview) { composerLinkPreviewBox.hidden = true; composerLinkPreviewBox.innerHTML = ''; return; }
    composerLinkPreviewBox.hidden = false;
    composerLinkPreviewBox.innerHTML = `<div style="position:relative;">${wdsBuildLinkPreviewHtml(wdsComposerLinkPreview)}<button type="button" class="wds-link-preview-remove" id="btnWdsComposerLinkPreviewRemove" aria-label="Remove preview">✕</button></div>`;
    composerLinkPreviewBox.querySelectorAll('a.wds-link-preview-card').forEach(a => a.style.pointerEvents = 'none');
    document.getElementById('btnWdsComposerLinkPreviewRemove').addEventListener('click', () => {
      wdsComposerLinkPreview = null;
      renderWdsComposerLinkPreview();
    });
  };

  const checkComposerLink = async () => {
    const url = wdsDetectFirstUrl(composerInput.value);
    if (!url) {
      wdsComposerPreviewUrl = null;
      wdsComposerLinkPreview = null;
      renderWdsComposerLinkPreview();
      return;
    }
    if (url === wdsComposerPreviewUrl) return;
    wdsComposerPreviewUrl = url;
    if (wdsExtractVideoEmbed(url)) {
      wdsComposerLinkPreview = null;
      renderWdsComposerLinkPreview();
      return;
    }
    composerLinkPreviewBox.hidden = false;
    composerLinkPreviewBox.innerHTML = '<p class="empty-note">Loading preview…</p>';
    try {
      const preview = await fetchLinkPreview(url);
      if (wdsComposerPreviewUrl !== url) return; // text moved on while this was in flight
      wdsComposerLinkPreview = preview;
      renderWdsComposerLinkPreview();
    } catch (e) {
      if (wdsComposerPreviewUrl === url) { wdsComposerLinkPreview = null; renderWdsComposerLinkPreview(); }
    }
  };
  composerInput.addEventListener('input', () => {
    clearTimeout(wdsComposerPreviewTimer);
    wdsComposerPreviewTimer = setTimeout(checkComposerLink, 600);
  });

  const composerErrorEl = document.getElementById('wdsComposerError');
  composerPostBtn.addEventListener('click', async () => {
    if (composerErrorEl) composerErrorEl.hidden = true;
    if (!wdsRemoteData || !wdsRemoteData.shareKey || !sbConfigured()) {
      if (composerErrorEl) { composerErrorEl.textContent = 'Not signed in — try refreshing the page.'; composerErrorEl.hidden = false; }
      return;
    }
    const text = composerInput.value;
    const images = wdsPendingPostImageDataUrls;
    if (!text.trim() && !images.length) return;
    composerPostBtn.disabled = true;
    try {
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      await postFeedPost(text, images, wdsRemoteData.shareKey, codeName, wdsComposerLinkPreview);
      composerInput.value = '';
      clearWdsPendingPostImage();
      wdsComposerPreviewUrl = null;
      wdsComposerLinkPreview = null;
      renderWdsComposerLinkPreview();
      await refreshWdsFeed(true);
    } catch (e) {
      // Composer keeps the typed text so nothing is lost — but the failure
      // itself must be visible, not silent (this is exactly what made an
      // earlier missing-column bug look like "the button does nothing").
      if (composerErrorEl) { composerErrorEl.textContent = 'Could not post: ' + ((e && e.message) || 'unknown error') + '. Try again.'; composerErrorEl.hidden = false; }
    }
    finally { composerPostBtn.disabled = false; }
  });
  initWdsFeed();

  // My Day — full-screen story composer: a background (photo or
  // color/gradient) plus any number of draggable/resizable/rotatable text
  // layers, flattened to one PNG on Share (see wdsFlattenStoryToDataUrl
  // and friends, defined near the other top-level wds* story helpers).
  // Photo hands off straight to the device's own gallery/camera picker (a
  // page can't read a user's photo library directly, so that OS picker IS
  // the "gallery grid" here) and a dedicated camera-shutter FAB jumps
  // straight to the camera. Also wires the story viewer and its unsend
  // button.
  const storyComposerPostBtn = document.getElementById('btnWdsStoryComposerPost');
  const storyComposerImageInput = document.getElementById('wdsStoryComposerImageInput');
  const storyComposerCameraInput = document.getElementById('wdsStoryComposerCameraInput');
  const storyComposerPendingImagePreview = document.getElementById('wdsStoryComposerPendingImagePreview');
  const storyComposerImageRemoveBtn = document.getElementById('btnWdsStoryComposerImageRemove');
  const storyComposerCloseBtn = document.getElementById('btnWdsStoryComposerClose');
  const storyComposerErrorEl = document.getElementById('wdsStoryComposerError');
  const storyModeTextBtn = document.getElementById('btnWdsStoryModeText');
  const storyModePhotoBtn = document.getElementById('btnWdsStoryModePhoto');
  const storyCameraFab = document.getElementById('btnWdsStoryCameraFab');
  const storyPhotoZoomRow = document.getElementById('wdsStoryPhotoZoomRow');
  const storyPhotoZoomSlider = document.getElementById('wdsStoryPhotoZoom');
  const storyPhotoLayer = document.getElementById('wdsStoryPhotoLayer');
  const storyModeLinkBtn = document.getElementById('btnWdsStoryModeLink');
  const storyLinkRow = document.getElementById('wdsStoryLinkRow');
  const storyLinkInput = document.getElementById('wdsStoryLinkInput');
  const storyLinkAddBtn = document.getElementById('btnWdsStoryLinkAdd');

  wdsBuildStoryBgRow();
  wdsBuildStoryToolbarRows();

  const clearWdsPendingStoryImage = () => {
    wdsPendingStoryImageDataUrl = null;
    document.getElementById('wdsStoryPhotoLayer').hidden = true;
    storyComposerImageRemoveBtn.hidden = true;
    storyPhotoZoomRow.hidden = true;
    storyComposerImageInput.value = '';
    storyComposerCameraInput.value = '';
    wdsStoryPhotoTransform = { scale: 1, x: 0, y: 0 };
    wdsSetStoryBg(wdsStoryBg);
    wdsUpdateStoryHint();
  };
  const resetWdsStoryComposer = () => {
    document.getElementById('wdsStoryTextLayers').innerHTML = '';
    wdsStoryTextItems = [];
    wdsDeselectStoryText();
    clearWdsPendingStoryImage();
    wdsSetStoryBg(WDS_STORY_BG_SWATCHES[1]);
    wdsStoryLinkPreview = null;
    wdsRenderStoryLinkPreviewBox();
    storyLinkRow.hidden = true;
    storyLinkInput.value = '';
    wdsUpdateStoryHint();
  };
  // Starting a brand-new story (as opposed to "Share to My Day", which
  // preloads a link preview instead) jumps straight to the phone's gallery
  // picker — the closest available equivalent to a native app's own
  // in-page gallery grid, since a website has no API to read the photo
  // library directly. Canceling the picker just leaves the normal
  // composer open (text/background/link still available).
  const openStoryComposerForNewStory = () => {
    resetWdsStoryComposer();
    wdsOpenStoryComposer();
    storyComposerImageInput.click();
  };
  const handleStoryImageFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      wdsPendingStoryImageDataUrl = reader.result;
      storyComposerPendingImagePreview.src = wdsPendingStoryImageDataUrl;
      document.getElementById('wdsStoryPhotoLayer').hidden = false;
      storyComposerImageRemoveBtn.hidden = false;
      storyPhotoZoomRow.hidden = false;
      wdsStoryPhotoTransform = { scale: 1, x: 0, y: 0 };
      storyPhotoZoomSlider.value = '1';
      wdsApplyPhotoTransform();
      wdsSetStoryBg(wdsStoryBg);
      wdsUpdateStoryHint();
    };
    reader.readAsDataURL(file);
  };
  storyModeTextBtn.addEventListener('click', () => wdsAddStoryText());
  storyModePhotoBtn.addEventListener('click', () => storyComposerImageInput.click());
  storyModeLinkBtn.addEventListener('click', () => {
    storyLinkRow.hidden = !storyLinkRow.hidden;
    if (!storyLinkRow.hidden) storyLinkInput.focus();
  });
  const addStoryLink = async () => {
    const url = storyLinkInput.value.trim();
    if (!url) return;
    storyLinkAddBtn.disabled = true;
    try {
      const preview = await fetchLinkPreview(url);
      wdsStoryLinkPreview = preview;
      wdsRenderStoryLinkPreviewBox();
      storyLinkRow.hidden = true;
      storyLinkInput.value = '';
    } catch (e) { /* leave the row open so they can retry/edit the URL */ }
    finally { storyLinkAddBtn.disabled = false; }
  };
  storyLinkAddBtn.addEventListener('click', addStoryLink);
  storyLinkInput.addEventListener('keydown', e => { if (e.key === 'Enter') addStoryLink(); });
  storyComposerImageInput.addEventListener('change', () => handleStoryImageFile(storyComposerImageInput.files[0]));
  storyComposerCameraInput.addEventListener('change', () => handleStoryImageFile(storyComposerCameraInput.files[0]));
  storyCameraFab.addEventListener('click', () => storyComposerCameraInput.click());
  storyComposerImageRemoveBtn.addEventListener('click', clearWdsPendingStoryImage);
  storyComposerCloseBtn.addEventListener('click', () => { wdsCloseStoryComposer(); resetWdsStoryComposer(); });

  storyPhotoZoomSlider.addEventListener('input', () => {
    wdsStoryPhotoTransform.scale = parseFloat(storyPhotoZoomSlider.value) || 1;
    wdsApplyPhotoTransform();
  });
  // Pans the photo; deselects any active text layer first so a drag
  // starting over the image doesn't also drag whatever text was selected.
  storyPhotoLayer.addEventListener('pointerdown', e => {
    wdsDeselectStoryText();
    storyPhotoLayer.setPointerCapture(e.pointerId);
    const canvas = document.getElementById('wdsStoryCreateCanvas');
    const rect = canvas.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startTx = wdsStoryPhotoTransform.x, startTy = wdsStoryPhotoTransform.y;
    const maxOff = (wdsStoryPhotoTransform.scale - 1) / 2 + 0.15;
    const onMove = ev => {
      wdsStoryPhotoTransform.x = Math.min(maxOff, Math.max(-maxOff, startTx + (ev.clientX - startX) / rect.width));
      wdsStoryPhotoTransform.y = Math.min(maxOff, Math.max(-maxOff, startTy + (ev.clientY - startY) / rect.height));
      wdsApplyPhotoTransform();
    };
    const onUp = () => storyPhotoLayer.removeEventListener('pointermove', onMove);
    storyPhotoLayer.addEventListener('pointermove', onMove);
    storyPhotoLayer.addEventListener('pointerup', onUp, { once: true });
    storyPhotoLayer.addEventListener('pointercancel', onUp, { once: true });
  });
  // Tapping empty canvas (not a text layer, the photo, or a control)
  // deselects whichever text layer was active, hiding its handles/toolbar.
  document.getElementById('wdsStoryCreateCanvas').addEventListener('pointerdown', e => {
    if (e.target.closest('.wds-story-text-item, .wds-story-photo-layer, #btnWdsStoryComposerImageRemove, .wds-story-camera-fab')) return;
    wdsDeselectStoryText();
  });

  storyComposerPostBtn.addEventListener('click', async () => {
    if (storyComposerErrorEl) storyComposerErrorEl.hidden = true;
    if (!wdsRemoteData || !wdsRemoteData.shareKey || !sbConfigured()) {
      if (storyComposerErrorEl) { storyComposerErrorEl.textContent = 'Not signed in — try refreshing the page.'; storyComposerErrorEl.hidden = false; }
      return;
    }
    const hasText = wdsStoryTextItems.some(t => t.text.trim());
    if (!hasText && !wdsPendingStoryImageDataUrl && !wdsStoryLinkPreview) return;
    storyComposerPostBtn.disabled = true;
    try {
      const flattened = await wdsFlattenStoryToDataUrl();
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      await postFeedStory(null, flattened, wdsRemoteData.shareKey, codeName, wdsStoryLinkPreview);
      wdsCloseStoryComposer();
      resetWdsStoryComposer();
      await refreshWdsMyday();
    } catch (e) {
      if (storyComposerErrorEl) { storyComposerErrorEl.textContent = 'Could not post: ' + ((e && e.message) || 'unknown error') + '. Try again.'; storyComposerErrorEl.hidden = false; }
    }
    finally { storyComposerPostBtn.disabled = false; }
  });

  document.getElementById('wdsMydayRow').addEventListener('click', e => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    if (target.dataset.action === 'add-story') { openStoryComposerForNewStory(); return; }
    const storyId = Number(target.dataset.storyId);
    if (storyId) wdsOpenStoryViewer(storyId);
  });
  document.getElementById('btnWdsStoryViewerClose').addEventListener('click', wdsCloseStoryViewer);
  document.getElementById('wdsStoryViewerOverlay').addEventListener('click', e => {
    if (e.target.id === 'wdsStoryViewerOverlay') wdsCloseStoryViewer();
  });
  document.getElementById('btnWdsReactorsClose').addEventListener('click', wdsCloseReactorsOverlay);
  document.getElementById('wdsReactorsOverlay').addEventListener('click', e => {
    if (e.target.id === 'wdsReactorsOverlay') wdsCloseReactorsOverlay();
  });
  document.getElementById('wdsReactorTabs').addEventListener('click', e => {
    const tabBtn = e.target.closest('[data-reactor-filter]');
    if (!tabBtn) return;
    wdsReactorsFilter = tabBtn.dataset.reactorFilter;
    wdsRenderReactorTabs();
    wdsRenderReactorsList();
  });

  document.getElementById('btnWdsSharersClose').addEventListener('click', wdsCloseSharersOverlay);
  document.getElementById('wdsSharersOverlay').addEventListener('click', e => {
    if (e.target.id === 'wdsSharersOverlay') wdsCloseSharersOverlay();
  });

  document.getElementById('btnWdsShareComposeClose').addEventListener('click', wdsCloseShareComposeOverlay);
  document.getElementById('wdsShareComposeOverlay').addEventListener('click', e => {
    if (e.target.id === 'wdsShareComposeOverlay') wdsCloseShareComposeOverlay();
  });
  document.getElementById('btnWdsShareComposeSubmit').addEventListener('click', async () => {
    if (!wdsRemoteData || !wdsRemoteData.shareKey || !wdsSharingPostId) return;
    const btn = document.getElementById('btnWdsShareComposeSubmit');
    const input = document.getElementById('wdsShareComposeInput');
    const errorEl = document.getElementById('wdsShareComposeError');
    if (errorEl) errorEl.hidden = true;
    btn.disabled = true;
    try {
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      await shareFeedPost(wdsRemoteData.shareKey, codeName, wdsSharingPostId, input ? input.value : '');
      wdsCloseShareComposeOverlay();
      await refreshWdsFeed(true);
    } catch (e) {
      if (errorEl) { errorEl.textContent = 'Could not share: ' + ((e && e.message) || 'unknown error') + '.'; errorEl.hidden = false; }
    }
    finally { btn.disabled = false; }
  });
  document.getElementById('wdsStoryViewerContent').addEventListener('click', async e => {
    const btn = e.target.closest('#btnWdsUnsendStory');
    if (btn) {
      if (!wdsRemoteData || !wdsRemoteData.shareKey) return;
      btn.disabled = true;
      try {
        await unsendFeedStory(Number(btn.dataset.storyId), wdsRemoteData.shareKey);
        wdsCloseStoryViewer();
        await refreshWdsMyday();
      } catch (e2) { btn.disabled = false; }
      return;
    }
    const quickReactBtn = e.target.closest('[data-quick-react]');
    if (quickReactBtn) {
      const group = wdsStoryGroups[wdsStoryGroupIdx];
      const story = group && group.stories[wdsStoryLocalIdx];
      if (story) { await wdsSendStoryReply(story, quickReactBtn.dataset.quickReact); wdsFlashStorySent(); }
      return;
    }
    const tapZone = e.target.closest('[data-story-tap]');
    if (tapZone) wdsAdvanceStory(tapZone.dataset.storyTap === 'prev' ? -1 : 1);
  });
  // The reply input sits on top of the tap zones (see CSS) so typing
  // itself doesn't advance the story — but the 5s auto-advance timer
  // would still fire mid-sentence without this, so it's paused for as
  // long as the input is focused and left paused after sending/blur
  // (the viewer isn't meant to yank the story away while composing).
  document.getElementById('wdsStoryViewerContent').addEventListener('focusin', e => {
    if (e.target.matches('.wds-story-reply-input')) clearTimeout(wdsStoryTimer);
  });
  document.getElementById('wdsStoryViewerContent').addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || !e.target.matches('.wds-story-reply-input')) return;
    const input = e.target;
    if (!input.value.trim()) return;
    const group = wdsStoryGroups[wdsStoryGroupIdx];
    const story = group && group.stories[wdsStoryLocalIdx];
    if (!story) return;
    const text = input.value;
    input.value = '';
    await wdsSendStoryReply(story, text);
    wdsFlashStorySent();
  });

  // Profile Page — cover photo (choose → drag to reposition → Save), its
  // own composer (mirrors the main feed composer, just posting straight to
  // the global feed like any other post), and the Filters/Manage/List-Grid
  // controls over the post list.
  const profileCoverEl = document.getElementById('wdsProfileCover');
  const profileCoverInput = document.getElementById('wdsProfileCoverInput');
  const profileCoverEditBtn = document.getElementById('btnWdsProfileCoverEdit');
  const profileCoverHint = document.getElementById('wdsProfileCoverHint');
  let wdsCoverRepositioning = false;
  let wdsPendingCoverDataUrl = null;
  let wdsPendingCoverPosY = 50;

  const profileCoverErrorEl = document.getElementById('wdsProfileCoverError');
  profileCoverEditBtn.addEventListener('click', async () => {
    if (!wdsCoverRepositioning) { profileCoverInput.click(); return; }
    // Currently repositioning — this click is "Save".
    if (!wdsRemoteData) return;
    if (profileCoverErrorEl) profileCoverErrorEl.hidden = true;
    profileCoverEditBtn.disabled = true;
    try {
      const p = Object.assign({}, wdsRemoteData.profile, {
        coverPhotoDataUrl: wdsPendingCoverDataUrl, coverPhotoPosY: wdsPendingCoverPosY,
      });
      await wdsPushProfileUpdate(p);
      // web_sync_push_snapshot returning without error doesn't guarantee
      // the write actually stuck (e.g. an RLS/grant edge case would still
      // report success client-side) — re-fetch straight from the RPC the
      // dashboard itself uses and compare, so "Save" only ever claims
      // success once the server confirms it. This is what was missing
      // before: the button always looked successful even when it wasn't.
      const id = sessionStorage.getItem(SESSION_ID_KEY);
      const pin = sessionStorage.getItem(SESSION_PIN_KEY);
      const { data: verifyData, error: verifyError } = await sb.rpc('web_sync_get_dashboard', {
        p_public_id: id, p_pin: pin, p_days: 1,
      });
      if (verifyError) throw verifyError;
      if (!verifyData || !verifyData.profile || verifyData.profile.coverPhotoDataUrl !== wdsPendingCoverDataUrl) {
        throw new Error('Save did not verify — the server still has the old cover photo.');
      }
      wdsRemoteData.profile = verifyData.profile;
      // Only exit repositioning mode on a CONFIRMED save — if it failed,
      // the pending image/position stays live so the user can just hit
      // Save again instead of silently losing their edit on the next
      // refresh (this is exactly the bug being fixed here: the button
      // used to always reset to "success" state even when the save
      // itself had thrown).
      wdsCoverRepositioning = false;
      wdsPendingCoverDataUrl = null;
      profileCoverEl.classList.remove('wds-profile-cover--repositioning');
      profileCoverHint.hidden = true;
      profileCoverEditBtn.classList.remove('wds-icon-btn');
      profileCoverEditBtn.classList.add('wds-profile-cover-edit');
      profileCoverEditBtn.textContent = '🖼 Edit Cover Photo';
    } catch (e) {
      if (profileCoverErrorEl) { profileCoverErrorEl.textContent = 'Could not save: ' + ((e && e.message) || 'unknown error') + '. Try again.'; profileCoverErrorEl.hidden = false; }
    }
    finally {
      profileCoverEditBtn.disabled = false;
    }
  });
  profileCoverInput.addEventListener('change', async () => {
    const file = profileCoverInput.files[0];
    profileCoverInput.value = '';
    if (!file || !wdsRemoteData) return;
    if (profileCoverErrorEl) profileCoverErrorEl.hidden = true;
    try {
      wdsPendingCoverDataUrl = await resizeCoverImageFull(file);
      wdsPendingCoverPosY = 50;
      profileCoverEl.style.backgroundImage = `url(${wdsPendingCoverDataUrl})`;
      profileCoverEl.style.backgroundPosition = 'center 50%';
      wdsCoverRepositioning = true;
      profileCoverEl.classList.add('wds-profile-cover--repositioning');
      profileCoverHint.hidden = false;
      // Icon-only, matching the plain-stroke style of the other topnav
      // icon buttons (wds-icon-btn) instead of a colored emoji+label.
      profileCoverEditBtn.classList.remove('wds-profile-cover-edit');
      profileCoverEditBtn.classList.add('wds-icon-btn');
      profileCoverEditBtn.setAttribute('aria-label', 'Save cover position');
      profileCoverEditBtn.title = 'Save cover position';
      profileCoverEditBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>';
    } catch (e) {
      if (profileCoverErrorEl) { profileCoverErrorEl.textContent = 'Could not read that photo: ' + ((e && e.message) || 'unknown error') + '.'; profileCoverErrorEl.hidden = false; }
    }
  });
  // Vertical-only drag (Facebook's own cover-reposition affordance is
  // vertical-only too — the image already fills the width via cover-fit).
  let coverDragStartY = null;
  let coverDragStartPos = 50;
  profileCoverEl.addEventListener('pointerdown', e => {
    if (!wdsCoverRepositioning) return;
    // A pointerdown that started on a button (Save, Back) bubbles up to
    // the cover div same as one on the bare background — without this
    // guard, setPointerCapture below hijacks the click that would
    // otherwise fire on that button right after, since capture redirects
    // the subsequent pointerup/click to the capturing element instead of
    // the original target. This is what made "Save Position" (and, before
    // the touch-action fix, "Edit Cover Photo") not respond to clicks.
    if (e.target.closest('button')) return;
    coverDragStartY = e.clientY;
    coverDragStartPos = wdsPendingCoverPosY;
    profileCoverEl.setPointerCapture(e.pointerId);
  });
  profileCoverEl.addEventListener('pointermove', e => {
    if (!wdsCoverRepositioning || coverDragStartY === null) return;
    const deltaPct = ((e.clientY - coverDragStartY) / profileCoverEl.offsetHeight) * 100;
    wdsPendingCoverPosY = Math.max(0, Math.min(100, coverDragStartPos - deltaPct));
    profileCoverEl.style.backgroundPosition = `center ${wdsPendingCoverPosY}%`;
  });
  ['pointerup', 'pointercancel'].forEach(evt => profileCoverEl.addEventListener(evt, () => { coverDragStartY = null; }));

  const profileComposerInput = document.getElementById('wdsProfileComposerInput');
  const profileComposerPostBtn = document.getElementById('btnWdsProfileComposerPost');
  const profileComposerAttachBtn = document.getElementById('btnWdsProfileComposerAttach');
  const profileComposerImageInput = document.getElementById('wdsProfileComposerImageInput');
  const profileComposerPendingImage = document.getElementById('wdsProfileComposerPendingImage');
  const profileComposerErrorEl = document.getElementById('wdsProfileComposerError');
  let wdsPendingProfilePostImageDataUrls = [];
  const renderWdsPendingProfilePostImages = () => {
    if (!wdsPendingProfilePostImageDataUrls.length) { profileComposerPendingImage.hidden = true; profileComposerPendingImage.innerHTML = ''; return; }
    profileComposerPendingImage.hidden = false;
    profileComposerPendingImage.innerHTML = wdsPendingProfilePostImageDataUrls.map((url, i) => `
      <div class="wds-composer-pending-image-item">
        <img src="${url}" alt="">
        <button type="button" data-remove-pending-image="${i}" aria-label="Remove image">✕</button>
      </div>`).join('');
  };
  const clearWdsPendingProfilePostImage = () => {
    wdsPendingProfilePostImageDataUrls = [];
    profileComposerImageInput.value = '';
    renderWdsPendingProfilePostImages();
  };
  profileComposerAttachBtn.addEventListener('click', () => profileComposerImageInput.click());
  profileComposerImageInput.addEventListener('change', () => {
    Array.from(profileComposerImageInput.files || []).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => { wdsPendingProfilePostImageDataUrls.push(reader.result); renderWdsPendingProfilePostImages(); };
      reader.readAsDataURL(file);
    });
  });
  profileComposerPendingImage.addEventListener('click', e => {
    const removeBtn = e.target.closest('[data-remove-pending-image]');
    if (!removeBtn) return;
    wdsPendingProfilePostImageDataUrls.splice(Number(removeBtn.dataset.removePendingImage), 1);
    renderWdsPendingProfilePostImages();
  });
  profileComposerPostBtn.addEventListener('click', async () => {
    if (profileComposerErrorEl) profileComposerErrorEl.hidden = true;
    if (!wdsRemoteData || !wdsRemoteData.shareKey || !sbConfigured()) {
      if (profileComposerErrorEl) { profileComposerErrorEl.textContent = 'Not signed in — try refreshing the page.'; profileComposerErrorEl.hidden = false; }
      return;
    }
    const text = profileComposerInput.value;
    const images = wdsPendingProfilePostImageDataUrls;
    if (!text.trim() && !images.length) return;
    profileComposerPostBtn.disabled = true;
    try {
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      const wallOwnerShareKey = wdsViewedProfile ? wdsViewedProfile.shareKey : null;
      await postFeedPost(text, images, wdsRemoteData.shareKey, codeName, null, wallOwnerShareKey);
      profileComposerInput.value = '';
      clearWdsPendingProfilePostImage();
      await refreshWdsProfilePosts();
    } catch (e) {
      if (profileComposerErrorEl) { profileComposerErrorEl.textContent = 'Could not post: ' + ((e && e.message) || 'unknown error') + '. Try again.'; profileComposerErrorEl.hidden = false; }
    }
    finally { profileComposerPostBtn.disabled = false; }
  });

  const profileFiltersBtn = document.getElementById('btnWdsProfileFilters');
  profileFiltersBtn.addEventListener('click', () => {
    wdsProfilePostsSort = wdsProfilePostsSort === 'newest' ? 'oldest' : 'newest';
    profileFiltersBtn.textContent = wdsProfilePostsSort === 'newest' ? '⇅ Filters: Newest' : '⇅ Filters: Oldest';
    renderWdsProfilePosts();
  });
  const profileManageBtn = document.getElementById('btnWdsProfileManage');
  profileManageBtn.addEventListener('click', () => {
    wdsProfileManageMode = !wdsProfileManageMode;
    profileManageBtn.classList.toggle('is-active', wdsProfileManageMode);
    renderWdsProfilePosts();
  });
  const profileViewListBtn = document.getElementById('btnWdsProfileViewList');
  const profileViewGridBtn = document.getElementById('btnWdsProfileViewGrid');
  [profileViewListBtn, profileViewGridBtn].forEach(btn => {
    btn.addEventListener('click', () => {
      wdsProfilePostsView = btn.dataset.view;
      profileViewListBtn.classList.toggle('is-active', wdsProfilePostsView === 'list');
      profileViewGridBtn.classList.toggle('is-active', wdsProfilePostsView === 'grid');
      renderWdsProfilePosts();
    });
  });
  document.getElementById('wdsProfilePostsList').addEventListener('click', async e => {
    const lightboxImg = e.target.closest('[data-lightbox]');
    if (lightboxImg) { e.stopPropagation(); openChatLightbox(lightboxImg.dataset.lightbox); return; }
    const nameEl = e.target.closest('[data-view-profile]');
    if (nameEl) { e.stopPropagation(); wdsOpenOtherProfile(nameEl.dataset.viewProfile); return; }
    const reactorsEl = e.target.closest('[data-action="view-reactors"]');
    if (reactorsEl) { e.stopPropagation(); wdsShowReactors(reactorsEl.dataset.reactorType, Number(reactorsEl.dataset.reactorId)); return; }
    const removeBtn = e.target.closest('[data-action="remove-post"]');
    if (removeBtn) {
      if (!wdsRemoteData || !wdsRemoteData.shareKey || !confirm('Remove this post?')) return;
      removeBtn.disabled = true;
      try {
        await unsendFeedPost(Number(removeBtn.dataset.postId), wdsRemoteData.shareKey);
        await refreshWdsProfilePosts();
      } catch (err) { removeBtn.disabled = false; }
      return;
    }
    const tile = e.target.closest('.wds-profile-grid-tile');
    if (tile) { profileViewListBtn.click(); }
  });
  document.getElementById('wdsProfilePostsList').addEventListener('change', async e => {
    const select = e.target.closest('[data-action="set-visibility"]');
    if (!select || !wdsRemoteData) return;
    const postId = Number(select.dataset.postId);
    const cached = wdsProfilePostsCache.find(p => p.id === postId);
    const prev = cached ? cached.visibility : 'public';
    select.disabled = true;
    try {
      await sb.rpc('set_feed_post_visibility', { p_post_id: postId, p_share_key: wdsRemoteData.shareKey, p_visibility: select.value });
      if (cached) cached.visibility = select.value;
    } catch (err) {
      select.value = prev || 'public';
    }
    finally { select.disabled = false; }
  });


  // Menu tab — sign out (duplicate of the topnav button, for convenience)
  // and a local-only theme toggle (does not touch the synced profile).
  const menuSignOutBtn = document.getElementById('btnWdsMenuSignOut');
  if (menuSignOutBtn) menuSignOutBtn.addEventListener('click', () => signOutBtn.click());
  const themeToggleEl = document.getElementById('wdsThemeToggle');
  if (themeToggleEl) themeToggleEl.addEventListener('change', () => {
    document.documentElement.setAttribute('data-theme', themeToggleEl.checked ? 'light' : 'dark');
  });

  // Notification bell — simple open/close popover, closes on outside click.
  const bellBtn = document.getElementById('wdsBellBtn');
  const notifPop = document.getElementById('wdsNotifPop');
  bellBtn.addEventListener('click', e => {
    e.stopPropagation();
    notifPop.hidden = !notifPop.hidden;
    if (!notifPop.hidden) {
      localStorage.setItem('wft_web_nexus_last_seen', new Date().toISOString());
      wdsMarkAllNotificationsRead();
      renderWdsNotifications();
    }
  });
  document.addEventListener('click', e => {
    if (!notifPop.hidden && !notifPop.contains(e.target) && e.target !== bellBtn) {
      notifPop.hidden = true;
    }
  });
  // Friend-request Accept/Decline buttons render inline inside a
  // notification item in the bell dropdown.
  notifPop.addEventListener('click', e => {
    const acceptBtn = e.target.closest('[data-accept-friend]');
    if (acceptBtn) { wdsRespondFriendRequest(acceptBtn.dataset.acceptFriend, true); return; }
    const declineBtn = e.target.closest('[data-decline-friend]');
    if (declineBtn) { wdsRespondFriendRequest(declineBtn.dataset.declineFriend, false); }
  });

  // Friends card — "+ Add Friend" reveals a Digital ID input; Send calls
  // send_friend_request.
  const addFriendBtn = document.getElementById('btnWdsProfileAddFriend');
  const addFriendRow = document.getElementById('wdsAddFriendRow');
  const addFriendInput = document.getElementById('wdsAddFriendInput');
  const addFriendErrorEl = document.getElementById('wdsAddFriendError');
  const sendFriendReqBtn = document.getElementById('btnWdsSendFriendRequest');
  if (addFriendBtn && addFriendRow && sendFriendReqBtn) {
    addFriendBtn.addEventListener('click', () => {
      addFriendRow.hidden = !addFriendRow.hidden;
      if (!addFriendRow.hidden) addFriendInput.focus();
    });
    const sendRequest = async () => {
      const id = addFriendInput.value.trim().toUpperCase();
      if (addFriendErrorEl) addFriendErrorEl.hidden = true;
      if (!id) return;
      sendFriendReqBtn.disabled = true;
      try {
        await wdsSendFriendRequest(id);
        addFriendInput.value = '';
        addFriendRow.hidden = true;
      } catch (e) {
        if (addFriendErrorEl) { addFriendErrorEl.textContent = (e && e.message) || 'Could not send friend request.'; addFriendErrorEl.hidden = false; }
      }
      finally { sendFriendReqBtn.disabled = false; }
    };
    sendFriendReqBtn.addEventListener('click', sendRequest);
    addFriendInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendRequest(); } });
  }
  document.getElementById('wdsProfileFriendsList').addEventListener('click', e => {
    const item = e.target.closest('[data-view-profile]');
    if (item) wdsOpenOtherProfile(item.dataset.viewProfile);
  });

  // Viewing someone else's profile (a click-through from a name/avatar)
  // shows "+ Add Friend"/"Message" instead of your own edit tools — see
  // renderWdsProfileHeader's isOwn branch for what toggles this row.
  const viewedAddFriendBtn = document.getElementById('btnWdsProfileAddFriendDirect');
  const viewedMessageBtn = document.getElementById('btnWdsProfileMessage');
  if (viewedAddFriendBtn) viewedAddFriendBtn.addEventListener('click', async () => {
    if (!wdsViewedProfile) return;
    viewedAddFriendBtn.disabled = true;
    try {
      await wdsSendFriendRequest(wdsViewedProfile.publicId);
      viewedAddFriendBtn.textContent = 'Request Sent';
    } catch (e) {
      viewedAddFriendBtn.disabled = false;
    }
  });
  if (viewedMessageBtn) viewedMessageBtn.addEventListener('click', () => {
    if (!wdsViewedProfile) return;
    wdsStartDM(wdsViewedProfile.codeName);
  });

  // Own-profile action row — only shown when wdsViewedProfile is null
  // (renderWdsProfileHeader toggles this).
  const addStoryBtn = document.getElementById('btnWdsProfileAddStory');
  if (addStoryBtn) addStoryBtn.addEventListener('click', openStoryComposerForNewStory);

  // Who-can-post-on-my-wall — only visible/enabled on your own profile
  // (renderWdsProfileHeader hides it when wdsViewedProfile is set).
  const wallPermissionSelect = document.getElementById('wdsWallPermissionSelect');
  if (wallPermissionSelect) wallPermissionSelect.addEventListener('change', async () => {
    if (!wdsRemoteData) return;
    const prev = wdsOwnWallPermission;
    const next = wallPermissionSelect.value;
    wallPermissionSelect.disabled = true;
    try {
      const { error } = await sb.rpc('set_wall_post_permission', { p_share_key: wdsRemoteData.shareKey, p_permission: next });
      if (error) throw error;
      wdsOwnWallPermission = next;
    } catch (e) {
      wallPermissionSelect.value = prev;
    }
    finally { wallPermissionSelect.disabled = false; }
  });

  // Chats panel — opened from the header chat icon (replaces the old
  // manual refresh button; the dashboard still auto-refreshes every 2min).
  // Global Chat minimize toggle — collapses the fixed bottom-left widget
  // down to a small globe-icon button in the same corner. On narrow
  // (mobile) viewports it also starts minimized by default, opens
  // full-width, and auto-closes on an outside click — matching how the
  // DM/group popups already behave there, instead of permanently
  // occupying the screen the way it does on desktop.
  const WDS_MOBILE_BREAKPOINT = 860;
  const isWdsMobileViewport = () => window.innerWidth <= WDS_MOBILE_BREAKPOINT;
  const globalChatFixed = document.getElementById('wdsGlobalChatFixed');
  const globalChatMinimizeBtn = document.getElementById('btnWdsGlobalChatMinimize');
  const globalChatCollapsedIcon = document.getElementById('wdsGlobalChatCollapsedIcon');
  if (globalChatFixed && globalChatMinimizeBtn && globalChatCollapsedIcon) {
    if (isWdsMobileViewport()) {
      globalChatFixed.hidden = true;
      globalChatCollapsedIcon.hidden = false;
    }
    globalChatMinimizeBtn.addEventListener('click', () => {
      globalChatFixed.hidden = true;
      globalChatCollapsedIcon.hidden = false;
    });
    globalChatCollapsedIcon.addEventListener('click', () => {
      globalChatFixed.hidden = false;
      globalChatCollapsedIcon.hidden = true;
    });
    document.addEventListener('click', e => {
      if (isWdsMobileViewport() && !globalChatFixed.hidden && !globalChatFixed.contains(e.target) && e.target !== globalChatCollapsedIcon) {
        globalChatFixed.hidden = true;
        globalChatCollapsedIcon.hidden = false;
      }
    });
  }

  const chatListBtn = document.getElementById('wdsChatListBtn');
  const chatListPop = document.getElementById('wdsChatListPop');
  chatListBtn.addEventListener('click', e => {
    e.stopPropagation();
    chatListPop.hidden = !chatListPop.hidden;
    if (!chatListPop.hidden) refreshWdsChatRooms();
  });

  // Icon strip above the composer. Home is the feed itself — just marks
  // itself active, nothing to navigate to. Groups opens the real Chats
  // panel already filtered to group chatrooms (the closest existing
  // equivalent). Reels/Marketplace/Games have no backing feature in this
  // app yet, so they surface that honestly instead of doing nothing.
  const nexusIconTabs = document.getElementById('wdsNexusIconTabs');
  if (nexusIconTabs) nexusIconTabs.addEventListener('click', e => {
    const tabBtn = e.target.closest('[data-nexus-tab]');
    if (!tabBtn) return;
    const tab = tabBtn.dataset.nexusTab;
    if (tab === 'home') {
      nexusIconTabs.querySelectorAll('.wds-nexus-icon-tab').forEach(t => t.classList.toggle('is-active', t === tabBtn));
      return;
    }
    if (tab === 'groups') {
      chatListPop.hidden = false;
      refreshWdsChatRooms();
      const groupsTabBtn = document.getElementById('btnWdsChatTabGroups');
      if (groupsTabBtn) groupsTabBtn.click();
      return;
    }
    showRestToast(`${tabBtn.title} is coming soon.`);
  });
  document.addEventListener('click', e => {
    if (!chatListPop.hidden && !chatListPop.contains(e.target) && e.target !== chatListBtn) {
      chatListPop.hidden = true;
    }
  });
  ['btnWdsChatTabAll', 'btnWdsChatTabUnread', 'btnWdsChatTabGroups'].forEach(id => {
    const btn = document.getElementById(id);
    btn.addEventListener('click', () => {
      wdsChatListTab = btn.dataset.tab;
      document.querySelectorAll('.wds-chat-list-tab').forEach(t => t.classList.toggle('is-active', t.id === id));
      renderWdsChatListPanel();
    });
  });
  document.getElementById('wdsChatListSearch').addEventListener('input', e => {
    wdsChatListSearchText = e.target.value;
    renderWdsChatListPanel();
  });
  document.getElementById('wdsChatListItems').addEventListener('click', async e => {
    const acceptEl = e.target.closest('[data-accept-invite]');
    if (acceptEl) {
      if (!wdsRemoteData) return;
      await sb.rpc('accept_chat_room_invite', { p_room_id: acceptEl.dataset.acceptInvite, p_share_key: wdsRemoteData.shareKey });
      await refreshWdsChatRooms();
      return;
    }
    const declineEl = e.target.closest('[data-decline-invite]');
    if (declineEl) {
      if (!wdsRemoteData) return;
      await sb.rpc('decline_chat_room_invite', { p_room_id: declineEl.dataset.declineInvite, p_share_key: wdsRemoteData.shareKey });
      await refreshWdsChatRooms();
      return;
    }
    const item = e.target.closest('[data-room-id]');
    if (item) { wdsOpenChatPopup(item.dataset.roomId); chatListPop.hidden = true; }
  });

  // New Group Chatroom composer.
  const newGroupOverlay = document.getElementById('wdsNewGroupOverlay');
  const newGroupErrorEl = document.getElementById('wdsNewGroupError');
  function wdsRenderNewGroupChips() {
    const container = document.getElementById('wdsNewGroupChips');
    container.innerHTML = wdsNewGroupInviteIds.map(id => `<span class="invite-chip">${escapeHtml(id)}<button type="button" data-remove-id="${escapeHtml(id)}" aria-label="Remove">✕</button></span>`).join('');
    container.querySelectorAll('[data-remove-id]').forEach(btn => {
      btn.addEventListener('click', () => { wdsNewGroupInviteIds = wdsNewGroupInviteIds.filter(id => id !== btn.dataset.removeId); wdsRenderNewGroupChips(); });
    });
  }
  document.getElementById('btnWdsNewGroup').addEventListener('click', () => {
    chatListPop.hidden = true;
    document.getElementById('wdsNewGroupName').value = '';
    document.getElementById('wdsNewGroupInviteInput').value = '';
    wdsNewGroupInviteIds = [];
    wdsRenderNewGroupChips();
    newGroupErrorEl.hidden = true;
    newGroupOverlay.hidden = false;
  });
  document.getElementById('btnWdsNewGroupClose').addEventListener('click', () => { newGroupOverlay.hidden = true; });
  bindOverlayBackdropClose(newGroupOverlay, () => { newGroupOverlay.hidden = true; });
  const wdsAddNewGroupInvitee = () => {
    const input = document.getElementById('wdsNewGroupInviteInput');
    const id = input.value.trim().toUpperCase();
    if (id && !wdsNewGroupInviteIds.includes(id)) { wdsNewGroupInviteIds.push(id); wdsRenderNewGroupChips(); }
    input.value = '';
  };
  document.getElementById('btnWdsNewGroupAddInvitee').addEventListener('click', wdsAddNewGroupInvitee);
  document.getElementById('wdsNewGroupInviteInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); wdsAddNewGroupInvitee(); } });
  document.getElementById('btnWdsNewGroupCreate').addEventListener('click', async () => {
    newGroupErrorEl.hidden = true;
    const name = document.getElementById('wdsNewGroupName').value.trim();
    if (!name) { newGroupErrorEl.textContent = 'Enter a group name.'; newGroupErrorEl.hidden = false; return; }
    if (!wdsRemoteData) return;
    try {
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      const { data, error } = await sb.rpc('create_chat_room', {
        p_name: name, p_creator_key: wdsRemoteData.shareKey, p_creator_name: codeName, p_invitee_ids: wdsNewGroupInviteIds,
      });
      if (error) throw error;
      newGroupOverlay.hidden = true;
      await refreshWdsChatRooms();
      wdsOpenChatPopup(data);
    } catch (e) {
      newGroupErrorEl.textContent = 'Could not create group: ' + ((e && e.message) || 'unknown error');
      newGroupErrorEl.hidden = false;
    }
  });

  // Floating popup windows — delegated since they're created dynamically.
  const chatPopupsWrap = document.getElementById('wdsChatPopupsWrap');
  const readWdsPopupImageFile = (roomId, file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      wdsPopupPendingImages[roomId] = reader.result;
      const preview = chatPopupsWrap.querySelector(`[data-popup-pending-image-preview="${roomId}"]`);
      const wrap = chatPopupsWrap.querySelector(`[data-popup-pending-image="${roomId}"]`);
      if (preview) preview.src = reader.result;
      if (wrap) wrap.hidden = false;
    };
    reader.readAsDataURL(file);
  };
  chatPopupsWrap.addEventListener('click', async e => {
    const closeBtn = e.target.closest('[data-close-popup]');
    if (closeBtn) { wdsCloseChatPopup(closeBtn.dataset.closePopup); return; }
    const lightboxImg = e.target.closest('[data-lightbox]');
    if (lightboxImg) { e.stopPropagation(); openChatLightbox(lightboxImg.dataset.lightbox); return; }
    const nameEl = e.target.closest('[data-dm-name]');
    if (nameEl) { wdsOpenChatUserMenu(nameEl.dataset.dmName, e.clientX, e.clientY, nameEl.dataset.dmKey); return; }
    const attachBtn = e.target.closest('[data-popup-attach]');
    if (attachBtn) {
      const roomId = attachBtn.dataset.popupAttach;
      const fileInput = chatPopupsWrap.querySelector(`[data-popup-image-input="${roomId}"]`);
      if (fileInput) fileInput.click();
      return;
    }
    const removeImgBtn = e.target.closest('[data-popup-remove-image]');
    if (removeImgBtn) {
      const roomId = removeImgBtn.dataset.popupRemoveImage;
      delete wdsPopupPendingImages[roomId];
      const wrap = chatPopupsWrap.querySelector(`[data-popup-pending-image="${roomId}"]`);
      if (wrap) wrap.hidden = true;
      const fileInput = chatPopupsWrap.querySelector(`[data-popup-image-input="${roomId}"]`);
      if (fileInput) fileInput.value = '';
      return;
    }
    const sendBtn = e.target.closest('[data-popup-send]');
    if (sendBtn) {
      const roomId = sendBtn.dataset.popupSend;
      const input = chatPopupsWrap.querySelector(`[data-popup-input="${roomId}"]`);
      const image = wdsPopupPendingImages[roomId] || null;
      if (!input || (!input.value.trim() && !image) || !wdsRemoteData) return;
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      const text = input.value;
      input.value = '';
      delete wdsPopupPendingImages[roomId];
      const pendingWrap = chatPopupsWrap.querySelector(`[data-popup-pending-image="${roomId}"]`);
      if (pendingWrap) pendingWrap.hidden = true;
      const fileInput = chatPopupsWrap.querySelector(`[data-popup-image-input="${roomId}"]`);
      if (fileInput) fileInput.value = '';
      wdsChatPopupLastActive[roomId] = Date.now();
      try {
        await postChatMessage(text, image, wdsRemoteData.shareKey, codeName, roomId);
        await wdsRefreshChatPopup(roomId);
        await refreshWdsChatRooms();
      } catch (err) { console.error('Popup send failed:', err); }
      return;
    }
    const popupEl = e.target.closest('.wds-chat-popup');
    if (popupEl) wdsChatPopupLastActive[popupEl.dataset.roomId] = Date.now();
  });
  chatPopupsWrap.addEventListener('change', e => {
    const fileInput = e.target.closest('[data-popup-image-input]');
    if (fileInput) readWdsPopupImageFile(fileInput.dataset.popupImageInput, fileInput.files[0]);
  });
  chatPopupsWrap.addEventListener('paste', e => {
    const input = e.target.closest('[data-popup-input]');
    if (!input) return;
    const file = wdsGetPastedImageFile(e);
    if (file) { e.preventDefault(); readWdsPopupImageFile(input.dataset.popupInput, file); }
  });
  chatPopupsWrap.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('[data-popup-input]')) {
      const roomId = e.target.dataset.popupInput;
      const sendBtn = chatPopupsWrap.querySelector(`[data-popup-send="${roomId}"]`);
      if (sendBtn) sendBtn.click();
    }
  });

  // Full-size image lightbox (used by chat photos and feed post photos
  // alike) — clicking the backdrop or the ✕ minimizes it back to the
  // preview; clicking the image itself is a no-op (stopPropagation) so it
  // doesn't close on the very click that's meant to view it.
  const wdsLightbox = document.getElementById('chatLightbox');
  if (wdsLightbox) {
    wdsLightbox.addEventListener('click', closeChatLightbox);
    document.getElementById('chatLightboxImg').addEventListener('click', e => e.stopPropagation());
    document.getElementById('chatLightboxClose').addEventListener('click', closeChatLightbox);
  }

  // Right-edge contact rail — click a DM/group avatar to open (or bring
  // back an evicted) popup.
  document.getElementById('wdsChatContactRail').addEventListener('click', e => {
    const avatar = e.target.closest('[data-room-id]');
    if (avatar) wdsOpenChatPopup(avatar.dataset.roomId);
  });

  // Per-user chat context menu — shared by Global Chat and every popup.
  const chatUserMenu = document.getElementById('wdsChatUserMenu');
  document.getElementById('btnWdsChatUserProfile').addEventListener('click', () => {
    const targetKey = wdsChatUserMenuTargetKey;
    wdsCloseChatUserMenu();
    if (targetKey) wdsOpenOtherProfile(targetKey);
  });
  document.getElementById('btnWdsChatUserDm').addEventListener('click', () => {
    const target = wdsChatUserMenuTarget;
    wdsCloseChatUserMenu();
    wdsStartDM(target);
  });
  document.getElementById('btnWdsChatUserInvite').addEventListener('click', () => {
    wdsRenderChatUserMenuGroups();
    document.getElementById('wdsChatUserMenuMain').hidden = true;
    document.getElementById('wdsChatUserMenuGroups').hidden = false;
  });
  document.getElementById('wdsChatUserMenuGroups').addEventListener('click', e => {
    const btn = e.target.closest('[data-invite-room]');
    if (btn) { wdsInviteUserToRoom(wdsChatUserMenuTarget, btn.dataset.inviteRoom); wdsCloseChatUserMenu(); }
  });
  document.getElementById('btnWdsChatUserCopyId').addEventListener('click', () => {
    wdsCopyChatUserDigitalId(wdsChatUserMenuTarget);
    wdsCloseChatUserMenu();
  });
  document.addEventListener('click', e => {
    if (!chatUserMenu.hidden && !chatUserMenu.contains(e.target) && !e.target.closest('[data-dm-name]')) wdsCloseChatUserMenu();
  });

  // ⋮ post menu — Edit/Delete (own posts only) + Share to My Day (any
  // post). Edit/Delete need the post's own card (found by
  // wdsPostMenuTargetId) since this menu is a single shared floating
  // element, not nested inside any one post.
  const postMenu = document.getElementById('wdsPostMenu');
  document.getElementById('btnWdsPostMenuEdit').addEventListener('click', () => {
    const id = wdsPostMenuTargetId;
    wdsClosePostMenu();
    if (id != null) wdsStartEditPost(id);
  });
  document.getElementById('btnWdsPostMenuDelete').addEventListener('click', async () => {
    const id = wdsPostMenuTargetId;
    wdsClosePostMenu();
    if (id == null || !wdsRemoteData || !confirm('Remove this post?')) return;
    try { await unsendFeedPost(id, wdsRemoteData.shareKey); await refreshWdsFeed(true); } catch (e) { /* best effort */ }
  });
  document.getElementById('btnWdsPostMenuShareMyday').addEventListener('click', () => {
    const shareId = wdsPostMenuShareId;
    const card = document.querySelector(`.wds-feed-post[data-post-id="${shareId}"]`) || document.querySelector(`.wds-feed-post[data-post-id="${wdsPostMenuTargetId}"]`);
    wdsClosePostMenu();
    if (card) wdsShareFeedPostToMyDay(wdsBuildSharePreviewFromCard(card));
  });
  document.addEventListener('click', e => {
    if (!postMenu.hidden && !postMenu.contains(e.target) && !e.target.closest('[data-action="post-menu"]')) wdsClosePostMenu();
  });

  // Global Chat's own sender names open the same context menu.
  document.getElementById('wdsChatList').addEventListener('click', e => {
    const nameEl = e.target.closest('[data-dm-name]');
    if (nameEl) { e.stopPropagation(); wdsOpenChatUserMenu(nameEl.dataset.dmName, e.clientX, e.clientY, nameEl.dataset.dmKey); }
  });

  // A Digital ID + PIN entered earlier in this browser tab's session
  // re-signs-in automatically on reload (re-fetching fresh data) instead of
  // re-prompting — sessionStorage is tab-scoped and cleared on tab close.
  const rememberedId = sessionStorage.getItem(SESSION_ID_KEY);
  const rememberedPin = sessionStorage.getItem(SESSION_PIN_KEY);
  if (rememberedId && rememberedPin) enterDashboard(rememberedId, rememberedPin);
}
// ---------------------------------------------------------------------
// Desktop dashboard rendering — calls the SAME pure calc functions the
// mobile tabs use (they already read via getProfile/getLogs/etc, which
// transparently pick up wdsRemoteData once signed in), then writes into
// the wds*-prefixed ids. Never calls the mobile render* functions — those
// target a completely different, mobile-only DOM tree.
// ---------------------------------------------------------------------

// Straight-line (not smoothed) chart path — honest for real, possibly
// sparse data rather than implying precision a bezier curve would.
// values: array of numbers, nulls filtered out (with their x position kept
// proportional to the full array length so gaps still read as gaps).
function wdsBuildLinePath(values, viewW, viewH, padY) {
  const pts = values.map((v, i) => (v == null ? null : [i, v])).filter(Boolean);
  if (pts.length < 2) return null;
  const idxs = pts.map(p => p[0]);
  const vals = pts.map(p => p[1]);
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = (max - min) || 1;
  const minIdx = Math.min(...idxs), maxIdx = Math.max(...idxs);
  const spanIdx = (maxIdx - minIdx) || 1;
  const coords = pts.map(([i, v]) => [
    ((i - minIdx) / spanIdx) * viewW,
    padY + (1 - (v - min) / range) * (viewH - padY * 2),
  ]);
  const line = coords.map((c, i) => (i === 0 ? 'M' : 'L') + c[0].toFixed(1) + ',' + c[1].toFixed(1)).join(' ');
  const area = line + ` L${coords[coords.length - 1][0].toFixed(1)},${viewH} L${coords[0][0].toFixed(1)},${viewH} Z`;
  return { line, area, last: coords[coords.length - 1] };
}

function wdsSetChartPaths(areaId, lineId, dotId, emptyId, values) {
  const built = wdsBuildLinePath(values, 560, 160, 20);
  const areaEl = document.getElementById(areaId);
  const lineEl = document.getElementById(lineId);
  const dotEl = dotId ? document.getElementById(dotId) : null;
  const emptyEl = document.getElementById(emptyId);
  if (built) {
    areaEl.setAttribute('d', built.area);
    lineEl.setAttribute('d', built.line);
    if (dotEl) { dotEl.setAttribute('cx', built.last[0]); dotEl.setAttribute('cy', built.last[1]); dotEl.setAttribute('visibility', 'visible'); }
    if (emptyEl) emptyEl.hidden = true;
  } else {
    areaEl.setAttribute('d', '');
    lineEl.setAttribute('d', '');
    if (dotEl) dotEl.setAttribute('visibility', 'hidden');
    if (emptyEl) emptyEl.hidden = false;
  }
}

function wdsFormatPace(secPerKm) {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, '0')} /km`;
}

function wdsRelativeTime(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}

// Heaviest single completed set in the last 7 days — kg, canonical storage
// unit (converted to the profile's preferred unit by the caller).
function wdsHeaviestSetThisWeekKg(logsArr) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0, 0, 0, 0);
  let heaviest = null;
  logsArr.filter(l => parseISO(l.date) >= cutoff).forEach(l => {
    (l.exercises || []).forEach(ex => (ex.sets || []).forEach(s => {
      if (s.completed && s.weightKg != null && (heaviest == null || s.weightKg > heaviest)) heaviest = s.weightKg;
    }));
  });
  return heaviest;
}

// Today's habit completion using only fields present in the synced
// snapshot — deliberately NOT computeHabitCompletion(), which also reads
// two device-local flags (wft_lb_optin, wft_drive_last_backup) that will
// never be set on this origin and would understate the real score.
function wdsTodayHabitPct(profile, entry) {
  const checks = [
    !!(entry && entry.exercises && entry.exercises.length > 0),
    !!(entry && entry.steps != null && entry.steps >= getEffectiveStepGoal(profile)),
    !!(entry && entry.weightKg != null),
  ];
  let total = checks.length, done = checks.filter(Boolean).length;
  (profile ? profile.extraHabits || [] : []).forEach((label, i) => {
    if (!label) return;
    total++;
    if (entry && entry.extra && entry.extra[i]) done++;
  });
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

function renderWdsDashboard() {
  renderWdsStatus();
  renderWdsTraining();
  renderWdsNutrition();
  renderWdsBio();
  renderWdsNexus().catch(() => {});
  refreshWdsFeed().catch(() => {});
  refreshWdsFriendRequests().catch(() => {});
  refreshWdsLeaderboardList().catch(() => {});
  renderWdsMenu();
  renderWdsNotifications();
}

// Third-column sidebar widget, under Notifications — the exact same six
// per-metric rankings as the mobile app's own Nexus tab (same
// pullLeaderboard/dedupeRankRows/renderRankList helpers, just targeting
// wdsLb*-prefixed containers instead of mobile's lb* ones so this never
// touches the mobile DOM).
async function refreshWdsLeaderboardList() {
  const emptyNoteEl = document.getElementById('wdsLbEmptyNote');
  if (!emptyNoteEl || !sbConfigured()) return;
  try {
    const rows = await pullLeaderboard();
    emptyNoteEl.hidden = rows.length > 0;

    const bySteps = dedupeRankRows(rows.filter(r => r.steps != null), (a, b) => a.steps > b.steps).sort((a, b) => b.steps - a.steps);
    renderRankList('wdsLbStepsRanking', bySteps, { formatValue: r => r.steps >= 1000 ? (r.steps / 1000).toFixed(1) + 'k' : String(r.steps) });

    const byVolume = dedupeRankRows(rows.filter(r => r.volume_lifted != null), (a, b) => a.volume_lifted > b.volume_lifted).sort((a, b) => b.volume_lifted - a.volume_lifted);
    renderRankList('wdsLbVolumeRanking', byVolume, { formatValue: r => round0(r.volume_lifted) + ' ' + (r.volume_unit || 'kg') });

    const byProgress = dedupeRankRows(rows.filter(r => r.weight_progress_pct != null), (a, b) => a.weight_progress_pct < b.weight_progress_pct).sort((a, b) => a.weight_progress_pct - b.weight_progress_pct);
    renderRankList('wdsLbBioRanking', byProgress, { formatValue: r => (r.weight_progress_pct > 0 ? '+' : '') + r.weight_progress_pct + '%' });

    const byFurthestRun = dedupeRankRows(rows.filter(r => r.furthest_run_km != null), (a, b) => a.furthest_run_km > b.furthest_run_km).sort((a, b) => b.furthest_run_km - a.furthest_run_km);
    renderRankList('wdsLbFurthestRunRanking', byFurthestRun, { formatValue: r => round2(r.furthest_run_km) + ' km' });

    const byFastestRun = dedupeRankRows(rows.filter(r => r.fastest_run_pace_sec != null), (a, b) => a.fastest_run_pace_sec < b.fastest_run_pace_sec).sort((a, b) => a.fastest_run_pace_sec - b.fastest_run_pace_sec);
    renderRankList('wdsLbFastestRunRanking', byFastestRun, { formatValue: r => formatPaceSecPerUnit(r.fastest_run_pace_sec) + ' /km' });

    const byConscientious = dedupeRankRows(rows.filter(r => r.conscientious_score != null), (a, b) => a.conscientious_score > b.conscientious_score).sort((a, b) => b.conscientious_score - a.conscientious_score);
    renderRankList('wdsLbConscientiousRanking', byConscientious, { formatValue: r => r.conscientious_score + '%' });
  } catch (e) { /* best effort */ }
}

function renderWdsMenu() {
  const idEl = document.getElementById('wdsMenuDigitalId');
  const modeEl = document.getElementById('wdsMenuFitnessMode');
  if (idEl) idEl.textContent = wdsRemoteData ? wdsRemoteData.publicId : '–';
  if (modeEl) modeEl.textContent = MODE_LABEL[getFitnessMode()] || '–';
  const themeToggle = document.getElementById('wdsThemeToggle');
  if (themeToggle) themeToggle.checked = document.documentElement.getAttribute('data-theme') === 'light';

  const profile = getProfile();
  const daysEl = document.getElementById('wdsMenuDaysActive');
  if (daysEl) {
    if (profile && profile.startDate) {
      const days = Math.max(0, Math.round((parseISO(todayISO()) - parseISO(profile.startDate)) / 86400000));
      daysEl.textContent = days + (days === 1 ? ' day' : ' days');
    } else {
      daysEl.textContent = '–';
    }
  }

  const stepGoalEl = document.getElementById('wdsMenuStepGoal');
  const waterGoalEl = document.getElementById('wdsMenuWaterGoal');
  const weightUnitEl = document.getElementById('wdsMenuWeightUnit');
  const goalModeEl = document.getElementById('wdsMenuGoalMode');
  if (stepGoalEl) stepGoalEl.textContent = profile ? getEffectiveStepGoal(profile).toLocaleString() : '–';
  if (waterGoalEl) waterGoalEl.textContent = profile ? (effectiveWaterTargetML(todayISO()) / 1000).toFixed(1) + 'L' : '–';
  if (weightUnitEl) weightUnitEl.textContent = profile ? (profile.weightUnit || 'kg').toUpperCase() : '–';
  if (goalModeEl) goalModeEl.textContent = profile ? (profile.goalMode === 'bulk' ? 'Bulk' : 'Cut') : '–';
}

function renderWdsStatus() {
  const logsArr = sortedLogsArray();
  const mp = getModeProgress();
  const today = todayISO();
  const todayEntry = getLogs()[today] || {};

  const pct = mp.target ? Math.round((mp.completeCount / mp.target) * 100) : 0;
  document.getElementById('wdsConsistencyGauge').style.setProperty('--pct', Math.min(100, pct));
  document.getElementById('wdsConsistencyValue').innerHTML = pct + '<small>%</small>';
  const foot = document.getElementById('wdsConsistencyFoot');
  foot.textContent = `${mp.completeCount} of ${mp.target} days logged this cycle`;
  foot.className = 'wds-card-foot ' + (pct >= 70 ? 'wds-foot-good' : pct >= 40 ? 'wds-foot-warning' : '');

  const sleepAvg = avgOfLastNDays(logsArr, 'sleep', 7);
  document.getElementById('wdsTileSleepValue').textContent = sleepAvg != null ? sleepAvg.toFixed(1) + ' / 5' : '–';
  document.getElementById('wdsTileSleepSub').textContent = sleepAvg != null ? '7d avg' : 'No data';

  const waterTarget = effectiveWaterTargetML(today);
  const waterNow = todayEntry.water || 0;
  document.getElementById('wdsTileHydrationValue').textContent = (waterNow / 1000).toFixed(1) + 'L';
  document.getElementById('wdsTileHydrationSub').textContent = waterTarget ? Math.round((waterNow / waterTarget) * 100) + '% of target' : '';

  const stepsAvg = avgOfLastNDays(logsArr, 'steps', 7);
  document.getElementById('wdsTileStepsValue').textContent = stepsAvg != null ? Math.round(stepsAvg).toLocaleString() : '–';
  document.getElementById('wdsTileStepsSub').textContent = stepsAvg != null ? '7d avg' : 'No data';

  const stressAvg = avgOfLastNDays(logsArr, 'stress', 7);
  document.getElementById('wdsTileStressValue').textContent = stressAvg != null ? stressAvg.toFixed(1) + ' / 5' : '–';
  document.getElementById('wdsTileStressSub').textContent = stressAvg != null ? '7d avg' : 'No data';

  const series = computeTrendSeries(logsArr).slice(-90);
  wdsSetChartPaths('wdsWeightChartArea', 'wdsWeightChartLine', 'wdsWeightChartDot', 'wdsWeightChartEmpty', series.map(s => s.trendKg));
}

function renderWdsTraining() {
  const profile = getProfile();
  const logsArr = sortedLogsArray();
  const stats = computeLeaderboardStats();
  const todayEntry = getLogs()[todayISO()];

  const fatigue = todayEntry && todayEntry.fatigue != null ? todayEntry.fatigue : null;
  const fatiguePct = fatigue != null ? Math.round((fatigue / 5) * 100) : 0;
  document.getElementById('wdsFatigueGauge').style.setProperty('--pct', fatiguePct);
  document.getElementById('wdsFatigueValue').innerHTML = (fatigue != null ? fatiguePct : '–') + '<small>%</small>';
  document.getElementById('wdsFatigueFoot').textContent = fatigue != null
    ? (fatigue <= 2 ? 'Well recovered' : fatigue <= 3 ? 'Moderate fatigue' : 'High fatigue — consider recovery')
    : 'Not logged today';

  document.getElementById('wdsTileVolumeValue').textContent = stats.volume != null ? `${stats.volume.toLocaleString()} ${stats.volumeUnit}` : '–';
  const heaviestKg = wdsHeaviestSetThisWeekKg(logsArr);
  const wu = (profile && profile.weightUnit) || 'kg';
  document.getElementById('wdsTileHeaviestValue').textContent = heaviestKg != null ? `${round0(fromKg(heaviestKg, wu))} ${wu}` : '–';
  document.getElementById('wdsTileLongestRunValue').textContent = stats.furthestRunKm != null ? `${stats.furthestRunKm} km` : '–';
  document.getElementById('wdsTileFastestPaceValue').textContent = stats.fastestRunPaceSec != null ? wdsFormatPace(stats.fastestRunPaceSec) : '–';
}

function renderWdsNutrition() {
  const profile = getProfile();
  const date = todayISO();
  const entry = getLogs()[date] || {};
  const mt = profile ? computeMacroTargets(profile, date) : null;

  if (mt) {
    const proteinNow = entry.protein ?? 0, carbsNow = entry.carbs ?? 0, fatNow = entry.fat ?? 0;
    document.getElementById('wdsMacroProteinText').textContent = `${proteinNow} / ${mt.proteinTarget}g`;
    document.getElementById('wdsMacroProteinBar').style.width = Math.min(100, (proteinNow / mt.proteinTarget) * 100) + '%';
    document.getElementById('wdsMacroCarbsText').textContent = `${carbsNow} / ${mt.carbTarget}g`;
    document.getElementById('wdsMacroCarbsBar').style.width = Math.min(100, (carbsNow / mt.carbTarget) * 100) + '%';
    document.getElementById('wdsMacroFatText').textContent = `${fatNow} / ${mt.fatTarget}g`;
    document.getElementById('wdsMacroFatBar').style.width = Math.min(100, (fatNow / mt.fatTarget) * 100) + '%';
  } else {
    ['wdsMacroProteinText', 'wdsMacroCarbsText', 'wdsMacroFatText'].forEach(id => { document.getElementById(id).textContent = '– / –g'; });
  }
}

function renderWdsBio() {
  const profile = getProfile();
  const stats = computeLeaderboardStats();
  const today = todayISO();

  const bodyFatEntry = findLastBodyFatEntry(today);
  const bodyFatPct = bodyFatEntry ? computeBodyFatJP7(bodyFatEntry.skinfolds, profile ? profile.age : null, profile ? profile.gender : null) : null;
  document.getElementById('wdsMarkerBodyFatText').textContent = bodyFatPct != null ? bodyFatPct.toFixed(1) + '%' : '–';
  document.getElementById('wdsMarkerBodyFatBar').style.width = bodyFatPct != null ? Math.min(100, bodyFatPct * 2) + '%' : '0%';

  document.getElementById('wdsMarkerWeightProgressText').textContent = stats.progress != null ? `${stats.progress > 0 ? '+' : ''}${stats.progress}${stats.weightUnit}` : '–';
  document.getElementById('wdsMarkerWeightProgressBar').style.width = stats.progressPct != null ? Math.min(100, Math.abs(stats.progressPct) * 5) + '%' : '0%';

  const todayEntry = getLogs()[today];
  const habitPct = wdsTodayHabitPct(profile, todayEntry);
  document.getElementById('wdsMarkerHabitText').textContent = habitPct + '%';
  document.getElementById('wdsMarkerHabitBar').style.width = habitPct + '%';
}

async function renderWdsNexus() {
  const chatListEl = document.getElementById('wdsChatList');

  if (!sbConfigured()) {
    if (chatListEl) chatListEl.innerHTML = '<p class="empty-note">Chat unavailable.</p>';
    await refreshWdsChat();
    return;
  }

  await refreshWdsMyday();
  await refreshWdsChat();
}

// ---------------------------------------------------------------------
// My Day — Instagram/Facebook-style Stories. A photo or short text that
// disappears after 24 hours; expiry is enforced server-side in the
// feed_stories SELECT policy itself (created_at >= now() - 24h), so an
// expired story just stops coming back from the query — nothing to clean
// up client-side. Every active story is kept (not just the newest per
// person) — the ring still shows one tile per person, but opening it
// plays through that person's whole set in order, then chains into the
// next person's, same as Facebook/Instagram Stories.
// ---------------------------------------------------------------------
async function fetchActiveStories() {
  const { data, error } = await sb.from('feed_stories')
    .select('id, share_key, code_name, message, image_url, link_preview, created_at')
    .eq('deleted', false)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

// Groups the flat, newest-first story list into one entry per person
// (ring order = that person's most recent story, newest first), with
// each person's own stories sorted oldest-first so playback runs in the
// order they were actually posted.
function wdsGroupStoriesByUser(stories) {
  const order = [];
  const byKey = {};
  stories.forEach(s => {
    if (!byKey[s.share_key]) { byKey[s.share_key] = []; order.push(s.share_key); }
    byKey[s.share_key].push(s);
  });
  return order.map(key => ({
    shareKey: key,
    codeName: byKey[key][0].code_name,
    stories: byKey[key].slice().reverse(),
  }));
}

async function postFeedStory(text, imageDataUrl, shareKey, codeName, linkPreview) {
  const trimmed = (text || '').trim().slice(0, 500);
  if (!trimmed && !imageDataUrl && !linkPreview) return;
  let imageUrl = null;
  if (imageDataUrl) imageUrl = await uploadChatImage(imageDataUrl, shareKey);
  const { error } = await sb.from('feed_stories').insert({ share_key: shareKey, code_name: codeName, message: trimmed, image_url: imageUrl, link_preview: linkPreview || null });
  if (error) throw error;
}

async function unsendFeedStory(storyId, shareKey) {
  const { error } = await sb.rpc('unsend_feed_story', { p_story_id: storyId, p_share_key: shareKey });
  if (error) throw error;
}

let wdsActiveStories = [];
let wdsStoryGroups = []; // [{shareKey, codeName, stories: [oldest...newest]}], ring order = most-recent-first

// Story composer engine state — a single photo (pannable/zoomable) plus
// any number of draggable/resizable/rotatable text layers, composited
// down to one flattened PNG on Share (wdsFlattenStoryToDataUrl below).
// Kept top-level (not inside initDesktopShell's closure) so the flatten
// step and the drag/resize/rotate handlers — all plain top-level
// functions, matching this file's existing wds* helper convention — can
// read/write it directly.
let wdsPendingStoryImageDataUrl = null;
let wdsStoryPhotoTransform = { scale: 1, x: 0, y: 0 };
let wdsStoryTextItems = []; // [{id, text, x, y (0-1 canvas fractions), fontSizeFrac, rotation (deg), font, color, style}]
let wdsStoryActiveTextId = null;
let wdsStoryTextSeq = 0;
const WDS_STORY_BG_SWATCHES = [
  { id: 'none',   stops: null },
  { id: 'grad1',  stops: ['#8069D6', '#33C8CC'] },
  { id: 'grad2',  stops: ['#FF6B6B', '#FFD166'] },
  { id: 'grad3',  stops: ['#0F2027', '#2C5364'] },
  { id: 'solid1', stops: ['#101820'] },
  { id: 'solid2', stops: ['#7B2CBF'] },
  { id: 'solid3', stops: ['#E63946'] },
  { id: 'solid4', stops: ['#2A9D8F'] },
];
let wdsStoryBg = WDS_STORY_BG_SWATCHES[1];
const WDS_STORY_TEXT_FONTS = {
  display: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Roboto Mono', monospace",
  serif: "Georgia, 'Times New Roman', serif",
  rounded: "'Segoe UI Rounded', 'Varela Round', system-ui, sans-serif",
};
const WDS_STORY_TEXT_COLORS = ['#ffffff', '#000000', '#ff5252', '#ffd166', '#33c8cc', '#8069d6', '#2ecc71', '#ff8fab'];
const WDS_STORY_TEXT_STYLES = ['plain', 'pill', 'outline'];

function wdsBgCss(bg) {
  if (!bg || !bg.stops) return 'transparent';
  return bg.stops.length > 1 ? `linear-gradient(135deg, ${bg.stops[0]}, ${bg.stops[1]})` : bg.stops[0];
}

// Fill mode vs tint mode: with no photo, the swatch is the whole canvas
// background; once a photo is loaded, the same swatch instead becomes a
// semi-transparent overlay blended on top of it ("none" clears the tint).
function wdsSetStoryBg(bg) {
  wdsStoryBg = bg;
  document.querySelectorAll('#wdsStoryBgRow [data-bg]').forEach(b => b.classList.toggle('is-active', b.dataset.bg === bg.id));
  const canvas = document.getElementById('wdsStoryCreateCanvas');
  const blendLayer = document.getElementById('wdsStoryBlendLayer');
  if (!canvas || !blendLayer) return;
  if (wdsPendingStoryImageDataUrl) {
    canvas.style.background = '';
    if (bg.stops) { blendLayer.hidden = false; blendLayer.style.background = wdsBgCss(bg); }
    else { blendLayer.hidden = true; }
  } else {
    blendLayer.hidden = true;
    canvas.style.background = bg.stops ? wdsBgCss(bg) : '';
  }
}

function wdsBuildStoryBgRow() {
  const row = document.getElementById('wdsStoryBgRow');
  if (!row) return;
  row.innerHTML = WDS_STORY_BG_SWATCHES.map(bg => bg.id === 'none'
    ? `<button type="button" class="wds-story-bg-swatch wds-story-bg-swatch--none" data-bg="none" aria-label="No tint">✕</button>`
    : `<button type="button" class="wds-story-bg-swatch" data-bg="${bg.id}" style="background:${wdsBgCss(bg)}" aria-label="Background color"></button>`
  ).join('');
  row.addEventListener('click', e => {
    const btn = e.target.closest('[data-bg]');
    if (!btn) return;
    const bg = WDS_STORY_BG_SWATCHES.find(b => b.id === btn.dataset.bg);
    if (bg) wdsSetStoryBg(bg);
  });
}

function wdsApplyPhotoTransform() {
  const canvas = document.getElementById('wdsStoryCreateCanvas');
  const img = document.getElementById('wdsStoryComposerPendingImagePreview');
  if (!canvas || !img) return;
  const rect = canvas.getBoundingClientRect();
  const tx = wdsStoryPhotoTransform.x * rect.width;
  const ty = wdsStoryPhotoTransform.y * rect.height;
  img.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(${wdsStoryPhotoTransform.scale})`;
}

function wdsUpdateStoryHint() {
  const hint = document.getElementById('wdsStoryCreateHint');
  if (hint) hint.hidden = !!wdsPendingStoryImageDataUrl || wdsStoryTextItems.length > 0;
}

// Link attachment — a small card shown below the canvas (not baked into
// the flattened PNG, since it needs to stay a real, tappable element in
// the viewer). Two sources: pasting a URL here unfurls it via the same
// link-preview Edge Function feed posts already use; "Share to My Day"
// (from a feed post's action row) builds one of these objects locally
// instead, with internal:true (see wdsBuildLinkPreviewHtml).
let wdsStoryLinkPreview = null;
function wdsRenderStoryLinkPreviewBox() {
  const box = document.getElementById('wdsStoryLinkPreviewBox');
  if (!box) return;
  if (!wdsStoryLinkPreview) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<div style="position:relative;">${wdsBuildLinkPreviewHtml(wdsStoryLinkPreview)}<button type="button" class="wds-link-preview-remove" id="btnWdsStoryLinkPreviewRemove" aria-label="Remove link">✕</button></div>`;
  box.querySelectorAll('a.wds-link-preview-card').forEach(a => a.style.pointerEvents = 'none');
  const removeBtn = document.getElementById('btnWdsStoryLinkPreviewRemove');
  if (removeBtn) removeBtn.addEventListener('click', () => { wdsStoryLinkPreview = null; wdsRenderStoryLinkPreviewBox(); });
}

// Resets the composer (clearing any in-progress text/photo) and preloads
// it with a link preview built from an existing feed post, then opens it
// — the "Share to My Day" action on a feed post's action row. A standalone
// top-level function (not reusing the composer-init closure's own
// resetWdsStoryComposer) so it can be called from the feed's own click
// handler regardless of which function scope that's in.
function wdsShareFeedPostToMyDay(preview) {
  const textLayers = document.getElementById('wdsStoryTextLayers');
  if (textLayers) textLayers.innerHTML = '';
  wdsStoryTextItems = [];
  wdsDeselectStoryText();
  wdsPendingStoryImageDataUrl = null;
  const photoLayer = document.getElementById('wdsStoryPhotoLayer');
  if (photoLayer) photoLayer.hidden = true;
  const removeBtn = document.getElementById('btnWdsStoryComposerImageRemove');
  if (removeBtn) removeBtn.hidden = true;
  const zoomRow = document.getElementById('wdsStoryPhotoZoomRow');
  if (zoomRow) zoomRow.hidden = true;
  wdsStoryPhotoTransform = { scale: 1, x: 0, y: 0 };
  wdsSetStoryBg(WDS_STORY_BG_SWATCHES[1]);
  wdsStoryLinkPreview = preview;
  wdsRenderStoryLinkPreviewBox();
  wdsUpdateStoryHint();
  wdsOpenStoryComposer();
}

// Shared by the ⋮ post menu's "Share to My Day" item — builds a
// link_preview-shaped object (internal:true, see wdsBuildLinkPreviewHtml)
// from a post card's own rendered name/text/image, no extra fetch needed.
function wdsBuildSharePreviewFromCard(card) {
  const nameEl = card.querySelector('.wds-post-meta strong');
  const bodyEl = card.querySelector('.wds-post-body');
  const imgEl = card.querySelector('.wds-post-image, .wds-post-gallery img');
  return {
    internal: true,
    siteName: 'Winfinity Nexus',
    title: nameEl ? nameEl.textContent.trim() + "'s post" : 'Shared post',
    description: bodyEl ? bodyEl.textContent.trim().slice(0, 200) : '',
    image: imgEl ? imgEl.src : null,
    url: '#',
  };
}

// The ⋮ menu on each feed post — Share to My Day always offered; Edit and
// Delete only for your own posts. A single shared floating menu (same
// pattern as wdsChatUserMenu) repositioned per click, rather than one
// per-post popover, since only one can ever be open at a time.
let wdsPostMenuTargetId = null;
let wdsPostMenuShareId = null;
function wdsOpenPostMenu(postId, shareId, isOwn, x, y) {
  wdsPostMenuTargetId = postId;
  wdsPostMenuShareId = shareId;
  const menu = document.getElementById('wdsPostMenu');
  if (!menu) return;
  const editBtn = document.getElementById('btnWdsPostMenuEdit');
  const deleteBtn = document.getElementById('btnWdsPostMenuDelete');
  if (editBtn) editBtn.hidden = !isOwn;
  if (deleteBtn) deleteBtn.hidden = !isOwn;
  menu.hidden = false;
  const menuWidth = 200;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 12)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 160)) + 'px';
}
function wdsClosePostMenu() {
  const menu = document.getElementById('wdsPostMenu');
  if (menu) menu.hidden = true;
  wdsPostMenuTargetId = null;
  wdsPostMenuShareId = null;
}

// Inline edit — swaps the post body (or inserts one, for an image-only
// post) for a textarea + Save/Cancel row. Cancel just re-renders from the
// already-fetched feed cache instead of trying to restore the original
// markup by hand.
function wdsStartEditPost(postId) {
  const card = document.querySelector(`.wds-feed-post[data-post-id="${postId}"]`);
  if (!card) return;
  const existing = card.querySelector('.wds-post-body');
  const currentText = existing ? existing.textContent : '';
  const editBox = document.createElement('div');
  editBox.className = 'wds-post-edit-box';
  editBox.innerHTML = `
    <textarea maxlength="2000">${escapeHtml(currentText)}</textarea>
    <div class="wds-post-edit-actions">
      <button type="button" class="wds-mini-btn" data-action="save-edit-post">Save</button>
      <button type="button" class="wds-mini-btn" data-action="cancel-edit-post">Cancel</button>
    </div>`;
  if (existing) existing.replaceWith(editBox);
  else card.querySelector('.wds-post-head').insertAdjacentElement('afterend', editBox);
  const textarea = editBox.querySelector('textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}
async function wdsSaveEditPost(postId, shareKey) {
  const card = document.querySelector(`.wds-feed-post[data-post-id="${postId}"]`);
  const textarea = card ? card.querySelector('.wds-post-edit-box textarea') : null;
  if (!textarea || !shareKey) return;
  try {
    await editFeedPost(postId, shareKey, textarea.value);
    await refreshWdsFeed(true);
  } catch (e) { /* best effort — leaves the edit box open so nothing typed is lost */ }
}

function wdsSyncStoryTextToolbar(item) {
  document.querySelectorAll('#wdsStoryFontRow [data-font]').forEach(b => b.classList.toggle('is-active', b.dataset.font === item.font));
  document.querySelectorAll('#wdsStoryColorRow [data-color]').forEach(b => b.classList.toggle('is-active', b.dataset.color === item.color));
  const styleBtn = document.getElementById('btnWdsStoryTextStyleToggle');
  if (styleBtn) styleBtn.textContent = item.style.charAt(0).toUpperCase() + item.style.slice(1);
}

function wdsSelectStoryText(id) {
  const layers = document.getElementById('wdsStoryTextLayers');
  const toolbar = document.getElementById('wdsStoryTextToolbar');
  if (!layers) return;
  layers.querySelectorAll('.wds-story-text-item.is-active').forEach(n => n.classList.remove('is-active'));
  wdsStoryActiveTextId = id;
  const el = layers.querySelector(`.wds-story-text-item[data-id="${id}"]`);
  if (el) el.classList.add('is-active');
  const item = wdsStoryTextItems.find(t => t.id === id);
  if (item) wdsSyncStoryTextToolbar(item);
  if (toolbar) toolbar.hidden = !item;
}

function wdsDeselectStoryText() {
  const layers = document.getElementById('wdsStoryTextLayers');
  const toolbar = document.getElementById('wdsStoryTextToolbar');
  if (layers) layers.querySelectorAll('.wds-story-text-item.is-active').forEach(n => n.classList.remove('is-active'));
  wdsStoryActiveTextId = null;
  if (toolbar) toolbar.hidden = true;
}

// Drag/resize/rotate all use pointer capture directly on the handle that
// started the gesture — listeners live and die on that same element, so
// there's no risk of leaking a document-level listener if the pointerup
// is missed.
function wdsWireStoryTextDrag(handle, itemEl, item, canvas) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    wdsSelectStoryText(item.id);
    handle.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const startFracX = item.x, startFracY = item.y;
    const onMove = ev => {
      item.x = Math.min(1, Math.max(0, startFracX + (ev.clientX - startX) / rect.width));
      item.y = Math.min(1, Math.max(0, startFracY + (ev.clientY - startY) / rect.height));
      itemEl.style.left = (item.x * 100) + '%';
      itemEl.style.top = (item.y * 100) + '%';
    };
    const onUp = () => handle.removeEventListener('pointermove', onMove);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
}
function wdsWireStoryTextResize(handle, inner, item, canvas) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    wdsSelectStoryText(item.id);
    handle.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + item.x * rect.width;
    const centerY = rect.top + item.y * rect.height;
    const startDist = Math.hypot(e.clientX - centerX, e.clientY - centerY) || 1;
    const startFrac = item.fontSizeFrac;
    const onMove = ev => {
      const dist = Math.hypot(ev.clientX - centerX, ev.clientY - centerY);
      item.fontSizeFrac = Math.min(0.22, Math.max(0.025, startFrac * (dist / startDist)));
      inner.style.fontSize = (item.fontSizeFrac * rect.height) + 'px';
    };
    const onUp = () => handle.removeEventListener('pointermove', onMove);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
}
function wdsWireStoryTextRotate(handle, inner, item, canvas) {
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    wdsSelectStoryText(item.id);
    handle.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const centerX = rect.left + item.x * rect.width;
    const centerY = rect.top + item.y * rect.height;
    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180 / Math.PI;
    const startRotation = item.rotation;
    const onMove = ev => {
      const angle = Math.atan2(ev.clientY - centerY, ev.clientX - centerX) * 180 / Math.PI;
      item.rotation = startRotation + (angle - startAngle);
      inner.style.transform = `rotate(${item.rotation}deg)`;
    };
    const onUp = () => handle.removeEventListener('pointermove', onMove);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
}

function wdsApplyStoryTextInnerStyle(inner, item, rect) {
  inner.style.fontSize = (item.fontSizeFrac * rect.height) + 'px';
  inner.style.color = item.color;
  inner.style.fontFamily = WDS_STORY_TEXT_FONTS[item.font] || WDS_STORY_TEXT_FONTS.display;
  inner.style.transform = `rotate(${item.rotation}deg)`;
  inner.style.webkitTextStrokeColor = item.color === '#000000' ? '#ffffff' : '#000000';
  inner.dataset.style = item.style;
}

function wdsCreateStoryTextEl(item) {
  const canvas = document.getElementById('wdsStoryCreateCanvas');
  const rect = canvas.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'wds-story-text-item';
  el.dataset.id = item.id;
  el.style.left = (item.x * 100) + '%';
  el.style.top = (item.y * 100) + '%';

  const inner = document.createElement('div');
  inner.className = 'wds-story-text-inner';
  inner.contentEditable = 'true';
  inner.textContent = item.text;
  wdsApplyStoryTextInnerStyle(inner, item, rect);
  inner.addEventListener('focus', () => wdsSelectStoryText(item.id));
  inner.addEventListener('pointerdown', e => { e.stopPropagation(); wdsSelectStoryText(item.id); });
  inner.addEventListener('input', () => { item.text = inner.innerText; });

  // Icons match the app's existing stroke-SVG icon language (see e.g. the
  // admin drawer icons in index.html) rather than emoji glyphs.
  const moveHandle = document.createElement('div');
  moveHandle.className = 'wds-story-text-handle wds-story-text-handle--move';
  moveHandle.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>';
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'wds-story-text-handle wds-story-text-handle--resize';
  resizeHandle.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const rotateHandle = document.createElement('div');
  rotateHandle.className = 'wds-story-text-handle wds-story-text-handle--rotate';
  rotateHandle.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';

  el.append(inner, moveHandle, resizeHandle, rotateHandle);
  wdsWireStoryTextDrag(moveHandle, el, item, canvas);
  wdsWireStoryTextResize(resizeHandle, inner, item, canvas);
  wdsWireStoryTextRotate(rotateHandle, inner, item, canvas);
  return el;
}

function wdsAddStoryText() {
  wdsStoryTextSeq += 1;
  const item = { id: 'txt' + wdsStoryTextSeq, text: '', x: 0.5, y: 0.5, fontSizeFrac: 0.07, rotation: 0, font: 'display', color: '#ffffff', style: 'plain' };
  wdsStoryTextItems.push(item);
  const layers = document.getElementById('wdsStoryTextLayers');
  const el = wdsCreateStoryTextEl(item);
  layers.appendChild(el);
  wdsSelectStoryText(item.id);
  wdsUpdateStoryHint();
  el.querySelector('.wds-story-text-inner').focus();
}

function wdsBuildStoryToolbarRows() {
  const fontRow = document.getElementById('wdsStoryFontRow');
  const colorRow = document.getElementById('wdsStoryColorRow');
  const styleBtn = document.getElementById('btnWdsStoryTextStyleToggle');
  const deleteBtn = document.getElementById('btnWdsStoryTextDelete');
  if (!fontRow || !colorRow || !styleBtn || !deleteBtn) return;

  fontRow.innerHTML = Object.keys(WDS_STORY_TEXT_FONTS).map(key =>
    `<button type="button" class="wds-story-font-swatch" data-font="${key}" style="font-family:${WDS_STORY_TEXT_FONTS[key]}">Aa</button>`
  ).join('');
  fontRow.addEventListener('click', e => {
    const btn = e.target.closest('[data-font]');
    const item = wdsStoryTextItems.find(t => t.id === wdsStoryActiveTextId);
    if (!btn || !item) return;
    item.font = btn.dataset.font;
    const el = document.querySelector(`.wds-story-text-item[data-id="${item.id}"] .wds-story-text-inner`);
    if (el) el.style.fontFamily = WDS_STORY_TEXT_FONTS[item.font];
    wdsSyncStoryTextToolbar(item);
  });

  colorRow.innerHTML = WDS_STORY_TEXT_COLORS.map(c =>
    `<button type="button" class="wds-story-color-swatch" data-color="${c}" style="background:${c}" aria-label="Text color"></button>`
  ).join('');
  colorRow.addEventListener('click', e => {
    const btn = e.target.closest('[data-color]');
    const item = wdsStoryTextItems.find(t => t.id === wdsStoryActiveTextId);
    if (!btn || !item) return;
    item.color = btn.dataset.color;
    const el = document.querySelector(`.wds-story-text-item[data-id="${item.id}"] .wds-story-text-inner`);
    if (el) { el.style.color = item.color; el.style.webkitTextStrokeColor = item.color === '#000000' ? '#ffffff' : '#000000'; }
    wdsSyncStoryTextToolbar(item);
  });

  styleBtn.addEventListener('click', () => {
    const item = wdsStoryTextItems.find(t => t.id === wdsStoryActiveTextId);
    if (!item) return;
    item.style = WDS_STORY_TEXT_STYLES[(WDS_STORY_TEXT_STYLES.indexOf(item.style) + 1) % WDS_STORY_TEXT_STYLES.length];
    const el = document.querySelector(`.wds-story-text-item[data-id="${item.id}"] .wds-story-text-inner`);
    if (el) el.dataset.style = item.style;
    wdsSyncStoryTextToolbar(item);
  });

  deleteBtn.addEventListener('click', () => {
    const item = wdsStoryTextItems.find(t => t.id === wdsStoryActiveTextId);
    if (!item) return;
    const el = document.querySelector(`.wds-story-text-item[data-id="${item.id}"]`);
    if (el) el.remove();
    wdsStoryTextItems = wdsStoryTextItems.filter(t => t.id !== item.id);
    wdsDeselectStoryText();
    wdsUpdateStoryHint();
  });
}

// Flattening — the whole point of building the composer this way: rather
// than storing structured layer data (position/rotation/font/etc.) and
// teaching the viewer to re-render it, the finished canvas is rasterized
// once into a plain PNG on Share, using the exact same
// background+photo+text data the on-screen editor just used. The result
// posts through postFeedStory exactly like an ordinary photo story —
// same upload path, same viewer, no schema change.
function wdsLoadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
function wdsFillCanvasBackground(ctx, bg, w, h) {
  if (bg && bg.stops) {
    if (bg.stops.length > 1) {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, bg.stops[0]);
      grad.addColorStop(1, bg.stops[1]);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = bg.stops[0];
    }
  } else {
    ctx.fillStyle = '#101820';
  }
  ctx.fillRect(0, 0, w, h);
}
function wdsRoundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
// Contenteditable line-wrapping (via CSS max-width) isn't reflected in
// item.text — only explicit \n presses are. Re-wrapping here by measured
// width keeps the flattened image from overflowing with long unbroken text.
function wdsWrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  text.split('\n').forEach(paragraph => {
    const words = paragraph.split(' ');
    let cur = '';
    words.forEach(w => {
      const test = cur ? cur + ' ' + w : w;
      if (cur && ctx.measureText(test).width > maxWidth) { lines.push(cur); cur = w; }
      else cur = test;
    });
    lines.push(cur);
  });
  return lines;
}
async function wdsFlattenStoryToDataUrl() {
  const W = 720, H = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (wdsPendingStoryImageDataUrl) {
    const img = await wdsLoadImageEl(wdsPendingStoryImageDataUrl);
    const baseScale = Math.max(W / img.width, H / img.height);
    const scale = baseScale * wdsStoryPhotoTransform.scale;
    const drawW = img.width * scale, drawH = img.height * scale;
    const cx = W / 2 + wdsStoryPhotoTransform.x * W;
    const cy = H / 2 + wdsStoryPhotoTransform.y * H;
    ctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    if (wdsStoryBg && wdsStoryBg.stops) {
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.globalCompositeOperation = 'overlay';
      wdsFillCanvasBackground(ctx, wdsStoryBg, W, H);
      ctx.restore();
    }
  } else {
    wdsFillCanvasBackground(ctx, wdsStoryBg, W, H);
  }

  wdsStoryTextItems.forEach(item => {
    if (!item.text.trim()) return;
    const fontPx = item.fontSizeFrac * H;
    const fontFamily = WDS_STORY_TEXT_FONTS[item.font] || WDS_STORY_TEXT_FONTS.display;
    ctx.font = `700 ${fontPx}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wdsWrapCanvasText(ctx, item.text, W * 0.8);
    const lineHeight = fontPx * 1.25;
    const totalH = lineHeight * lines.length;
    ctx.save();
    ctx.translate(item.x * W, item.y * H);
    ctx.rotate(item.rotation * Math.PI / 180);
    if (item.style === 'pill') {
      const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
      const padX = fontPx * 0.5, padY = fontPx * 0.35;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      wdsRoundRectPath(ctx, -maxW / 2 - padX, -totalH / 2 - padY, maxW + padX * 2, totalH + padY * 2, fontPx * 0.35);
      ctx.fill();
    }
    lines.forEach((line, i) => {
      const ly = -totalH / 2 + lineHeight * (i + 0.5);
      if (item.style === 'outline') {
        ctx.lineWidth = fontPx * 0.08;
        ctx.strokeStyle = item.color === '#000000' ? '#ffffff' : '#000000';
        ctx.strokeText(line, 0, ly);
      }
      ctx.fillStyle = item.color;
      ctx.fillText(line, 0, ly);
    });
    ctx.restore();
  });

  return canvas.toDataURL('image/png');
}
async function refreshWdsMyday() {
  const el = document.getElementById('wdsMydayRow');
  if (!el) return;
  try {
    wdsActiveStories = await fetchActiveStories();
    wdsStoryGroups = wdsGroupStoriesByUser(wdsActiveStories);
    renderWdsMyday();
    wdsProcessStoriesForNotifications(wdsActiveStories);
  } catch (e) {
    el.innerHTML = '<p class="empty-note">Could not load My Day.</p>';
  }
}

function renderWdsMyday() {
  const el = document.getElementById('wdsMydayRow');
  if (!el) return;
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const myName = (wdsRemoteData && wdsRemoteData.profile && wdsRemoteData.profile.name) || (wdsRemoteData && wdsRemoteData.publicId) || '?';
  const myPhoto = wdsRemoteData && wdsRemoteData.profile && wdsRemoteData.profile.photoDataUrl;
  const mineGroup = wdsStoryGroups.find(g => g.shareKey === myShareKey);
  const otherGroups = wdsStoryGroups.filter(g => g.shareKey !== myShareKey);

  const initial = (name) => escapeHtml((name || '?').trim().charAt(0).toUpperCase() || '?');
  // Ring preview always shows that person's newest story's thumbnail —
  // tapping it still starts playback from their OLDEST active one (see
  // wdsOpenStoryViewer), matching Instagram/Facebook's own convention.
  const thumbHtml = (s) => s.image_url
    ? `<img class="wds-myday-thumb-img" src="${escapeHtml(s.image_url)}" alt="">`
    : `<div class="wds-myday-thumb-text">${escapeHtml((s.message || '').slice(0, 60))}</div>`;
  const myAvatarBadge = myPhoto
    ? `<span class="wds-myday-avatar-badge" style="background-image:url(${escapeHtml(myPhoto)});background-size:cover;background-position:center;"></span>`
    : `<span class="wds-myday-avatar-badge">${initial(myName)}</span>`;
  const myCreateAvatar = myPhoto
    ? `<div class="wds-myday-create-avatar" style="background-image:url(${escapeHtml(myPhoto)});background-size:cover;background-position:center;"></div>`
    : `<div class="wds-myday-create-avatar">${initial(myName)}</div>`;

  // "Your Day" is a single tile: your own profile-picture look when you
  // have no active story (tap to create one), or your newest story's
  // preview once you do (tap to view; the "+" badge still lets you add
  // another without leaving the row).
  const mineNewest = mineGroup ? mineGroup.stories[mineGroup.stories.length - 1] : null;
  const youItem = mineNewest
    ? `<div class="wds-myday-item wds-myday-item--has-story" data-action="view-story" data-story-id="${mineGroup.stories[0].id}">${thumbHtml(mineNewest)}${myAvatarBadge}<span class="wds-myday-add-badge" data-action="add-story">+</span><span class="wds-myday-name">Your Day</span></div>`
    : `<div class="wds-myday-item wds-myday-item--create" data-action="add-story">${myCreateAvatar}<span class="wds-myday-add-badge">+</span><span class="wds-myday-name">Your Day</span></div>`;

  const otherItems = otherGroups.map(g => {
    const name = g.codeName || '?';
    const newest = g.stories[g.stories.length - 1];
    return `<div class="wds-myday-item wds-myday-item--has-story" data-action="view-story" data-story-id="${g.stories[0].id}">${thumbHtml(newest)}<span class="wds-myday-avatar-badge">${initial(name)}</span><span class="wds-myday-name">${escapeHtml(name)}</span></div>`;
  }).join('');
  el.innerHTML = youItem + otherItems;
}

// Facebook/Instagram-style story playback: auto-advances every 5s through
// the current person's stories (oldest to newest), then chains into the
// next person's ring, closing the viewer after the last group. Tapping
// the right/left half of the content jumps forward/back immediately.
const WDS_STORY_DURATION_MS = 5000;
let wdsStoryGroupIdx = 0;
let wdsStoryLocalIdx = 0;
let wdsStoryTimer = null;

// Back button / gesture closes whichever My Day overlay (viewer or
// composer) is open and returns to whatever page was underneath, instead
// of navigating the browser away from the dashboard. Same push-on-open,
// pop-on-close, guard-against-double-handling shape as the mobile app's
// own sheet-overlay back-button system (initBackButtonNav), just scoped
// to these two overlays specifically rather than driven by a
// MutationObserver, since their open/close functions are already single
// choke points here.
let wdsStoryHistoryOpen = false;
let wdsStoryClosingViaHistory = false;
function wdsPushStoryHistory() {
  if (wdsStoryHistoryOpen) return;
  wdsStoryHistoryOpen = true;
  history.pushState({ wdsStoryOverlay: true }, '');
}
function wdsPopStoryHistoryIfNeeded() {
  if (!wdsStoryHistoryOpen) return;
  wdsStoryHistoryOpen = false;
  if (wdsStoryClosingViaHistory) { wdsStoryClosingViaHistory = false; return; }
  history.back();
}
window.addEventListener('popstate', () => {
  if (!wdsStoryHistoryOpen) return;
  wdsStoryClosingViaHistory = true;
  const composerOverlay = document.getElementById('wdsStoryComposerOverlay');
  const viewerOverlay = document.getElementById('wdsStoryViewerOverlay');
  if (composerOverlay && !composerOverlay.hidden) wdsCloseStoryComposer();
  else if (viewerOverlay && !viewerOverlay.hidden) wdsCloseStoryViewer();
  else wdsStoryClosingViaHistory = false;
});

function wdsOpenStoryViewer(storyId) {
  for (let g = 0; g < wdsStoryGroups.length; g++) {
    const li = wdsStoryGroups[g].stories.findIndex(s => s.id === storyId);
    if (li !== -1) { wdsStoryGroupIdx = g; wdsStoryLocalIdx = li; break; }
  }
  const overlay = document.getElementById('wdsStoryViewerOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  wdsPushStoryHistory();
  wdsRenderCurrentStory();
}

function wdsRenderCurrentStory() {
  clearTimeout(wdsStoryTimer);
  const content = document.getElementById('wdsStoryViewerContent');
  if (!content) return;
  const group = wdsStoryGroups[wdsStoryGroupIdx];
  const story = group && group.stories[wdsStoryLocalIdx];
  if (!story) { wdsCloseStoryViewer(); return; }

  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const isOwn = !!myShareKey && story.share_key === myShareKey;
  const mediaHtml = story.image_url
    ? `<img class="wds-story-content-image" src="${escapeHtml(story.image_url)}" alt="">`
    : `<div class="wds-story-content-text">${escapeHtml(story.message || '')}</div>`;
  // One progress segment per story in THIS person's set — already-viewed
  // segments filled solid, the current one animates its own fill over
  // the 5s window, upcoming ones stay empty.
  const progressHtml = group.stories.map((s, i) => `
    <div class="wds-story-progress-seg">
      <div class="wds-story-progress-fill${i < wdsStoryLocalIdx ? ' is-complete' : ''}${i === wdsStoryLocalIdx ? ' is-active' : ''}"></div>
    </div>`).join('');
  content.innerHTML = `
    <div class="wds-story-content">
      <div class="wds-story-progress-row">${progressHtml}</div>
      <div class="wds-story-content-head">
        <span class="wds-post-avatar">${escapeHtml((story.code_name || '?').charAt(0).toUpperCase())}</span>
        <div><strong>${escapeHtml(story.code_name || 'Anonymous')}</strong><span>${wdsRelativeTime(story.created_at)}</span></div>
      </div>
      ${mediaHtml}
      ${story.image_url && story.message ? `<p class="wds-post-body" style="padding:10px 14px;color:#fff;">${escapeHtml(story.message)}</p>` : ''}
      ${story.link_preview ? `<div class="wds-story-link-attach">${wdsBuildLinkPreviewHtml(story.link_preview)}</div>` : ''}
      ${isOwn ? `<div class="wds-story-content-actions"><button type="button" class="wds-post-unsend-btn" id="btnWdsUnsendStory" data-story-id="${story.id}">Remove</button></div>` : `
        <div class="wds-story-reply-row">
          <input type="text" class="wds-story-reply-input" placeholder="Send message…" maxlength="280">
          <div class="wds-story-quick-reacts">${QUICK_REACTIONS.map(e => `<button type="button" data-quick-react="${e}">${e}</button>`).join('')}</div>
        </div>`}
      <div class="wds-story-tap-zone wds-story-tap-zone--left" data-story-tap="prev"></div>
      <div class="wds-story-tap-zone wds-story-tap-zone--right" data-story-tap="next"></div>
    </div>`;
  wdsStoryTimer = setTimeout(() => wdsAdvanceStory(1), WDS_STORY_DURATION_MS);
}

function wdsAdvanceStory(delta) {
  const group = wdsStoryGroups[wdsStoryGroupIdx];
  if (!group) { wdsCloseStoryViewer(); return; }
  wdsStoryLocalIdx += delta;
  if (wdsStoryLocalIdx >= group.stories.length) {
    wdsStoryGroupIdx += 1;
    wdsStoryLocalIdx = 0;
    if (wdsStoryGroupIdx >= wdsStoryGroups.length) { wdsCloseStoryViewer(); return; }
  } else if (wdsStoryLocalIdx < 0) {
    if (wdsStoryGroupIdx === 0) { wdsStoryLocalIdx = 0; }
    else {
      wdsStoryGroupIdx -= 1;
      wdsStoryLocalIdx = wdsStoryGroups[wdsStoryGroupIdx].stories.length - 1;
    }
  }
  wdsRenderCurrentStory();
}

function wdsCloseStoryViewer() {
  clearTimeout(wdsStoryTimer);
  const overlay = document.getElementById('wdsStoryViewerOverlay');
  if (overlay) overlay.hidden = true;
  wdsPopStoryHistoryIfNeeded();
}

// Story reply — a typed message or a quick-tap emoji, delivered as a
// normal DM to that story's author (start_dm_by_name/postChatMessage,
// same RPCs the rest of desktop DM already uses), Instagram/Facebook's
// own "reply to a story" convention. Delivered silently in the
// background — sending doesn't open the chat popup or leave the story,
// so it doesn't interrupt watching.
async function wdsSendStoryReply(story, text) {
  if (!wdsRemoteData || !text.trim()) return;
  const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
  try {
    const { data: roomId, error } = await sb.rpc('start_dm_by_name', {
      p_my_key: wdsRemoteData.shareKey, p_my_name: codeName, p_other_name: story.code_name,
    });
    if (error || !roomId) return;
    await postChatMessage(text, null, wdsRemoteData.shareKey, codeName, roomId);
    await refreshWdsChatRooms();
  } catch (e) { /* best effort */ }
}
// Brief "Sent!" flash next to the reply input so a quick-react tap (no
// typed text, nothing else changes on screen) gets some feedback.
function wdsFlashStorySent() {
  const row = document.querySelector('.wds-story-reply-row');
  if (!row) return;
  let note = row.querySelector('.wds-story-reply-sent');
  if (!note) {
    note = document.createElement('span');
    note.className = 'wds-story-reply-sent';
    row.appendChild(note);
  }
  note.textContent = 'Sent!';
  clearTimeout(wdsFlashStorySent._t);
  wdsFlashStorySent._t = setTimeout(() => { note.textContent = ''; }, 1200);
}
function wdsOpenStoryComposer() {
  const overlay = document.getElementById('wdsStoryComposerOverlay');
  const errorEl = document.getElementById('wdsStoryComposerError');
  if (errorEl) errorEl.hidden = true;
  if (overlay) overlay.hidden = false;
  wdsPushStoryHistory();
}
function wdsCloseStoryComposer() {
  const overlay = document.getElementById('wdsStoryComposerOverlay');
  if (overlay) overlay.hidden = true;
  wdsPopStoryHistoryIfNeeded();
}

// ---------------------------------------------------------------------
// Desktop Nexus chat — a real, usable substitute for the mobile Nexus tab
// when someone isn't on the app. Reuses the exact same .chat-row/.chat-bubble
// markup and CSS as mobile chat (style.css "Public chat (Nexus)" section)
// for visual parity, and posts/reacts/unsends as the real signed-in account
// via wdsRemoteData.shareKey (see postChatMessage/setChatReaction/
// unsendChatMessage's override params above). Image *display* is supported
// (mirrors whatever's already on a message); image *upload* from the
// desktop compose box is not implemented in this pass — text only.
// ---------------------------------------------------------------------
let wdsLastChatMessages = [];
async function fetchChatSeenReceipts(roomKey) {
  const { data, error } = await sb.from('chat_read_receipts').select('share_key, code_name, last_read_at').eq('room_key', roomKey);
  if (error) throw error;
  return data || [];
}

let wdsLastMarkReadAt = 0;
// Throttled — called on every chat refresh (every 5s while polling) but
// only actually writes at most once per ~15s, since the receipt only needs
// to be roughly current, not to the second.
async function wdsMaybeMarkChatRead() {
  if (!wdsRemoteData || !wdsRemoteData.shareKey || !sbConfigured()) return;
  const now = Date.now();
  if (now - wdsLastMarkReadAt < 15000) return;
  wdsLastMarkReadAt = now;
  const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
  try { await sb.rpc('mark_chat_read', { p_room_key: 'global', p_share_key: wdsRemoteData.shareKey, p_code_name: codeName }); }
  catch (e) { /* best effort — seen-by row just won't reflect this session until next successful call */ }
}

async function refreshWdsChat() {
  const listEl = document.getElementById('wdsChatList');
  // Every poll fully rebuilds the list's innerHTML, which tears down and
  // restarts any embedded YouTube/Facebook iframe mid-playback — a video
  // would never make it to the end since chat polls every 5s. Skip this
  // cycle entirely while one's showing; polling resumes once it scrolls
  // away or the message list otherwise re-renders for another reason.
  if (listEl && listEl.querySelector('.chat-video-embed iframe')) return;
  try {
    const messages = await fetchChatMessages();
    wdsLastChatMessages = messages;
    const receipts = await fetchChatSeenReceipts('global').catch(() => []);
    renderWdsChatMessages(messages, receipts);
    renderWdsNotifications();
    wdsMaybeMarkChatRead();
  } catch (e) {
    listEl.innerHTML = '<p class="empty-note">Could not load chat.</p>';
  }
}

// ---------------------------------------------------------------------
// Desktop Messenger-style chat — DMs and group chatrooms, layered on top
// of the exact same backend the mobile app's group-chat feature uses
// (see the module-level wdsChat* state declared near wdsRemoteData).
// Global Chat itself is untouched by any of this.
// ---------------------------------------------------------------------

function wdsChatThreadList() {
  return Object.entries(wdsChatRoomMeta)
    .filter(([id, m]) => m.isDm || m.joinedByMe)
    .map(([id, m]) => Object.assign({ id }, m))
    .sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
}
function wdsIsRoomUnread(roomId, meta) {
  if (!meta.lastMessageAt) return false;
  const lastRead = wdsChatLastRead[roomId];
  return !lastRead || new Date(meta.lastMessageAt) > new Date(lastRead);
}

async function refreshWdsChatRooms() {
  if (!wdsRemoteData) return;
  const myShareKey = wdsRemoteData.shareKey;
  try {
    // sb.rpc(...) isn't a plain Promise here — chaining .catch() directly
    // onto it threw synchronously ("catch is not a function") on every
    // single call, aborting this whole function before it ever reached the
    // actual room-fetching queries below. That's why the Chats dropdown
    // showed "No conversations yet" even for accounts with real rooms/
    // messages. A local try/catch (matching refreshChatRooms's own working
    // call to the same RPC, app.js ~15857) fixes it: real failures here
    // stay non-fatal without needing .catch to exist on the return value.
    try { await sb.rpc('cleanup_stale_solo_rooms'); } catch (e) { /* best effort, opportunistic */ }
    const { data: memberRows } = await sb.from('chat_room_members').select('room_id, status').eq('share_key', myShareKey);
    const roomIds = (memberRows || []).map(r => r.room_id);
    if (!roomIds.length) { wdsChatRoomMeta = {}; renderWdsChatListPanel(); return; }

    const { data: rooms } = await sb.from('chat_rooms').select('id, name, is_dm, created_by_key').in('id', roomIds);
    const dmRoomIds = (rooms || []).filter(r => r.is_dm).map(r => r.id);
    const dmMembersByRoom = {};
    if (dmRoomIds.length) {
      const { data: dmMembers } = await sb.from('chat_room_members').select('room_id, share_key, code_name').in('room_id', dmRoomIds);
      (dmMembers || []).forEach(m => { (dmMembersByRoom[m.room_id] = dmMembersByRoom[m.room_id] || []).push(m); });
    }

    // Last message per room, for the thread-list preview text — fetched
    // as one query (newest first) and reduced client-side to the first
    // (i.e. newest) row per room_id, same trick used for My Day/feed data
    // elsewhere in this file.
    const { data: recentMsgs } = await sb.from('chat_messages')
      .select('room_id, message, image_url, deleted, created_at')
      .in('room_id', roomIds)
      .order('created_at', { ascending: false })
      .limit(300);
    const lastMsgByRoom = {};
    (recentMsgs || []).forEach(m => { if (!lastMsgByRoom[m.room_id]) lastMsgByRoom[m.room_id] = m; });

    const meta = {};
    (rooms || []).forEach(r => {
      const memberRow = (memberRows || []).find(mr => mr.room_id === r.id);
      let name = r.name;
      if (r.is_dm) {
        const other = (dmMembersByRoom[r.id] || []).find(m => m.share_key !== myShareKey);
        if (other) name = other.code_name;
      }
      const last = lastMsgByRoom[r.id];
      meta[r.id] = {
        name, isDm: r.is_dm, createdByKey: r.created_by_key,
        joinedByMe: memberRow ? memberRow.status === 'joined' : false,
        lastMessage: last ? (last.deleted ? 'Message unsent' : (last.image_url ? '📷 Photo' : last.message)) : '',
        lastMessageAt: last ? last.created_at : null,
      };
    });
    wdsChatRoomMeta = meta;
  } catch (e) {
    // Was a silent best-effort swallow — the exact pattern that hid the
    // feed-reactions column bug earlier. Logging it so a real failure here
    // (RLS, a bad column, a thrown RPC) is at least visible in the console
    // instead of just quietly leaving the Chats list empty.
    console.error('refreshWdsChatRooms failed:', e);
  }
  renderWdsChatListPanel();
}

function renderWdsChatListPanel() {
  renderWdsChatContactRail();
  const listEl = document.getElementById('wdsChatListItems');
  const badge = document.getElementById('wdsChatListBadge');
  if (!listEl) return;
  let threads = wdsChatThreadList();
  const unreadCount = threads.filter(t => wdsIsRoomUnread(t.id, t)).length;
  if (badge) { badge.textContent = String(unreadCount); badge.hidden = unreadCount === 0; }

  const pending = Object.entries(wdsChatRoomMeta).filter(([id, m]) => !m.isDm && !m.joinedByMe);
  const pendingHtml = pending.length ? `<div class="wds-chat-thread-item" style="cursor:default;">
      <div class="wds-chat-thread-avatar wds-chat-thread-avatar--group">👥</div>
      <div class="wds-chat-thread-body">
        <div class="wds-chat-thread-name">${pending.length} group invite${pending.length === 1 ? '' : 's'}</div>
        <div class="wds-chat-thread-preview">${pending.map(([id, m]) =>
          `<span data-accept-invite="${id}" style="text-decoration:underline;cursor:pointer;margin-right:8px;">${escapeHtml(m.name)}: Accept</span><span data-decline-invite="${id}" style="text-decoration:underline;cursor:pointer;color:var(--critical);">Decline</span>`
        ).join(' · ')}</div>
      </div>
    </div>` : '';

  if (wdsChatListTab === 'unread') threads = threads.filter(t => wdsIsRoomUnread(t.id, t));
  else if (wdsChatListTab === 'groups') threads = threads.filter(t => !t.isDm);
  const q = wdsChatListSearchText.trim().toLowerCase();
  if (q) threads = threads.filter(t => (t.name || '').toLowerCase().includes(q));

  if (!threads.length && !pendingHtml) { listEl.innerHTML = '<p class="empty-note">No conversations yet.</p>'; return; }
  listEl.innerHTML = pendingHtml + threads.map(t => {
    const unread = wdsIsRoomUnread(t.id, t);
    const initial = escapeHtml((t.name || '?').charAt(0).toUpperCase());
    return `<div class="wds-chat-thread-item${unread ? ' is-unread' : ''}" data-room-id="${t.id}">
      <div class="wds-chat-thread-avatar${t.isDm ? '' : ' wds-chat-thread-avatar--group'}">${t.isDm ? initial : '👥'}</div>
      <div class="wds-chat-thread-body">
        <div class="wds-chat-thread-name">${escapeHtml(t.name || 'Unknown')}${unread ? '<span class="wds-chat-thread-dot"></span>' : ''}</div>
        <div class="wds-chat-thread-preview">${escapeHtml(t.lastMessage || 'No messages yet')}</div>
      </div>
      <span class="wds-chat-thread-time">${t.lastMessageAt ? wdsRelativeTime(t.lastMessageAt) : ''}</span>
    </div>`;
  }).join('');
}

async function wdsFetchRoomMessages(roomId) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await sb.from('chat_messages')
    .select('id, code_name, message, image_url, created_at, deleted, sender_share_key')
    .eq('room_id', roomId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data || []).slice().reverse();
}

function wdsRenderChatPopupMessages(roomId, messages) {
  const popup = document.querySelector(`.wds-chat-popup[data-room-id="${roomId}"]`);
  if (!popup) return;
  const listEl = popup.querySelector('.wds-chat-popup-list');
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const meta = wdsChatRoomMeta[roomId] || {};
  if (!messages.length) { listEl.innerHTML = '<p class="empty-note">No messages yet. Say hi!</p>'; return; }
  listEl.innerHTML = messages.map(m => {
    const isOwn = !!myShareKey && String(m.sender_share_key).trim().toLowerCase() === String(myShareKey).trim().toLowerCase();
    const showName = !isOwn && !meta.isDm;
    const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const bodyHtml = m.deleted
      ? `<span class="chat-msg chat-msg-unsent">Unsent a message</span>`
      : `${m.image_url ? `<img class="chat-msg-image" src="${escapeHtml(m.image_url)}" alt="" data-lightbox="${escapeHtml(m.image_url)}">` : ''}<span class="chat-msg">${escapeHtml(m.message)}</span>`;
    return `<div class="chat-row ${isOwn ? 'chat-row--own' : 'chat-row--other'}">
      ${showName ? `<span class="chat-name" data-dm-name="${escapeHtml(m.code_name || 'Anonymous')}" data-dm-key="${escapeHtml(m.sender_share_key || '')}" style="cursor:pointer;">${escapeHtml(m.code_name || 'Anonymous')}</span>` : ''}
      <div class="chat-bubble-line">
        <div class="chat-bubble">${bodyHtml}</div>
        <span class="chat-time">${time}</span>
      </div>
    </div>`;
  }).join('');
  listEl.scrollTop = listEl.scrollHeight;
}

async function wdsRefreshChatPopup(roomId) {
  const popup = document.querySelector(`.wds-chat-popup[data-room-id="${roomId}"]`);
  if (!popup) return;
  try {
    const messages = await wdsFetchRoomMessages(roomId);
    wdsRenderChatPopupMessages(roomId, messages);
  } catch (e) {
    popup.querySelector('.wds-chat-popup-list').innerHTML = '<p class="empty-note">Could not load messages.</p>';
  }
}

// Facebook caps how many chat popups stay expanded at once (2 here) —
// opening a third evicts the least-recently-active one back down to just
// its icon in the contact rail, rather than piling up open windows.
const WDS_MAX_OPEN_CHAT_POPUPS = 2;
let wdsChatPopupLastActive = {}; // roomId -> timestamp (ms)

function wdsEvictOldestChatPopupIfNeeded(exceptRoomId) {
  const open = Array.from(document.querySelectorAll('.wds-chat-popup')).map(el => el.dataset.roomId);
  if (open.length < WDS_MAX_OPEN_CHAT_POPUPS) return;
  const candidates = open.filter(id => id !== exceptRoomId);
  if (!candidates.length) return;
  candidates.sort((a, b) => (wdsChatPopupLastActive[a] || 0) - (wdsChatPopupLastActive[b] || 0));
  wdsCloseChatPopup(candidates[0]);
}

async function wdsOpenChatPopup(roomId) {
  if (!wdsRemoteData || !roomId) return;
  wdsChatPopupLastActive[roomId] = Date.now();
  let popup = document.querySelector(`.wds-chat-popup[data-room-id="${roomId}"]`);
  if (!popup) {
    wdsEvictOldestChatPopupIfNeeded(roomId);
    const meta = wdsChatRoomMeta[roomId] || { name: 'Chat' };
    popup = document.createElement('div');
    popup.className = 'wds-chat-popup';
    popup.dataset.roomId = roomId;
    popup.innerHTML = `
      <div class="wds-chat-popup-head">
        <span class="wds-chat-popup-head-avatar">${escapeHtml((meta.name || '?').trim().charAt(0).toUpperCase())}</span>
        <strong>${escapeHtml(meta.name || 'Chat')}</strong>
        <button type="button" class="wds-chat-popup-close" data-close-popup="${roomId}" aria-label="Close">✕</button>
      </div>
      <div class="wds-chat-popup-list"><p class="empty-note">Loading…</p></div>
      <div class="wds-chat-popup-pending-image" hidden data-popup-pending-image="${roomId}">
        <img alt="" data-popup-pending-image-preview="${roomId}">
        <button type="button" data-popup-remove-image="${roomId}" aria-label="Remove image">✕</button>
      </div>
      <div class="wds-chat-popup-input-row">
        <button type="button" class="wds-chat-popup-attach-btn" data-popup-attach="${roomId}" aria-label="Attach image">📎</button>
        <input type="file" accept="image/*" hidden data-popup-image-input="${roomId}">
        <input type="text" placeholder="Aa" maxlength="280" data-popup-input="${roomId}">
        <button type="button" class="wds-mini-btn" data-popup-send="${roomId}">Send</button>
      </div>`;
    const wrap = document.getElementById('wdsChatPopupsWrap');
    if (wrap) wrap.appendChild(popup);
    if (!wdsOpenChatPopupIds.includes(roomId)) wdsOpenChatPopupIds.push(roomId);
  }
  wdsChatLastRead[roomId] = new Date().toISOString();
  wdsSaveChatLastRead();
  await wdsRefreshChatPopup(roomId);
  renderWdsChatListPanel();
  renderWdsChatContactRail();
}
function wdsCloseChatPopup(roomId) {
  const popup = document.querySelector(`.wds-chat-popup[data-room-id="${roomId}"]`);
  if (popup) popup.remove();
  wdsOpenChatPopupIds = wdsOpenChatPopupIds.filter(id => id !== roomId);
  delete wdsPopupPendingImages[roomId];
  renderWdsChatContactRail();
}

// Right-edge rail — every DM/group thread as a clickable avatar, doubling
// as both "start/open a chat" and "here's the one that got minimized"
// (an evicted popup has no separate collapsed state; its rail icon is
// simply how you bring it back).
function renderWdsChatContactRail() {
  const rail = document.getElementById('wdsChatContactRail');
  if (!rail) return;
  const threads = wdsChatThreadList().slice(0, 12);
  if (!threads.length) { rail.innerHTML = ''; return; }
  const openIds = new Set(Array.from(document.querySelectorAll('.wds-chat-popup')).map(el => el.dataset.roomId));
  rail.innerHTML = threads.map(t => {
    const unread = wdsIsRoomUnread(t.id, t);
    const initial = escapeHtml((t.name || '?').charAt(0).toUpperCase());
    const isOpen = openIds.has(String(t.id));
    return `<div class="wds-chat-contact-avatar${isOpen ? ' is-open' : ''}" data-room-id="${t.id}" title="${escapeHtml(t.name || 'Chat')}">
      ${t.isDm ? initial : '👥'}${unread ? '<span class="wds-chat-thread-dot"></span>' : ''}
    </div>`;
  }).join('');
}

function wdsCloseChatUserMenu() {
  const menu = document.getElementById('wdsChatUserMenu');
  if (menu) menu.hidden = true;
  const groups = document.getElementById('wdsChatUserMenuGroups');
  const main = document.getElementById('wdsChatUserMenuMain');
  if (groups) groups.hidden = true;
  if (main) main.hidden = false;
}
function wdsOpenChatUserMenu(name, x, y, shareKey) {
  wdsChatUserMenuTarget = name;
  wdsChatUserMenuTargetKey = shareKey || null;
  const menu = document.getElementById('wdsChatUserMenu');
  if (!menu) return;
  document.getElementById('wdsChatUserMenuName').textContent = name;
  document.getElementById('wdsChatUserMenuGroups').hidden = true;
  document.getElementById('wdsChatUserMenuMain').hidden = false;
  // Only a synced desktop operator (has a share_key, not just a display
  // name) has a viewable profile — mobile-only senders never do.
  const profileBtn = document.getElementById('btnWdsChatUserProfile');
  if (profileBtn) profileBtn.hidden = !wdsChatUserMenuTargetKey;
  menu.hidden = false;
  const menuWidth = 220;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 12)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 160)) + 'px';
}
async function wdsStartDM(otherName) {
  if (!wdsRemoteData) return;
  const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
  try {
    const { data, error } = await sb.rpc('start_dm_by_name', {
      p_my_key: wdsRemoteData.shareKey, p_my_name: codeName, p_other_name: otherName,
    });
    if (error || !data) { if (error) console.error('start_dm_by_name failed:', error); return; }
    await refreshWdsChatRooms();
    wdsOpenChatPopup(data);
  } catch (e) { console.error('wdsStartDM failed:', e); }
}
function wdsRenderChatUserMenuGroups() {
  const container = document.getElementById('wdsChatUserMenuGroups');
  if (!container) return;
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const myGroups = Object.entries(wdsChatRoomMeta).filter(([id, m]) => !m.isDm && m.createdByKey === myShareKey);
  if (!myGroups.length) { container.innerHTML = '<p class="empty-note">You haven\'t created a group yet.</p>'; return; }
  container.innerHTML = myGroups.map(([id, m]) => `<button type="button" class="chat-room-menu-item" data-invite-room="${id}">${escapeHtml(m.name)}</button>`).join('');
}
async function wdsInviteUserToRoom(name, roomId) {
  if (!wdsRemoteData) return;
  try {
    const { data: lb } = await sb.from('leaderboard').select('public_id').eq('code_name', name).limit(1).maybeSingle();
    if (!lb || !lb.public_id) return;
    await sb.rpc('invite_to_chat_room', { p_room_id: roomId, p_inviter_key: wdsRemoteData.shareKey, p_invitee_ids: [lb.public_id] });
    await refreshWdsChatRooms();
  } catch (e) { /* best effort */ }
}
async function wdsCopyChatUserDigitalId(name) {
  try {
    const { data: lb } = await sb.from('leaderboard').select('public_id').eq('code_name', name).limit(1).maybeSingle();
    if (!lb || !lb.public_id) return;
    await navigator.clipboard.writeText(lb.public_id);
  } catch (e) { /* best effort */ }
}

// Real notification content — replaces the original mock list. Covers
// today's logging status, a low-hydration nudge (afternoon-onward), hitting
// the current mode-progress target, and unread Nexus messages (tracked via
// a last-seen timestamp, cleared whenever the bell is opened or the Nexus
// tab becomes active).
// Notification history — persisted across renders (and page reloads) in
// localStorage instead of the old approach, which recomputed a fresh
// transient list every render and simply lost anything that stopped being
// true (e.g. "Nothing logged yet today" vanished outright the moment you
// logged something). Entries are never deleted; reading them just sinks
// them below the still-unread ones, newest first within each group. Each
// entry has a stable id so re-triggering the same condition (e.g. the same
// day's hydration nudge) updates in place instead of duplicating.
const WDS_NOTIF_HISTORY_KEY = 'wft_web_notif_history';
const WDS_NOTIF_HISTORY_MAX = 150;

function wdsLoadNotifHistory() {
  try { return JSON.parse(localStorage.getItem(WDS_NOTIF_HISTORY_KEY)) || []; } catch (e) { return []; }
}
function wdsSaveNotifHistory(list) {
  localStorage.setItem(WDS_NOTIF_HISTORY_KEY, JSON.stringify(list.slice(0, WDS_NOTIF_HISTORY_MAX)));
}
function wdsPushNotification(id, title, body, actionsHtml) {
  const list = wdsLoadNotifHistory();
  const existing = list.find(n => n.id === id);
  if (existing) {
    if (existing.body === body) return; // nothing actually changed
    existing.body = body;
    existing.actionsHtml = actionsHtml || null;
    existing.createdAt = new Date().toISOString();
    existing.read = false;
  } else {
    list.unshift({ id, title, body, actionsHtml: actionsHtml || null, createdAt: new Date().toISOString(), read: false });
  }
  wdsSaveNotifHistory(list);
}
function wdsMarkAllNotificationsRead() {
  const list = wdsLoadNotifHistory();
  list.forEach(n => { n.read = true; });
  wdsSaveNotifHistory(list);
}

// New posts/comments/stories from OTHER users get pushed into the same
// history. The very first fetch after sign-in only seeds the "seen" sets
// silently — without that guard, every pre-existing post/comment/story
// would look "new" the moment the feed first loads and flood the history.
let wdsNotifFeedBaselineSet = false;
const wdsNotifSeenPostIds = new Set();
const wdsNotifSeenCommentIds = new Set();
let wdsNotifStoryBaselineSet = false;
const wdsNotifSeenStoryIds = new Set();

function wdsProcessFeedForNotifications(posts) {
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const isFirstPass = !wdsNotifFeedBaselineSet;
  (posts || []).forEach(p => {
    const isNewPost = !wdsNotifSeenPostIds.has(p.id);
    wdsNotifSeenPostIds.add(p.id);
    if (!isFirstPass && isNewPost && !p.deleted && p.share_key !== myShareKey) {
      wdsPushNotification(`post:${p.id}`, 'New Post', `${p.code_name || 'Someone'} shared a new post.`);
    }
    (p.comments || []).forEach(c => {
      const isNewComment = !wdsNotifSeenCommentIds.has(c.id);
      wdsNotifSeenCommentIds.add(c.id);
      if (!isFirstPass && isNewComment && !c.deleted && myShareKey && p.share_key === myShareKey && c.share_key !== myShareKey) {
        wdsPushNotification(`comment:${c.id}`, 'New Comment', `${c.code_name || 'Someone'} commented on your post.`);
      }
    });
  });
  wdsNotifFeedBaselineSet = true;
  renderWdsNotifications();
}

function wdsProcessStoriesForNotifications(stories) {
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const isFirstPass = !wdsNotifStoryBaselineSet;
  (stories || []).forEach(s => {
    const isNew = !wdsNotifSeenStoryIds.has(s.id);
    wdsNotifSeenStoryIds.add(s.id);
    if (!isFirstPass && isNew && s.share_key !== myShareKey) {
      wdsPushNotification(`story:${s.id}`, 'New Story', `${s.code_name || 'Someone'} added to My Day.`);
    }
  });
  wdsNotifStoryBaselineSet = true;
  renderWdsNotifications();
}

function renderWdsNotifications() {
  const pop = document.getElementById('wdsNotifPop');
  const badge = document.getElementById('wdsBellBadge');
  if (!pop || !badge) return;
  const today = todayISO();
  const entry = getLogs()[today];

  const hasLoggedToday = !!(entry && (entry.weightKg != null || entry.steps != null || (entry.exercises && entry.exercises.length) || entry.calories != null));
  if (!hasLoggedToday) wdsPushNotification(`today-log:${today}`, 'Today', 'Nothing logged yet today.');

  const waterTarget = effectiveWaterTargetML(today);
  const waterNow = (entry && entry.water) || 0;
  if (waterTarget && new Date().getHours() >= 15 && waterNow / waterTarget < 0.5) {
    wdsPushNotification(`hydration:${today}`, 'Hydration', `Trending low today — ${Math.round((waterNow / waterTarget) * 100)}% of target.`);
  }

  const mp = getModeProgress();
  if (mp.target && mp.completeCount >= mp.target) {
    wdsPushNotification('consistency', 'Consistency', `You've hit your logging target this cycle (${mp.completeCount}/${mp.target}).`);
  }

  const lastSeen = localStorage.getItem('wft_web_nexus_last_seen');
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const unread = wdsLastChatMessages.filter(m =>
    !m.deleted && m.sender_share_key !== myShareKey && (!lastSeen || new Date(m.created_at) > new Date(lastSeen))
  );
  if (unread.length) wdsPushNotification('chat-unread', 'Nexus', `${unread.length} new message${unread.length === 1 ? '' : 's'} in Global Chat.`);

  const history = wdsLoadNotifHistory();
  const unreadCount = history.filter(n => !n.read).length;
  // Plain dot, not a count — the badge just signals "something's new,"
  // cleared the moment the bell dropdown (the only place notifications
  // render now) is opened, via wdsMarkAllNotificationsRead below.
  badge.hidden = unreadCount === 0;

  // Unread first (newest first), then read history sunk below — nothing
  // is ever removed from the list, just demoted once it's been seen.
  const sorted = history.slice().sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  const itemHtml = n => `<div class="wds-notif-item${n.read ? ' is-read' : ''}"><p style="margin:0;"><strong>${escapeHtml(n.title)}</strong> — ${escapeHtml(n.body)}</p>${n.actionsHtml ? `<div class="wds-notif-item-actions">${n.actionsHtml}</div>` : ''}</div>`;
  pop.innerHTML = sorted.length ? sorted.map(itemHtml).join('') : '<p class="wds-notif-item">No notifications.</p>';
}

// Discord/Slack-style link preview — no video hosting of our own, just
// detects a public YouTube/Facebook video URL already in the message text
// and renders the platform's own embed player inline. Desktop chat only
// (not mobile) per the scope discussed — a much lighter lift than actual
// video upload/storage.
function wdsExtractVideoEmbed(text) {
  if (!text) return '';
  const yt = text.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{6,})/);
  if (yt) {
    return `<div class="chat-video-embed"><iframe src="https://www.youtube.com/embed/${yt[1]}" title="YouTube video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  }
  const fb = text.match(/(?:https?:\/\/)?(?:www\.)?facebook\.com\/[^\s]*\/videos\/[^\s]*/);
  if (fb) {
    const url = fb[0].startsWith('http') ? fb[0] : 'https://' + fb[0];
    return `<div class="chat-video-embed"><iframe src="https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false" title="Facebook video" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe></div>`;
  }
  return '';
}

function renderWdsChatMessages(messages, receipts) {
  const list = document.getElementById('wdsChatList');
  list.innerHTML = '';
  if (!messages.length) { list.innerHTML = '<p class="empty-note">No messages yet. Say hi!</p>'; return; }
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  messages.forEach(m => {
    // Ownership by share_key (the real signed-in identity), not code_name —
    // more correct than the mobile render's name-based check for this
    // purpose, since two people could share a display name. Compared
    // case-insensitively/trimmed — a UUID is logically the same value
    // regardless of casing, but a strict === would treat two differently-
    // cased representations of the same key as different senders.
    const isOwn = !!myShareKey && String(m.sender_share_key).trim().toLowerCase() === String(myShareKey).trim().toLowerCase();
    const row = document.createElement('div');
    row.className = 'chat-row ' + (isOwn ? 'chat-row--own' : 'chat-row--other');
    const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const nameHtml = !isOwn ? `<span class="chat-name" data-dm-name="${escapeHtml(m.code_name || 'Anonymous')}" data-dm-key="${escapeHtml(m.sender_share_key || '')}" style="cursor:pointer;">${escapeHtml(m.code_name || 'Anonymous')}</span>` : '';
    const myReaction = (m.reactions || []).find(r => r.share_key === myShareKey);
    const imageHtml = (!m.deleted && m.image_url) ? `<img class="chat-msg-image" src="${m.image_url}" alt="Shared photo" data-lightbox="${m.image_url}">` : '';
    const videoHtml = m.deleted ? '' : wdsExtractVideoEmbed(m.message);
    const bubbleInner = m.deleted
      ? `<span class="chat-msg chat-msg-unsent">Unsent a message</span>`
      : `${imageHtml}<span class="chat-msg">${escapeHtml(m.message)}</span>${videoHtml}`;
    const counts = aggregateReactions(m.reactions);
    const totalReactions = (m.reactions || []).length;
    const reactionsHtml = Object.keys(counts).length
      ? `<div class="chat-reactions"><span class="chat-reaction-pill${myReaction ? ' is-mine' : ''}">${Object.keys(counts).join('')}${totalReactions > 1 ? ' ' + totalReactions : ''}</span></div>`
      : '';
    const bubbleClass = 'chat-bubble' + (imageHtml ? ' chat-bubble--has-image' : videoHtml ? ' chat-bubble--has-video' : '');
    row.innerHTML = `${nameHtml}<div class="chat-bubble-line"><div class="${bubbleClass}" data-msg-id="${m.id}" data-deleted="${m.deleted ? 1 : 0}" data-own="${isOwn ? 1 : 0}" data-my-reaction="${myReaction ? myReaction.emoji : ''}">${bubbleInner}${reactionsHtml}</div><span class="chat-time">${time}</span></div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-lightbox]').forEach(img => img.addEventListener('click', e => {
    e.stopPropagation();
    window.open(img.dataset.lightbox, '_blank', 'noopener');
  }));

  // "Seen by" row — Messenger-group-chat style, only under the most recent
  // non-unsent message, only the people who've read AT OR AFTER it was
  // sent (and excluding its own sender).
  const lastMsg = messages.slice().reverse().find(m => !m.deleted);
  if (lastMsg && receipts && receipts.length) {
    const seenBy = receipts.filter(r =>
      r.share_key !== lastMsg.sender_share_key && new Date(r.last_read_at) >= new Date(lastMsg.created_at)
    );
    if (seenBy.length) {
      const seenRow = document.createElement('div');
      seenRow.className = 'wds-chat-seen-row';
      seenRow.innerHTML = seenBy.slice(0, 8).map(r =>
        `<span class="wds-chat-seen-avatar" title="Seen by ${escapeHtml(r.code_name || '?')}">${escapeHtml((r.code_name || '?').charAt(0).toUpperCase())}</span>`
      ).join('');
      list.appendChild(seenRow);
    }
  }

  list.scrollTop = list.scrollHeight;
}

let wdsChatReactionTargetId = null;

function wdsCloseChatReactionMenu() {
  const menu = document.getElementById('wdsChatReactionMenu');
  if (menu) menu.hidden = true;
  wdsChatReactionTargetId = null;
}

function wdsOpenChatReactionMenu(bubble, x, y) {
  const menu = document.getElementById('wdsChatReactionMenu');
  if (!menu) return;
  const messageId = Number(bubble.dataset.msgId);
  const isOwn = bubble.dataset.own === '1';
  const myReaction = bubble.dataset.myReaction || '';
  wdsChatReactionTargetId = messageId;
  const emojiRow = `<div class="chat-reaction-emoji-row">${QUICK_REACTIONS.map(e =>
    `<button type="button" class="chat-reaction-emoji-btn${myReaction === e ? ' is-active' : ''}" data-emoji="${e}">${e}</button>`
  ).join('')}</div>`;
  const unsendBtn = isOwn ? `<button type="button" class="chat-room-menu-item chat-room-menu-item--danger" id="btnWdsUnsendChat">Unsend</button>` : '';
  menu.innerHTML = emojiRow + unsendBtn;
  menu.hidden = false;
  const menuWidth = 240;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 12)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 140)) + 'px';
}

// Press-and-hold (mousedown, same as mobile's touch long-press) or
// double-click a bubble to react/unsend — event-delegated on the list
// container so it survives every renderWdsChatMessages() re-render.
function wdsBindChatReactions(list) {
  const HOLD_MS = 450;
  let pressTimer = null;
  const start = (bubble, x, y) => {
    if (bubble.dataset.deleted === '1') return;
    pressTimer = setTimeout(() => { pressTimer = null; wdsOpenChatReactionMenu(bubble, x, y); }, HOLD_MS);
  };
  const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  list.addEventListener('mousedown', e => {
    const bubble = e.target.closest('.chat-bubble');
    if (!bubble) return;
    start(bubble, e.clientX, e.clientY);
  });
  list.addEventListener('mouseup', cancel);
  list.addEventListener('mouseleave', cancel);
  list.addEventListener('dblclick', e => {
    const bubble = e.target.closest('.chat-bubble');
    if (!bubble || bubble.dataset.deleted === '1') return;
    wdsOpenChatReactionMenu(bubble, e.clientX, e.clientY);
  });
}

function initWdsChatReactionMenu() {
  const list = document.getElementById('wdsChatList');
  const menu = document.getElementById('wdsChatReactionMenu');
  if (!list || !menu) return;
  wdsBindChatReactions(list);
  menu.addEventListener('click', e => {
    const shareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
    const emojiBtn = e.target.closest('.chat-reaction-emoji-btn');
    if (emojiBtn) {
      const isActive = emojiBtn.classList.contains('is-active');
      const messageId = wdsChatReactionTargetId;
      wdsCloseChatReactionMenu();
      setChatReaction(messageId, isActive ? null : emojiBtn.dataset.emoji, shareKey, refreshWdsChat);
      return;
    }
    if (e.target.id === 'btnWdsUnsendChat') {
      const messageId = wdsChatReactionTargetId;
      wdsCloseChatReactionMenu();
      unsendChatMessage(messageId, shareKey, refreshWdsChat);
    }
  });
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.chat-bubble')) wdsCloseChatReactionMenu();
  });
}

let wdsChatPollId = null;
function startWdsChatPolling() {
  stopWdsChatPolling();
  wdsChatPollId = setInterval(refreshWdsChat, 5000);
}
function stopWdsChatPolling() {
  if (wdsChatPollId) { clearInterval(wdsChatPollId); wdsChatPollId = null; }
}

// ---------------------------------------------------------------------
// Nexus Feed — the center column's Facebook-style feed. Same trust model
// as chat: share_key is the identity anchor, posting/commenting are plain
// inserts (RLS-permissive, no real per-user auth exists anywhere in this
// app), liking/unsending go through RPCs (see supabase_feed_migration.sql).
// Desktop-only, same as chat — no mobile equivalent exists.
// ---------------------------------------------------------------------
async function fetchFeedPosts() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  // get_visible_feed_posts (not a plain table select) applies visibility
  // (public/friends/only_me) server-side against the signed-in viewer —
  // see supabase_friends_and_visibility_migration.sql for why this is an
  // RPC rather than an RLS policy (no real per-request auth to check
  // "who's asking" against).
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const { data, error } = await sb.rpc('get_visible_feed_posts', {
    p_viewer_share_key: myShareKey, p_cutoff: cutoff, p_limit: 30,
  });
  if (error) throw error;
  const posts = data || [];
  const ids = posts.map(p => p.id);
  if (ids.length) {
    const [{ data: likes }, { data: comments }, { data: shares }] = await Promise.all([
      sb.from('feed_post_likes').select('post_id, share_key, emoji, code_name').in('post_id', ids),
      sb.from('feed_post_comments').select('id, post_id, parent_comment_id, share_key, code_name, message, deleted, created_at').in('post_id', ids).order('created_at', { ascending: true }),
      sb.from('feed_posts').select('shared_post_id').in('shared_post_id', ids).eq('deleted', false),
    ]);
    const likesByPost = {}, commentsByPost = {}, shareCountByPost = {};
    (likes || []).forEach(l => { (likesByPost[l.post_id] = likesByPost[l.post_id] || []).push(l); });
    (comments || []).forEach(c => { (commentsByPost[c.post_id] = commentsByPost[c.post_id] || []).push(c); });
    (shares || []).forEach(s => { shareCountByPost[s.shared_post_id] = (shareCountByPost[s.shared_post_id] || 0) + 1; });

    const commentIds = (comments || []).map(c => c.id);
    let commentLikesByComment = {};
    if (commentIds.length) {
      const { data: commentLikes } = await sb.from('feed_comment_likes').select('comment_id, share_key, emoji, code_name').in('comment_id', commentIds);
      (commentLikes || []).forEach(l => { (commentLikesByComment[l.comment_id] = commentLikesByComment[l.comment_id] || []).push(l); });
    }

    posts.forEach(p => {
      p.likes = likesByPost[p.id] || [];
      p.comments = (commentsByPost[p.id] || []).map(c => Object.assign({}, c, { likes: commentLikesByComment[c.id] || [] }));
      p.shareCount = shareCountByPost[p.id] || 0;
    });

    await wdsAttachSharedOriginals(posts);
  }
  return posts;
}

// A shared post (p.shared_post_id set) embeds the original post it points
// to — sharing is restricted to public posts (see share_feed_post), so a
// plain select covers every original a viewer could legally see here.
async function wdsAttachSharedOriginals(posts) {
  const originalIds = Array.from(new Set(posts.filter(p => p.shared_post_id).map(p => p.shared_post_id)));
  if (!originalIds.length) return;
  const { data } = await sb.from('feed_posts')
    .select('id, share_key, code_name, message, image_url, image_urls, visibility, deleted, created_at')
    .in('id', originalIds);
  const byId = {};
  (data || []).forEach(o => { byId[o.id] = o; });
  posts.forEach(p => { if (p.shared_post_id) p.sharedPost = byId[p.shared_post_id] || null; });
}

// imageDataUrl accepts either a single data URL (legacy single-image
// callers — wall posts, stories elsewhere in this file) or an array of
// them (the main/profile composers' multi-photo picker). More than one
// upload goes into the new image_urls array column; exactly one still
// goes into the original image_url column so every existing read path
// (wall posts, link previews, older posts already in the table) keeps
// working unchanged.
async function postFeedPost(text, imageDataUrl, shareKey, codeName, linkPreview, wallOwnerShareKey) {
  const trimmed = text.trim().slice(0, 2000);
  const images = Array.isArray(imageDataUrl) ? imageDataUrl.filter(Boolean) : (imageDataUrl ? [imageDataUrl] : []);
  if (!trimmed && !images.length) return;
  const uploadedUrls = [];
  for (const dataUrl of images) uploadedUrls.push(await uploadChatImage(dataUrl, shareKey));
  const singleImageUrl = uploadedUrls.length === 1 ? uploadedUrls[0] : null;
  const multiImageUrls = uploadedUrls.length > 1 ? uploadedUrls : null;
  // A "wall post" — posted on someone else's profile, not your own — can't
  // be a plain insert: whether it's even allowed depends on that operator's
  // wall_post_permission, which (like feed visibility) only a server-side
  // RPC can check. Posting on your own wall stays a direct insert exactly
  // as before. Wall posts stay single-image only — that composer never
  // offers a multi-photo picker.
  if (wallOwnerShareKey && wallOwnerShareKey !== shareKey) {
    const { error } = await sb.rpc('create_wall_post', {
      p_poster_share_key: shareKey, p_owner_share_key: wallOwnerShareKey, p_code_name: codeName,
      p_message: trimmed, p_image_url: singleImageUrl || (uploadedUrls[0] || null), p_link_preview: linkPreview || null,
    });
    if (error) throw error;
    return;
  }
  const { error } = await sb.from('feed_posts').insert({
    share_key: shareKey, code_name: codeName, message: trimmed,
    image_url: singleImageUrl, image_urls: multiImageUrls, link_preview: linkPreview || null,
  });
  if (error) throw error;
}

// Facebook-style URL unfurling — server-side (see supabase/functions/link-preview),
// since the client can't fetch arbitrary third-party pages itself (CORS).
// A direct image/video file URL comes back as type 'image'/'video' (the
// client just renders the media); anything else comes back as 'website'
// with title/description/image pulled from Open Graph tags.
async function fetchLinkPreview(url) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/link-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ url }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Preview failed');
  return data;
}

function wdsDetectFirstUrl(text) {
  const m = text.match(/https?:\/\/[^\s]+/i);
  return m ? m[0] : null;
}

// Turns any URL inside post text into a real link (opens in a new tab —
// it's always an external destination, never a page within this app).
// Escapes everything else normally; trims common trailing punctuation
// (a period/comma ending the sentence) off the matched URL itself.
function wdsLinkifyText(text) {
  if (!text) return '';
  const urlRe = /https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g;
  let result = '';
  let lastIndex = 0;
  let m;
  while ((m = urlRe.exec(text))) {
    result += escapeHtml(text.slice(lastIndex, m.index));
    const url = m[0];
    result += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    lastIndex = m.index + url.length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

// Facebook-style photo collage for a multi-image post: 2 side by side, 3
// as one big + two stacked, 4+ as a 2x2 grid with a "+N" overlay on the
// last tile once there are more than can be shown. A single image never
// reaches here — renderFeedPosts falls back to the plain wds-post-image
// element for that, unchanged from before multi-image posts existed.
function wdsGalleryHtml(urls) {
  if (!urls || urls.length < 2) return '';
  const shown = urls.slice(0, 4);
  const overflow = urls.length - shown.length;
  const sizeClass = shown.length === 2 ? 'wds-gallery-2' : shown.length === 3 ? 'wds-gallery-3' : 'wds-gallery-4';
  const tiles = shown.map((url, i) => {
    const isOverflowTile = i === shown.length - 1 && overflow > 0;
    return `<div class="wds-gallery-tile">
      <img src="${escapeHtml(url)}" alt="" data-lightbox="${escapeHtml(url)}">
      ${isOverflowTile ? `<span class="wds-gallery-overflow" data-lightbox="${escapeHtml(url)}">+${overflow}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="wds-post-gallery ${sizeClass}">${tiles}</div>`;
}

// A share (p.shared_post_id set) is its own feed_posts row — its own
// message is the sharer's caption, rendered normally by the caller; this
// just builds the quoted card underneath showing who/what was shared.
// wdsAttachSharedOriginals populates p.sharedPost; a null here means the
// original was removed since this share was made.
function wdsSharedPostEmbedHtml(original) {
  if (!original) return '<div class="wds-shared-post-embed wds-shared-post-missing">This post is no longer available.</div>';
  const galleryHtml = (original.image_urls && original.image_urls.length > 1) ? wdsGalleryHtml(original.image_urls) : '';
  const imageHtml = (!galleryHtml && original.image_url)
    ? `<img class="wds-post-image" src="${escapeHtml(original.image_url)}" alt="" data-lightbox="${escapeHtml(original.image_url)}">` : '';
  return `<div class="wds-shared-post-embed">
    <div class="wds-post-head">
      <span class="wds-post-avatar" data-view-profile="${escapeHtml(original.share_key)}">${escapeHtml((original.code_name || '?').charAt(0).toUpperCase())}</span>
      <div class="wds-post-meta"><strong data-view-profile="${escapeHtml(original.share_key)}">${escapeHtml(original.code_name || 'Anonymous')}</strong><span>${wdsRelativeTime(original.created_at)}</span></div>
    </div>
    ${original.message ? `<p class="wds-post-body">${wdsLinkifyText(original.message)}</p>` : ''}
    ${galleryHtml}${imageHtml}
  </div>`;
}

// Shared by the composer's live preview and the rendered post — a website
// preview is a clickable card, an image/video URL is rendered as plain
// media (matches how an uploaded photo already looks), per "full preview
// like photos and videos, unless it's a full page — just preview/title/text".
function wdsBuildLinkPreviewHtml(preview) {
  if (!preview) return '';
  if (preview.type === 'image') return `<img class="wds-post-image" src="${escapeHtml(preview.image || preview.url)}" alt="" data-lightbox="${escapeHtml(preview.image || preview.url)}">`;
  if (preview.type === 'video') return `<video class="wds-post-image" src="${escapeHtml(preview.video || preview.url)}" controls></video>`;
  // "Share to My Day" builds one of these locally from a feed post's own
  // fields (see wdsShareFeedPostToMyDay) with internal:true — there's no
  // real per-post URL in this single-page app to link to, so it renders as
  // a plain card instead of an <a href>.
  const tag = preview.internal ? 'div' : 'a';
  const linkAttrs = preview.internal ? '' : ` href="${escapeHtml(preview.url)}" target="_blank" rel="noopener noreferrer"`;
  return `<${tag} class="wds-link-preview-card"${linkAttrs}>
    ${preview.image ? `<img class="wds-link-preview-img" src="${escapeHtml(preview.image)}" alt="">` : ''}
    <div class="wds-link-preview-body">
      ${preview.siteName ? `<span class="wds-link-preview-site">${escapeHtml(preview.siteName)}</span>` : ''}
      <strong class="wds-link-preview-title">${escapeHtml(preview.title || preview.url)}</strong>
      ${preview.description ? `<p class="wds-link-preview-desc">${escapeHtml(preview.description)}</p>` : ''}
    </div>
  </${tag}>`;
}

async function toggleFeedPostLike(postId, shareKey, emoji, codeName) {
  const { data, error } = await sb.rpc('toggle_feed_post_like', { p_post_id: postId, p_share_key: shareKey, p_emoji: emoji || '👍', p_code_name: codeName || null });
  if (error) throw error;
  return data;
}

async function toggleFeedCommentLike(commentId, shareKey, emoji, codeName) {
  const { data, error } = await sb.rpc('toggle_feed_comment_like', { p_comment_id: commentId, p_share_key: shareKey, p_emoji: emoji || '👍', p_code_name: codeName || null });
  if (error) throw error;
  return data;
}

async function postFeedComment(postId, text, shareKey, codeName, parentCommentId) {
  const trimmed = text.trim().slice(0, 500);
  if (!trimmed) return;
  const { error } = await sb.from('feed_post_comments').insert({
    post_id: postId, share_key: shareKey, code_name: codeName, message: trimmed,
    parent_comment_id: parentCommentId || null,
  });
  if (error) throw error;
}

async function shareFeedPost(shareKey, codeName, originalPostId, message) {
  const { data, error } = await sb.rpc('share_feed_post', {
    p_share_key: shareKey, p_code_name: codeName, p_original_post_id: originalPostId, p_message: message || null,
  });
  if (error) throw error;
  return data;
}

async function unsendFeedPost(postId, shareKey) {
  const { error } = await sb.rpc('unsend_feed_post', { p_post_id: postId, p_share_key: shareKey });
  if (error) throw error;
}

async function editFeedPost(postId, shareKey, message) {
  const { error } = await sb.rpc('edit_feed_post', { p_post_id: postId, p_share_key: shareKey, p_message: (message || '').trim().slice(0, 2000) });
  if (error) throw error;
}

async function unsendFeedComment(commentId, shareKey) {
  const { error } = await sb.rpc('unsend_feed_comment', { p_comment_id: commentId, p_share_key: shareKey });
  if (error) throw error;
}

// Comment sections collapse back to hidden on every re-render (a fresh
// innerHTML rebuild) unless we remember which posts had them open —
// re-applied in renderFeedPosts below.
const wdsFeedExpandedComments = new Set();
// Same idea, one level down — which top-level comments have their reply
// thread expanded.
const wdsFeedExpandedReplies = new Set();

async function refreshWdsFeed(force) {
  const listEl = document.getElementById('wdsFeedList');
  if (!listEl) return;
  // Same reasoning as refreshWdsChat's guard above — a poll-triggered
  // rebuild would restart any playing video embed from scratch, which is
  // exactly why a shared video never finished playing before this fix.
  // But that's only the right tradeoff for a PASSIVE poll — an explicit
  // action (liking, commenting, sharing, posting) needs its own result to
  // actually show up, so every one of those call sites passes force=true
  // to skip this guard. Without this split, the action would silently
  // succeed on the server while the screen never updated to show it,
  // for as long as any video stayed embedded in the feed.
  if (!force && listEl.querySelector('.chat-video-embed iframe')) return;
  try {
    const posts = await fetchFeedPosts();
    renderFeedPosts(posts);
    wdsProcessFeedForNotifications(posts);
  } catch (e) {
    listEl.innerHTML = '<p class="empty-note">Could not load the feed.</p>';
  }
}

// Facebook's reaction set, reused from the chat QUICK_REACTIONS constant
// (app.js ~12961) so both surfaces offer the same six reactions.
const WDS_REACTION_LABEL = { '👍': 'Like', '❤️': 'Love', '😂': 'Haha', '😮': 'Wow', '😢': 'Sad', '🙏': 'Pray' };

// The Like button itself just shows the action ("Like", or my own reaction's
// label if I've already reacted) — the WHO/WHICH-emoji summary is a
// separate line at the bottom-right of the post (wdsReactionSummaryHtml
// below), matching Facebook's actual layout instead of cramming both into
// one button.
function wdsReactionLabel(likes, myShareKey) {
  const mine = (likes || []).find(l => l.share_key === myShareKey);
  return mine ? (WDS_REACTION_LABEL[mine.emoji] || 'Liked') : 'Like';
}
// showLabel defaults to true (comment-like buttons keep their text); the
// post-level actions row passes false — icon (the reaction emoji itself)
// only, label moved to the button's aria-label/title instead.
function wdsReactionButtonHtml(likes, myShareKey, showLabel) {
  const mine = (likes || []).find(l => l.share_key === myShareKey);
  const emoji = mine ? mine.emoji : '👍';
  if (showLabel === false) return emoji;
  return `${emoji} ${wdsReactionLabel(likes, myShareKey)}`;
}

// Bottom-right summary: the top distinct reaction emoji + total count —
// empty (renders nothing) until at least one person has reacted.
// Clickable — tapping the cluster/count opens wdsShowReactors, a small
// overlay listing each reactor's emoji + name (Facebook's own "hover the
// reaction count to see who" convention, tap instead of hover here).
function wdsReactionSummaryHtml(likes, type, id) {
  const total = (likes || []).length;
  if (!total) return '';
  const counts = aggregateReactions(likes);
  const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 3).join('');
  return `<div class="wds-reaction-summary" data-action="view-reactors" data-reactor-type="${type}" data-reactor-id="${id}">${top ? `<span class="wds-reaction-cluster">${top}</span>` : ''}<span>${total}</span></div>`;
}

let wdsReactorsData = [];
let wdsReactorsFilter = 'all';
function wdsRenderReactorTabs() {
  const tabsEl = document.getElementById('wdsReactorTabs');
  if (!tabsEl) return;
  const counts = aggregateReactions(wdsReactorsData);
  const emojis = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (emojis.length <= 1) { tabsEl.innerHTML = ''; return; }
  const allTab = `<button type="button" class="wds-reactor-tab${wdsReactorsFilter === 'all' ? ' is-active' : ''}" data-reactor-filter="all">All ${wdsReactorsData.length}</button>`;
  const emojiTabs = emojis.map(e => `<button type="button" class="wds-reactor-tab${wdsReactorsFilter === e ? ' is-active' : ''}" data-reactor-filter="${escapeHtml(e)}">${escapeHtml(e)} ${counts[e]}</button>`).join('');
  tabsEl.innerHTML = allTab + emojiTabs;
}
function wdsRenderReactorsList() {
  const listEl = document.getElementById('wdsReactorsList');
  if (!listEl) return;
  const rows = wdsReactorsFilter === 'all' ? wdsReactorsData : wdsReactorsData.filter(r => r.emoji === wdsReactorsFilter);
  if (!rows.length) { listEl.innerHTML = '<p class="empty-note">No reactions yet.</p>'; return; }
  listEl.innerHTML = rows.map(r => `
    <div class="wds-reactor-item">
      <span class="wds-reactor-emoji">${escapeHtml(r.emoji || '👍')}</span>
      <span class="wds-reactor-name" data-view-profile="${escapeHtml(r.share_key)}">${escapeHtml(r.code_name || 'Anonymous')}</span>
    </div>`).join('');
}
async function wdsShowReactors(type, id) {
  const overlay = document.getElementById('wdsReactorsOverlay');
  const listEl = document.getElementById('wdsReactorsList');
  if (!overlay || !listEl) return;
  overlay.hidden = false;
  wdsReactorsFilter = 'all';
  wdsReactorsData = [];
  document.getElementById('wdsReactorTabs').innerHTML = '';
  listEl.innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    const table = type === 'comment' ? 'feed_comment_likes' : 'feed_post_likes';
    const column = type === 'comment' ? 'comment_id' : 'post_id';
    const { data, error } = await sb.from(table).select(`emoji, code_name, share_key`).eq(column, id);
    if (error) throw error;
    wdsReactorsData = data || [];
    wdsRenderReactorTabs();
    wdsRenderReactorsList();
  } catch (e) {
    listEl.innerHTML = '<p class="empty-note">Could not load reactions.</p>';
  }
}
function wdsCloseReactorsOverlay() {
  const overlay = document.getElementById('wdsReactorsOverlay');
  if (overlay) overlay.hidden = true;
}

// Sharing — reposts to the sharer's own feed (share_feed_post), with an
// optional caption. wdsSharingPostId tracks which post the currently-open
// compose overlay targets — set on open, read on submit.
let wdsSharingPostId = null;
function wdsOpenShareCompose(postId, previewHtml) {
  wdsSharingPostId = postId;
  const overlay = document.getElementById('wdsShareComposeOverlay');
  const input = document.getElementById('wdsShareComposeInput');
  const preview = document.getElementById('wdsShareComposePreview');
  const errorEl = document.getElementById('wdsShareComposeError');
  if (!overlay) return;
  if (input) input.value = '';
  if (preview) preview.innerHTML = previewHtml || '';
  if (errorEl) errorEl.hidden = true;
  overlay.hidden = false;
}
function wdsCloseShareComposeOverlay() {
  const overlay = document.getElementById('wdsShareComposeOverlay');
  if (overlay) overlay.hidden = true;
  wdsSharingPostId = null;
}

async function wdsShowSharers(postId) {
  const overlay = document.getElementById('wdsSharersOverlay');
  const listEl = document.getElementById('wdsSharersList');
  if (!overlay || !listEl) return;
  overlay.hidden = false;
  listEl.innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    const { data, error } = await sb.from('feed_posts')
      .select('id, share_key, code_name, message, created_at')
      .eq('shared_post_id', postId).eq('deleted', false)
      .order('created_at', { ascending: false });
    if (error) throw error;
    if (!data || !data.length) { listEl.innerHTML = '<p class="empty-note">No one has shared this yet.</p>'; return; }
    listEl.innerHTML = data.map(s => `
      <div class="wds-reactor-item">
        <span class="wds-post-avatar" data-view-profile="${escapeHtml(s.share_key)}" style="width:32px;height:32px;font-size:0.8rem;">${escapeHtml((s.code_name || '?').charAt(0).toUpperCase())}</span>
        <div style="flex:1;min-width:0;">
          <span class="wds-reactor-name" data-view-profile="${escapeHtml(s.share_key)}">${escapeHtml(s.code_name || 'Anonymous')}</span>
          ${s.message ? `<p class="wds-post-body" style="margin:2px 0 0;">${escapeHtml(s.message)}</p>` : ''}
        </div>
      </div>`).join('');
  } catch (e) {
    listEl.innerHTML = '<p class="empty-note">Could not load shares.</p>';
  }
}
function wdsCloseSharersOverlay() {
  const overlay = document.getElementById('wdsSharersOverlay');
  if (overlay) overlay.hidden = true;
}

// A single comment row — shared by top-level comments and their replies.
// Replies skip the Reply action (this app nests one level deep, same as
// most real platforms: replying to a reply just adds another flat reply
// under the same parent instead of an ever-deepening thread).
function wdsCommentHtml(c, myShareKey, isReply) {
  const canRemove = !!myShareKey && c.share_key === myShareKey;
  const cMyLike = (c.likes || []).find(l => l.share_key === myShareKey);
  return `<div class="wds-post-comment${isReply ? ' wds-post-comment--reply' : ''}" data-comment-id="${c.id}">
    <span class="wds-post-comment-avatar" data-view-profile="${escapeHtml(c.share_key)}">${escapeHtml((c.code_name || '?').charAt(0).toUpperCase())}</span>
    <div class="wds-post-comment-body">
      <div class="wds-post-comment-bubble"><strong data-view-profile="${escapeHtml(c.share_key)}">${escapeHtml(c.code_name || 'Anonymous')}</strong><span>${escapeHtml(c.message)}</span></div>
      <div class="wds-post-comment-actions">
        <button type="button" class="wds-comment-action-btn${cMyLike ? ' is-liked' : ''}" data-action="like-comment" data-current-emoji="${cMyLike ? cMyLike.emoji : ''}">${wdsReactionButtonHtml(c.likes, myShareKey)}</button>
        ${wdsReactionSummaryHtml(c.likes, 'comment', c.id)}
        <span>${wdsRelativeTime(c.created_at)}</span>
        ${!isReply ? `<button type="button" class="wds-comment-action-btn" data-action="reply-comment" data-comment-id="${c.id}">Reply</button>` : ''}
        ${canRemove ? `<button type="button" class="wds-comment-action-btn" data-action="unsend-comment">Remove</button>` : ''}
      </div>
    </div>
  </div>`;
}

// Removed posts never reach here at all — fetchFeedPosts() filters
// deleted=false at the query level, same as chat where an unsent message
// (unlike a removed post) intentionally leaves a "message was unsent"
// tombstone behind. A feed post just disappears outright.
function renderFeedPosts(posts) {
  const list = document.getElementById('wdsFeedList');
  if (!posts.length) { list.innerHTML = '<p class="empty-note">No posts yet. Be the first to share something!</p>'; return; }
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  list.innerHTML = posts.map(p => {
    const isOwn = !!myShareKey && p.share_key === myShareKey;
    const isShare = !!p.shared_post_id;
    const canShare = !isShare ? (p.visibility === 'public' || !p.visibility) : (p.sharedPost && (p.sharedPost.visibility === 'public' || !p.sharedPost.visibility));
    const myLike = (p.likes || []).find(l => l.share_key === myShareKey);
    const allComments = (p.comments || []).filter(c => !c.deleted);
    const topComments = allComments.filter(c => !c.parent_comment_id);
    const repliesByParent = {};
    allComments.filter(c => c.parent_comment_id).forEach(c => { (repliesByParent[c.parent_comment_id] = repliesByParent[c.parent_comment_id] || []).push(c); });
    const galleryHtml = (!isShare && p.image_urls && p.image_urls.length > 1) ? wdsGalleryHtml(p.image_urls) : '';
    const imageHtml = (!isShare && !galleryHtml && p.image_url) ? `<img class="wds-post-image" src="${escapeHtml(p.image_url)}" alt="" data-lightbox="${escapeHtml(p.image_url)}">` : '';
    const videoHtml = isShare ? '' : wdsExtractVideoEmbed(p.message);
    const linkPreviewHtml = (isShare || videoHtml) ? '' : wdsBuildLinkPreviewHtml(p.link_preview);
    const sharedEmbedHtml = isShare ? wdsSharedPostEmbedHtml(p.sharedPost) : '';
    const bodyHtml = `${p.message ? `<p class="wds-post-body">${wdsLinkifyText(p.message)}</p>` : ''}${galleryHtml}${imageHtml}${videoHtml}${linkPreviewHtml}${sharedEmbedHtml}`;
    const expanded = wdsFeedExpandedComments.has(p.id);
    const commentsHtml = topComments.map(c => {
      const replies = repliesByParent[c.id] || [];
      const repliesExpanded = wdsFeedExpandedReplies.has(c.id);
      return `${wdsCommentHtml(c, myShareKey, false)}
        ${replies.length ? `
          <button type="button" class="wds-comment-view-replies" data-action="toggle-replies" data-comment-id="${c.id}">${repliesExpanded ? 'Hide replies' : `View ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}`}</button>
          <div class="wds-post-comment-replies" ${repliesExpanded ? '' : 'hidden'}>
            ${replies.map(r => wdsCommentHtml(r, myShareKey, true)).join('')}
          </div>` : ''}
        <div class="wds-post-reply-compose" data-parent-comment-id="${c.id}" hidden>
          <input type="text" placeholder="Write a reply…" maxlength="500">
          <button type="button" data-action="send-reply" data-parent-comment-id="${c.id}">➤</button>
        </div>`;
    }).join('');
    return `
      <div class="wds-card wds-feed-post" data-post-id="${p.id}">
        <div class="wds-post-head">
          <span class="wds-post-avatar" data-view-profile="${escapeHtml(p.share_key)}">${escapeHtml((p.code_name || '?').charAt(0).toUpperCase())}</span>
          <div class="wds-post-meta"><strong data-view-profile="${escapeHtml(p.share_key)}">${escapeHtml(p.code_name || 'Anonymous')}</strong><span>${isShare ? 'shared a post • ' : ''}${wdsRelativeTime(p.created_at)}</span></div>
          <button type="button" class="wds-post-menu-btn" data-action="post-menu" data-post-id="${p.id}" data-share-id="${isShare ? p.shared_post_id : p.id}" data-is-own="${isOwn ? '1' : '0'}" aria-label="Post options"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
        </div>
        ${bodyHtml}
        <div class="wds-post-stats-row">
          ${wdsReactionSummaryHtml(p.likes, 'post', p.id)}
          <span class="wds-post-stats-right">
            ${topComments.length ? `<span class="wds-post-comment-count" data-action="toggle-comments">${allComments.length} comment${allComments.length === 1 ? '' : 's'}</span>` : ''}
            ${p.shareCount ? `<span class="wds-post-share-count" data-action="view-sharers" data-post-id="${p.id}">${p.shareCount} share${p.shareCount === 1 ? '' : 's'}</span>` : ''}
          </span>
        </div>
        <div class="wds-post-actions">
          <button type="button" class="wds-post-action-btn${myLike ? ' is-liked' : ''}" data-action="like" data-current-emoji="${myLike ? myLike.emoji : ''}" aria-label="${wdsReactionLabel(p.likes, myShareKey)}" title="${wdsReactionLabel(p.likes, myShareKey)}">${wdsReactionButtonHtml(p.likes, myShareKey, false)}</button>
          <button type="button" class="wds-post-action-btn" data-action="toggle-comments" aria-label="Comments" title="Comments"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></button>
          ${canShare ? `<button type="button" class="wds-post-action-btn" data-action="open-share" data-post-id="${isShare ? p.shared_post_id : p.id}" aria-label="Share" title="Share"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>` : ''}
        </div>
        <div class="wds-post-comments" ${expanded ? '' : 'hidden'}>
          ${commentsHtml}
          <div class="wds-post-comment-compose">
            <input type="text" placeholder="Write a comment…" maxlength="500">
            <button type="button" data-action="send-comment">➤</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

// Profile Page — a dedicated fetch (not the capped 30-most-recent-global
// fetchFeedPosts()) so an active user's own older posts aren't crowded out
// by everyone else's newer ones. Comments are counted, not fetched in full,
// since the profile view only needs a count, not the composer/reaction
// plumbing the main feed has.
async function fetchFeedPostsByUser(shareKey) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  // get_visible_feed_posts (not a plain table select) applies visibility
  // (public/friends/only_me) server-side against the signed-in viewer, and
  // its p_author_share_key filter matches both this operator's own posts
  // AND wall posts other people left on their profile — see
  // supabase_profile_view_and_wall_migration.sql. A raw table select here
  // would leak friends-only/only-me posts to anyone who knows the share_key.
  const myShareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
  const { data, error } = await sb.rpc('get_visible_feed_posts', {
    p_viewer_share_key: myShareKey, p_cutoff: cutoff, p_limit: 30, p_author_share_key: shareKey,
  });
  if (error) throw error;
  const posts = data || [];
  const ids = posts.map(p => p.id);
  if (ids.length) {
    const [{ data: likes }, { data: comments }] = await Promise.all([
      sb.from('feed_post_likes').select('post_id, share_key, emoji, code_name').in('post_id', ids),
      sb.from('feed_post_comments').select('id, post_id').eq('deleted', false).in('post_id', ids),
    ]);
    const likesByPost = {}, commentCountByPost = {};
    (likes || []).forEach(l => { (likesByPost[l.post_id] = likesByPost[l.post_id] || []).push(l); });
    (comments || []).forEach(c => { commentCountByPost[c.post_id] = (commentCountByPost[c.post_id] || 0) + 1; });
    posts.forEach(p => { p.likes = likesByPost[p.id] || []; p.commentCount = commentCountByPost[p.id] || 0; });
    await wdsAttachSharedOriginals(posts);
  }
  return posts;
}

// List view shows full cards (same building blocks as the main feed, minus
// the interactive like/comment controls this read-mostly view doesn't
// need); Grid view shows plain thumbnail tiles, Facebook's "Photos" tab
// convention. Manage mode reveals a Remove button per card/tile — off by
// default since these are always the signed-in user's own posts and a
// stray tap shouldn't delete one.
let wdsProfilePostsCache = [];
let wdsProfilePostsView = 'list';
let wdsProfilePostsSort = 'newest';
let wdsProfileManageMode = false;
// null = the Profile Page currently shows the signed-in operator's own
// profile; otherwise {shareKey, publicId, codeName, avatarDataUrl} for
// whichever other operator's name/avatar was clicked.
let wdsViewedProfile = null;
let wdsOwnWallPermission = 'friends';

function renderWdsProfilePosts() {
  const list = document.getElementById('wdsProfilePostsList');
  if (!list) return;
  const posts = wdsProfilePostsSort === 'oldest' ? wdsProfilePostsCache.slice().reverse() : wdsProfilePostsCache;
  if (!posts.length) { list.className = 'wds-feed-list'; list.innerHTML = '<p class="empty-note">No posts yet.</p>'; return; }

  if (wdsProfilePostsView === 'grid') {
    list.className = 'wds-profile-posts-grid';
    list.innerHTML = posts.map(p => {
      const firstImage = (p.image_urls && p.image_urls[0]) || p.image_url || (p.sharedPost && (p.image_urls ? null : p.sharedPost.image_url));
      const thumb = firstImage
        ? `<img src="${escapeHtml(firstImage)}" alt="">`
        : `<div class="wds-profile-grid-text">${escapeHtml((p.message || (p.sharedPost && p.sharedPost.message) || '').slice(0, 80))}</div>`;
      return `<div class="wds-profile-grid-tile" data-post-id="${p.id}">
        ${thumb}
        ${wdsProfileManageMode ? `<button type="button" class="wds-post-unsend-btn" data-action="remove-post" data-post-id="${p.id}" style="position:absolute;top:6px;right:6px;">Remove</button>` : ''}
      </div>`;
    }).join('');
    return;
  }

  list.className = 'wds-feed-list';
  list.innerHTML = posts.map(p => {
    const isShare = !!p.shared_post_id;
    const galleryHtml = (!isShare && p.image_urls && p.image_urls.length > 1) ? wdsGalleryHtml(p.image_urls) : '';
    const imageHtml = (!isShare && !galleryHtml && p.image_url) ? `<img class="wds-post-image" src="${escapeHtml(p.image_url)}" alt="" data-lightbox="${escapeHtml(p.image_url)}">` : '';
    const videoHtml = isShare ? '' : wdsExtractVideoEmbed(p.message);
    const linkPreviewHtml = (isShare || videoHtml) ? '' : wdsBuildLinkPreviewHtml(p.link_preview);
    const sharedEmbedHtml = isShare ? wdsSharedPostEmbedHtml(p.sharedPost) : '';
    return `
      <div class="wds-card wds-feed-post" data-post-id="${p.id}">
        <div class="wds-post-head">
          <span class="wds-post-avatar" data-view-profile="${escapeHtml(p.share_key)}">${escapeHtml((p.code_name || '?').charAt(0).toUpperCase())}</span>
          <div class="wds-post-meta"><strong data-view-profile="${escapeHtml(p.share_key)}">${escapeHtml(p.code_name || 'Anonymous')}</strong><span>${isShare ? 'shared a post • ' : ''}${wdsRelativeTime(p.created_at)}</span></div>
          ${wdsProfileManageMode ? `
            <select class="wds-post-visibility-select" data-action="set-visibility" data-post-id="${p.id}">
              <option value="public"${p.visibility === 'public' || !p.visibility ? ' selected' : ''}>🌐 Public</option>
              <option value="friends"${p.visibility === 'friends' ? ' selected' : ''}>👥 Friends</option>
              <option value="only_me"${p.visibility === 'only_me' ? ' selected' : ''}>🔒 Only Me</option>
            </select>
            <button type="button" class="wds-post-unsend-btn" data-action="remove-post" data-post-id="${p.id}">Remove</button>` : ''}
        </div>
        ${p.message ? `<p class="wds-post-body">${wdsLinkifyText(p.message)}</p>` : ''}
        ${galleryHtml}${imageHtml}${videoHtml}${linkPreviewHtml}${sharedEmbedHtml}
        <div class="wds-post-stats-row">
          ${wdsReactionSummaryHtml(p.likes, 'post', p.id)}
          ${p.commentCount ? `<span class="wds-post-comment-count">${p.commentCount} comment${p.commentCount === 1 ? '' : 's'}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

function renderWdsProfileHeader() {
  const isOwn = !wdsViewedProfile;
  const profile = isOwn ? (wdsRemoteData.profile || {}) : {};
  const displayName = isOwn ? (profile.name || wdsRemoteData.publicId) : (wdsViewedProfile.codeName || wdsViewedProfile.publicId);
  const publicId = isOwn ? wdsRemoteData.publicId : wdsViewedProfile.publicId;
  const photoDataUrl = isOwn ? profile.photoDataUrl : wdsViewedProfile.avatarDataUrl;
  document.getElementById('wdsProfilePageName').textContent = displayName;
  wdsSetAvatarVisual(document.getElementById('wdsProfilePageAvatar'), photoDataUrl, displayName.trim().charAt(0).toUpperCase());
  const coverEl = document.getElementById('wdsProfileCover');
  if (coverEl) {
    coverEl.style.backgroundImage = (isOwn && profile.coverPhotoDataUrl) ? `url(${profile.coverPhotoDataUrl})` : '';
    coverEl.style.backgroundPosition = `center ${(isOwn && profile.coverPhotoPosY != null) ? profile.coverPhotoPosY : 50}%`;
  }
  // The composer avatar always shows the SIGNED-IN operator, since they're
  // the one who'd be posting — whether that's on their own wall or (when
  // wdsViewedProfile is set) someone else's.
  const myName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
  wdsSetAvatarVisual(document.getElementById('wdsProfileComposerAvatar'), wdsRemoteData.profile && wdsRemoteData.profile.photoDataUrl, myName.trim().charAt(0).toUpperCase());
  const composerInputEl = document.getElementById('wdsProfileComposerInput');
  if (composerInputEl) composerInputEl.placeholder = isOwn ? "What's on your mind?" : `Write something on ${displayName.split(' ')[0]}'s timeline…`;

  const coverEditBtn = document.getElementById('btnWdsProfileCoverEdit');
  if (coverEditBtn) coverEditBtn.hidden = !isOwn;
  const viewedActionsEl = document.getElementById('wdsProfileViewedActions');
  if (viewedActionsEl) viewedActionsEl.hidden = isOwn;
  const ownActionsEl = document.getElementById('wdsProfileOwnActions');
  if (ownActionsEl) ownActionsEl.hidden = !isOwn;
  const wallPermissionLabel = document.getElementById('wdsWallPermissionLabel');
  if (wallPermissionLabel) wallPermissionLabel.hidden = !isOwn;
  const manageBtn = document.getElementById('btnWdsProfileManage');
  if (manageBtn) manageBtn.hidden = !isOwn;
  const bioMarkersCard = document.getElementById('wdsProfileBodyFatText');
  const bioMarkersCardEl = bioMarkersCard ? bioMarkersCard.closest('.wds-card') : null;
  if (bioMarkersCardEl) bioMarkersCardEl.hidden = !isOwn;

  if (isOwn) {
    const mode = getFitnessMode();
    document.getElementById('wdsProfilePageSubtitle').textContent = `${MODE_LABEL[mode] || mode} • Digital ID ${publicId}`;
    const memberSince = profile.startDate ? new Date(profile.startDate).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '—';
    document.getElementById('wdsProfileDetailList').innerHTML = `
      <li><span>Digital ID</span><strong>${escapeHtml(publicId)}</strong></li>
      <li><span>Gender</span><strong>${profile.gender === 'female' ? 'Female' : 'Male'}</strong></li>
      <li><span>Age</span><strong>${profile.age || '—'}</strong></li>
      <li><span>Fitness Mode</span><strong>${escapeHtml(MODE_LABEL[mode] || mode)}</strong></li>
      <li><span>Member Since</span><strong>${escapeHtml(memberSince)}</strong></li>
    `;

    // Same calc as the dashboard's own Bio-Markers card (renderWdsBio).
    const today = todayISO();
    const bodyFatEntry = findLastBodyFatEntry(today);
    const bodyFatPct = bodyFatEntry ? computeBodyFatJP7(bodyFatEntry.skinfolds, profile.age, profile.gender) : null;
    document.getElementById('wdsProfileBodyFatText').textContent = bodyFatPct != null ? bodyFatPct.toFixed(1) + '%' : '–';
    document.getElementById('wdsProfileBodyFatBar').style.width = bodyFatPct != null ? Math.min(100, bodyFatPct * 2) + '%' : '0%';

    const stats = computeLeaderboardStats();
    document.getElementById('wdsProfileWeightText').textContent = stats.progress != null ? `${stats.progress > 0 ? '+' : ''}${stats.progress}${stats.weightUnit}` : '–';
    document.getElementById('wdsProfileWeightBar').style.width = stats.progressPct != null ? Math.min(100, Math.abs(stats.progressPct) * 5) + '%' : '0%';

    const wallSelect = document.getElementById('wdsWallPermissionSelect');
    if (wallSelect) wallSelect.value = wdsOwnWallPermission || 'friends';
  } else {
    // Private/self-only data (age, gender, body fat, weight progress) has
    // no server-side source for anyone but the signed-in operator — see
    // get_public_profile_by_share_key, which deliberately only returns
    // name/avatar/Digital ID. Personal Details is trimmed to just that.
    document.getElementById('wdsProfilePageSubtitle').textContent = `Digital ID ${publicId}`;
    document.getElementById('wdsProfileDetailList').innerHTML = `<li><span>Digital ID</span><strong>${escapeHtml(publicId)}</strong></li>`;
  }
}

// Same gauge/chart visuals as the dashboard's own Status tab — reuses
// getModeProgress()/computeTrendSeries() unchanged, just writes into the
// Profile Page's own wdsProfile*-prefixed element ids so it doesn't
// collide with the dashboard's copies. Own data only, so this is skipped
// entirely (cards hidden) when viewing another operator's profile.
function renderWdsProfileVisuals() {
  const gaugeCard = document.getElementById('wdsProfileConsistencyCard');
  const chartCard = document.getElementById('wdsProfileWeightTrendCard');
  if (!gaugeCard || !chartCard) return;
  const isOwn = !wdsViewedProfile;
  gaugeCard.hidden = !isOwn;
  chartCard.hidden = !isOwn;
  if (!isOwn) return;

  const mp = getModeProgress();
  const pct = mp.target ? Math.round((mp.completeCount / mp.target) * 100) : 0;
  document.getElementById('wdsProfileConsistencyGauge').style.setProperty('--pct', Math.min(100, pct));
  document.getElementById('wdsProfileConsistencyValue').innerHTML = pct + '<small>%</small>';
  const foot = document.getElementById('wdsProfileConsistencyFoot');
  foot.textContent = `${mp.completeCount} of ${mp.target} days logged this cycle`;
  foot.className = 'wds-card-foot ' + (pct >= 70 ? 'wds-foot-good' : pct >= 40 ? 'wds-foot-warning' : '');

  const series = computeTrendSeries(sortedLogsArray()).slice(-90);
  wdsSetChartPaths('wdsProfileWeightChartArea', 'wdsProfileWeightChartLine', 'wdsProfileWeightChartDot', 'wdsProfileWeightChartEmpty', series.map(s => s.trendKg));
}

async function refreshWdsProfilePosts() {
  const listEl = document.getElementById('wdsProfilePostsList');
  if (!listEl || !wdsRemoteData) return;
  listEl.innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    const shareKey = wdsViewedProfile ? wdsViewedProfile.shareKey : wdsRemoteData.shareKey;
    wdsProfilePostsCache = await fetchFeedPostsByUser(shareKey);
    renderWdsProfilePosts();
  } catch (e) {
    listEl.innerHTML = '<p class="empty-note">Could not load posts.</p>';
  }
}

// ---------------------------------------------------------------------
// Friends — request/accept/decline by Digital ID, reusing leaderboard's
// public_id lookup + the new avatar_data_url column for the "profile
// photo" the user asked the friends list to show.
// ---------------------------------------------------------------------
async function refreshWdsFriendsList(targetShareKey) {
  const listEl = document.getElementById('wdsProfileFriendsList');
  if (!listEl || !wdsRemoteData) return;
  const shareKey = targetShareKey || wdsRemoteData.shareKey;
  try {
    const { data, error } = await sb.rpc('list_friends', { p_share_key: shareKey });
    if (error) throw error;
    if (!data || !data.length) { listEl.innerHTML = '<p class="empty-note">No friends yet.</p>'; return; }
    listEl.innerHTML = data.map(f => `
      <div class="wds-friend-item" data-view-profile="${escapeHtml(f.share_key)}">
        <span class="wds-friend-avatar"${f.avatar_data_url ? ` style="background-image:url(${escapeHtml(f.avatar_data_url)});"` : ''}>${f.avatar_data_url ? '' : escapeHtml((f.code_name || '?').charAt(0).toUpperCase())}</span>
        <span class="wds-friend-name">${escapeHtml(f.code_name || 'Unknown')}</span>
      </div>`).join('');
  } catch (e) {
    listEl.innerHTML = '<p class="empty-note">Could not load friends.</p>';
  }
}

// New pending requests get pushed into the same notification history as
// posts/comments/stories — first pass just seeds the "seen" set silently,
// same baseline-then-diff pattern used there, so existing requests don't
// flood the history the moment the dashboard first loads.
let wdsNotifFriendReqBaselineSet = false;
const wdsNotifSeenFriendReqIds = new Set();

async function refreshWdsFriendRequests() {
  if (!wdsRemoteData) return;
  try {
    const { data, error } = await sb.rpc('list_pending_friend_requests', { p_share_key: wdsRemoteData.shareKey });
    if (error) throw error;
    const isFirstPass = !wdsNotifFriendReqBaselineSet;
    (data || []).forEach(r => {
      const isNew = !wdsNotifSeenFriendReqIds.has(r.requester_share_key);
      wdsNotifSeenFriendReqIds.add(r.requester_share_key);
      if (!isFirstPass && isNew) {
        const name = escapeHtml(r.code_name || 'Someone');
        wdsPushNotification(
          `friend-request:${r.requester_share_key}`,
          'Friend Request',
          `${name} wants to be friends.`,
          `<button type="button" class="wds-mini-btn" data-accept-friend="${r.requester_share_key}">Accept</button>
           <button type="button" class="wds-mini-btn" data-decline-friend="${r.requester_share_key}">Decline</button>`
        );
      }
    });
    wdsNotifFriendReqBaselineSet = true;
    renderWdsNotifications();
  } catch (e) { /* best effort */ }
}

async function wdsSendFriendRequest(digitalId) {
  if (!wdsRemoteData) throw new Error('Not signed in.');
  const { error } = await sb.rpc('send_friend_request', { p_share_key: wdsRemoteData.shareKey, p_target_public_id: digitalId });
  if (error) throw error;
}

async function wdsRespondFriendRequest(requesterShareKey, accept) {
  if (!wdsRemoteData) return;
  try {
    await sb.rpc('respond_friend_request', { p_share_key: wdsRemoteData.shareKey, p_requester_share_key: requesterShareKey, p_accept: accept });
    wdsNotifSeenFriendReqIds.delete(requesterShareKey);
    await refreshWdsFriendRequests();
    if (accept) await refreshWdsFriendsList();
  } catch (e) { /* best effort */ }
}

// Render/show only — no history mutation. Used both by the click-driven
// open (which also pushes a URL, see openWdsProfilePage below) and by the
// popstate handler (which must NOT push another entry on top of the one
// the browser is already navigating to/from). Pass a share_key to view
// that operator's profile instead of your own (e.g. clicking a name on a
// feed post) — omit it, or pass your own share_key, for the normal
// self-profile view.
async function wdsShowProfilePage(targetShareKey) {
  if (!wdsRemoteData) return;
  const page = document.getElementById('wdsProfilePage');
  if (!page) return;
  const isOwn = !targetShareKey || targetShareKey === wdsRemoteData.shareKey;
  try {
    const { data, error } = await sb.rpc('get_public_profile_by_share_key', { p_share_key: isOwn ? wdsRemoteData.shareKey : targetShareKey });
    if (error) throw error;
    const row = (data && data[0]) || null;
    if (isOwn) {
      wdsViewedProfile = null;
      wdsOwnWallPermission = (row && row.wall_post_permission) || 'friends';
    } else {
      if (!row) return; // no such operator (or they've never synced) — nothing to show
      wdsViewedProfile = { shareKey: targetShareKey, publicId: row.public_id, codeName: row.code_name, avatarDataUrl: row.avatar_data_url };
    }
  } catch (e) {
    if (!isOwn) return;
    wdsViewedProfile = null;
  }
  page.hidden = false;
  renderWdsProfileHeader();
  await refreshWdsProfilePosts();
  await refreshWdsFriendsList(isOwn ? null : targetShareKey);
  renderWdsProfileVisuals();
}
function wdsHideProfilePage() {
  const page = document.getElementById('wdsProfilePage');
  if (page) page.hidden = true;
  wdsViewedProfile = null;
}

// Cosmetic/shareable URL only — wellness.winfinityfitness.com is a static
// single-page app with no real server-side router, so a fresh load of
// this path depends on wordpress-proxy/index.php falling back to
// index.html for unrecognized paths (see that file's own comments). This
// only ever reflects the SIGNED-IN user's own Digital ID — viewing another
// operator's profile (wdsOpenOtherProfile below) is a same-page overlay
// swap, deliberately not reflected in the URL, so Back always lands you
// on your own dashboard/profile rather than a stranger's.
async function openWdsProfilePage() {
  if (!wdsRemoteData) return;
  const targetPath = '/' + wdsRemoteData.publicId;
  if (location.pathname !== targetPath) history.pushState({ wdsProfile: true }, '', targetPath);
  await wdsShowProfilePage();
}
// Click a name/avatar anywhere (feed post, comment, friend list) to view
// that operator's profile. Reuses the same overlay as your own Profile
// Page — renderWdsProfileHeader/refreshWdsProfilePosts branch on
// wdsViewedProfile to show only their public info and hide edit tools.
async function wdsOpenOtherProfile(shareKey) {
  if (!wdsRemoteData || !shareKey || shareKey === wdsRemoteData.shareKey) { await openWdsProfilePage(); return; }
  await wdsShowProfilePage(shareKey);
}
function closeWdsProfilePage() {
  if (location.pathname !== '/') history.pushState({ wdsProfile: false }, '', '/');
  wdsHideProfilePage();
}
window.addEventListener('popstate', () => {
  if (!wdsRemoteData) return;
  const path = location.pathname.replace(/^\/|\/$/g, '');
  if (path && path.toUpperCase() === wdsRemoteData.publicId.toUpperCase()) wdsShowProfilePage();
  else wdsHideProfilePage();
});

function initWdsFeed() {
  const list = document.getElementById('wdsFeedList');
  if (!list) return;

  list.addEventListener('click', async e => {
    const lightboxImg = e.target.closest('[data-lightbox]');
    if (lightboxImg) { e.stopPropagation(); openChatLightbox(lightboxImg.dataset.lightbox); return; }
    const nameEl = e.target.closest('[data-view-profile]');
    if (nameEl) { e.stopPropagation(); wdsOpenOtherProfile(nameEl.dataset.viewProfile); return; }
    const reactorsEl = e.target.closest('[data-action="view-reactors"]');
    if (reactorsEl) { e.stopPropagation(); wdsShowReactors(reactorsEl.dataset.reactorType, Number(reactorsEl.dataset.reactorId)); return; }
    const card = e.target.closest('.wds-feed-post');
    if (!card) return;
    const postId = Number(card.dataset.postId);
    const shareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;

    const likeBtn = e.target.closest('[data-action="like"]');
    if (likeBtn) {
      // A long-press just opened the reaction picker for this same click —
      // don't also apply the plain-click default reaction on top of it.
      if (wdsFeedJustLongPressed) { wdsFeedJustLongPressed = false; return; }
      if (!shareKey) return;
      // Passing the CURRENT reaction (not a hardcoded 👍) is what makes a
      // plain click remove whichever reaction you already picked — the
      // RPC's own toggle logic deletes when the emoji passed in matches
      // what's already stored, so this needs to match your existing
      // reaction to actually turn it off instead of switching it to 👍.
      const currentEmoji = likeBtn.dataset.currentEmoji || '👍';
      // A native double-click always fires TWO ordinary "click" events
      // before the "dblclick" event — without this delay, those two
      // clicks would already toggle the default 👍 on and off before the
      // picker even opens, and could race with (and clobber) the emoji
      // the user actually picked. Debouncing gives the dblclick handler a
      // chance to cancel this before it ever runs.
      clearTimeout(wdsLikeClickTimer);
      wdsLikeClickTimer = setTimeout(async () => {
        try {
          const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
          await toggleFeedPostLike(postId, shareKey, currentEmoji, codeName);
          await refreshWdsFeed(true);
        } catch (err) { /* best effort */ }
      }, WDS_LIKE_CLICK_DELAY_MS);
      return;
    }
    const likeCommentBtn = e.target.closest('[data-action="like-comment"]');
    if (likeCommentBtn) {
      if (wdsFeedJustLongPressed) { wdsFeedJustLongPressed = false; return; }
      const commentRow = e.target.closest('[data-comment-id]');
      const commentId = commentRow ? Number(commentRow.dataset.commentId) : null;
      if (!shareKey || !commentId) return;
      const currentCommentEmoji = likeCommentBtn.dataset.currentEmoji || '👍';
      clearTimeout(wdsLikeClickTimer);
      wdsLikeClickTimer = setTimeout(async () => {
        try {
          const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
          await toggleFeedCommentLike(commentId, shareKey, currentCommentEmoji, codeName);
          wdsFeedExpandedComments.add(postId);
          await refreshWdsFeed(true);
        } catch (err) { /* best effort */ }
      }, WDS_LIKE_CLICK_DELAY_MS);
      return;
    }
    if (e.target.closest('[data-action="toggle-comments"]')) {
      if (wdsFeedExpandedComments.has(postId)) wdsFeedExpandedComments.delete(postId);
      else wdsFeedExpandedComments.add(postId);
      const section = card.querySelector('.wds-post-comments');
      if (section) section.hidden = !wdsFeedExpandedComments.has(postId);
      return;
    }
    if (e.target.closest('[data-action="unsend-post"]')) {
      if (!shareKey || !confirm('Remove this post?')) return;
      try { await unsendFeedPost(postId, shareKey); await refreshWdsFeed(true); } catch (err) { /* best effort */ }
      return;
    }
    const postMenuBtn = e.target.closest('[data-action="post-menu"]');
    if (postMenuBtn) {
      e.stopPropagation();
      wdsOpenPostMenu(Number(postMenuBtn.dataset.postId), Number(postMenuBtn.dataset.shareId), postMenuBtn.dataset.isOwn === '1', e.clientX, e.clientY);
      return;
    }
    if (e.target.closest('[data-action="save-edit-post"]')) { await wdsSaveEditPost(postId, shareKey); return; }
    if (e.target.closest('[data-action="cancel-edit-post"]')) { await refreshWdsFeed(true); return; }
    if (e.target.closest('[data-action="unsend-comment"]')) {
      const commentRow = e.target.closest('[data-comment-id]');
      const commentId = commentRow ? Number(commentRow.dataset.commentId) : null;
      if (!shareKey || !commentId) return;
      try {
        await unsendFeedComment(commentId, shareKey);
        wdsFeedExpandedComments.add(postId);
        await refreshWdsFeed(true);
      } catch (err) { /* best effort */ }
      return;
    }
    if (e.target.closest('[data-action="send-comment"]')) {
      const input = card.querySelector('.wds-post-comment-compose input');
      if (!input || !input.value.trim() || !shareKey) return;
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      try {
        await postFeedComment(postId, input.value, shareKey, codeName);
        input.value = '';
        wdsFeedExpandedComments.add(postId);
        await refreshWdsFeed(true);
      } catch (err) { /* best effort */ }
      return;
    }
    const replyBtn = e.target.closest('[data-action="reply-comment"]');
    if (replyBtn) {
      const box = card.querySelector(`.wds-post-reply-compose[data-parent-comment-id="${replyBtn.dataset.commentId}"]`);
      if (box) { box.hidden = !box.hidden; if (!box.hidden) box.querySelector('input').focus(); }
      return;
    }
    const toggleRepliesBtn = e.target.closest('[data-action="toggle-replies"]');
    if (toggleRepliesBtn) {
      const commentId = Number(toggleRepliesBtn.dataset.commentId);
      if (wdsFeedExpandedReplies.has(commentId)) wdsFeedExpandedReplies.delete(commentId);
      else wdsFeedExpandedReplies.add(commentId);
      await refreshWdsFeed(true);
      return;
    }
    const sendReplyBtn = e.target.closest('[data-action="send-reply"]');
    if (sendReplyBtn) {
      const parentId = Number(sendReplyBtn.dataset.parentCommentId);
      const box = card.querySelector(`.wds-post-reply-compose[data-parent-comment-id="${parentId}"]`);
      const input = box ? box.querySelector('input') : null;
      if (!input || !input.value.trim() || !shareKey) return;
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      try {
        await postFeedComment(postId, input.value, shareKey, codeName, parentId);
        input.value = '';
        wdsFeedExpandedComments.add(postId);
        wdsFeedExpandedReplies.add(parentId);
        await refreshWdsFeed(true);
      } catch (err) { /* best effort */ }
      return;
    }
    const shareBtn = e.target.closest('[data-action="open-share"]');
    if (shareBtn) {
      // If this card is itself a share, its already-rendered embed IS the
      // true original (Share always targets the original, never a share
      // of a share) — reuse it instead of building a fresh preview from
      // this card's own head/body, which would show the resharer's own
      // caption instead of the thing actually being shared.
      const existingEmbed = card.querySelector('.wds-shared-post-embed');
      let previewHtml;
      if (existingEmbed) {
        previewHtml = existingEmbed.outerHTML;
      } else {
        const headHtml = card.querySelector('.wds-post-head') ? card.querySelector('.wds-post-head').outerHTML : '';
        const bodyEl = card.querySelector('.wds-post-body');
        const mediaEl = card.querySelector('.wds-post-image, .wds-post-gallery');
        previewHtml = `<div class="wds-shared-post-embed">${headHtml}${bodyEl ? bodyEl.outerHTML : ''}${mediaEl ? mediaEl.outerHTML : ''}</div>`;
      }
      wdsOpenShareCompose(Number(shareBtn.dataset.postId), previewHtml);
      return;
    }
    // "Share to My Day" now lives in the ⋮ post menu (wdsOpenPostMenu/
    // wdsPostMenu click handler below) rather than a standalone action-row
    // button — see wdsBuildSharePreviewFromCard for the shared logic.
    const sharersEl = e.target.closest('[data-action="view-sharers"]');
    if (sharersEl) { wdsShowSharers(Number(sharersEl.dataset.postId)); return; }
  });

  list.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('.wds-post-comment-compose input')) {
      const btn = e.target.closest('.wds-post-comments').querySelector('[data-action="send-comment"]');
      if (btn) btn.click();
    }
    if (e.key === 'Enter' && e.target.matches('.wds-post-reply-compose input')) {
      const box = e.target.closest('.wds-post-reply-compose');
      const btn = box ? box.querySelector('[data-action="send-reply"]') : null;
      if (btn) btn.click();
    }
  });

  initWdsFeedReactionMenu(list);
}

// Facebook-style reaction picker for feed posts/comments — press-and-hold
// (or double-click) a Like button to choose a specific reaction; a plain
// quick click applies the default 👍 (handled in initWdsFeed's click
// delegation above). Mirrors wdsBindChatReactions/wdsOpenChatReactionMenu
// exactly, just targeting [data-action="like"/"like-comment"] instead of
// .chat-bubble, and its own #wdsFeedReactionMenu popover.
let wdsFeedReactionTarget = null; // { type: 'post'|'comment', id }
let wdsFeedJustLongPressed = false;
const WDS_LIKE_CLICK_DELAY_MS = 280;
let wdsLikeClickTimer = null;

function wdsCloseFeedReactionMenu() {
  const menu = document.getElementById('wdsFeedReactionMenu');
  if (menu) menu.hidden = true;
  wdsFeedReactionTarget = null;
}

function wdsOpenFeedReactionMenu(btn, x, y) {
  const menu = document.getElementById('wdsFeedReactionMenu');
  if (!menu) return;
  // Cancel any debounced default-👍 click still pending on this same Like
  // button (see initWdsFeed) — the picker opening means the user's choice
  // is what should apply, not a leftover plain-click toggle.
  clearTimeout(wdsLikeClickTimer);
  const isComment = btn.dataset.action === 'like-comment';
  const id = isComment
    ? Number(btn.closest('[data-comment-id]').dataset.commentId)
    : Number(btn.closest('.wds-feed-post').dataset.postId);
  wdsFeedReactionTarget = { type: isComment ? 'comment' : 'post', id };
  const currentEmoji = btn.dataset.currentEmoji || '';
  menu.innerHTML = `<div class="chat-reaction-emoji-row">${QUICK_REACTIONS.map(e =>
    `<button type="button" class="chat-reaction-emoji-btn${currentEmoji === e ? ' is-active' : ''}" data-emoji="${e}">${e}</button>`
  ).join('')}</div>`;
  menu.hidden = false;
  const menuWidth = 240;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 12)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 80)) + 'px';
}

function initWdsFeedReactionMenu(list) {
  const menu = document.getElementById('wdsFeedReactionMenu');
  if (!menu) return;
  const HOLD_MS = 450;
  let pressTimer = null;
  const start = (btn, x, y) => {
    pressTimer = setTimeout(() => {
      pressTimer = null;
      wdsFeedJustLongPressed = true;
      wdsOpenFeedReactionMenu(btn, x, y);
    }, HOLD_MS);
  };
  const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  list.addEventListener('mousedown', e => {
    const btn = e.target.closest('[data-action="like"], [data-action="like-comment"]');
    if (!btn) return;
    start(btn, e.clientX, e.clientY);
  });
  list.addEventListener('mouseup', cancel);
  list.addEventListener('mouseleave', cancel);
  list.addEventListener('dblclick', e => {
    const btn = e.target.closest('[data-action="like"], [data-action="like-comment"]');
    if (!btn) return;
    wdsFeedJustLongPressed = true;
    wdsOpenFeedReactionMenu(btn, e.clientX, e.clientY);
  });

  menu.addEventListener('click', async e => {
    const emojiBtn = e.target.closest('.chat-reaction-emoji-btn');
    if (!emojiBtn || !wdsFeedReactionTarget) return;
    const { type, id } = wdsFeedReactionTarget;
    const emoji = emojiBtn.dataset.emoji;
    const shareKey = wdsRemoteData ? wdsRemoteData.shareKey : null;
    wdsCloseFeedReactionMenu();
    if (!shareKey) return;
    try {
      const codeName = (wdsRemoteData.profile && wdsRemoteData.profile.name) || wdsRemoteData.publicId;
      if (type === 'post') await toggleFeedPostLike(id, shareKey, emoji, codeName);
      else await toggleFeedCommentLike(id, shareKey, emoji, codeName);
      await refreshWdsFeed(true);
    } catch (err) { /* best effort */ }
  });
  document.addEventListener('click', e => {
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-action="like"], [data-action="like-comment"]')) wdsCloseFeedReactionMenu();
  });
}

let wdsFeedPollId = null;
function startWdsFeedPolling() {
  stopWdsFeedPolling();
  wdsFeedPollId = setInterval(refreshWdsFeed, 20000);
}
function stopWdsFeedPolling() {
  if (wdsFeedPollId) { clearInterval(wdsFeedPollId); wdsFeedPollId = null; }
}

// Deferred (not called directly) for the same reason as applyCustomSplashLogo
// below: the remembered-session auto-signin path reaches an `sb.rpc(...)`
// call, and `sb` is a module-level `let` declared much further down this
// file — reading it this early would throw (temporal dead zone).
if (isDesktopShellSite) setTimeout(initDesktopShell, 0);

// Deferred via setTimeout (not called directly) so it runs after the rest of
// this script finishes its first synchronous pass — sbConfigured() reads the
// module-level `let sb`, declared much further down, which would otherwise
// throw (temporal dead zone) if reached this early in the file.
setTimeout(applyCustomSplashLogo, 0);

function getProfile() {
  if (wdsRemoteData) return wdsRemoteData.profile;
  try { return JSON.parse(localStorage.getItem(KEYS.profile)) || null; }
  catch { return null; }
}
function saveProfile(p) { localStorage.setItem(KEYS.profile, JSON.stringify(p)); }

function getLogs() {
  if (wdsRemoteData) return wdsRemoteData.logsObj;
  try { return JSON.parse(localStorage.getItem(KEYS.logs)) || {}; }
  catch { return {}; }
}
function saveLogs(logs) { localStorage.setItem(KEYS.logs, JSON.stringify(logs)); }

/* One-time migration: water tracking switched from 16oz cups to milliliters. */
function migrateWaterUnitsIfNeeded() {
  if (localStorage.getItem('wft_water_migrated_v1')) return;
  const CUP_ML = 473;
  const profile = getProfile();
  if (profile && profile.waterGoal != null && profile.waterGoal < 100) {
    profile.waterGoal = Math.round((profile.waterGoal * CUP_ML) / 50) * 50;
    saveProfile(profile);
  }
  const logs = getLogs();
  let changed = false;
  Object.keys(logs).forEach(date => {
    const e = logs[date];
    if (e.water != null && e.water < 100) {
      e.water = Math.round((e.water * CUP_ML) / 50) * 50;
      changed = true;
    }
  });
  if (changed) saveLogs(logs);
  localStorage.setItem('wft_water_migrated_v1', '1');
}

function updateLogFields(date, partial) {
  const logs = getLogs();
  logs[date] = Object.assign({ date }, logs[date] || {}, partial);
  saveLogs(logs);
  // Any real log write means this is no longer "untouched seed data" — see
  // isDemoDataActive()/checkDemoDataExpiry() further down.
  localStorage.removeItem('wft_demo_seeded_at');
  return logs[date];
}

function getReviews() {
  if (wdsRemoteData) return wdsRemoteData.reviewsObj;
  try { return JSON.parse(localStorage.getItem(KEYS.reviews)) || {}; }
  catch { return {}; }
}
function saveReviews(r) { localStorage.setItem(KEYS.reviews, JSON.stringify(r)); }

function getDailyReviews() {
  if (wdsRemoteData) return wdsRemoteData.dailyReviewsObj;
  try { return JSON.parse(localStorage.getItem(KEYS.dailyReviews)) || {}; }
  catch { return {}; }
}
function saveDailyReviews(r) { localStorage.setItem(KEYS.dailyReviews, JSON.stringify(r)); }

/* ---------------------------------------------------------------- */
/* Unit conversions (canonical storage: kg, cm)                      */
/* ---------------------------------------------------------------- */
const KG_PER_LB = 0.45359237;
const kgToLb = kg => kg / KG_PER_LB;
const lbToKg = lb => lb * KG_PER_LB;
const cmToIn = cm => cm / 2.54;
const ftInToCm = (ft, inch) => (ft * 12 + inch) * 2.54;

function toKg(value, unit) { return unit === 'lb' ? lbToKg(value) : value; }
function fromKg(kg, unit) { return unit === 'lb' ? kgToLb(kg) : kg; }

function getTrainUnit() {
  const stored = localStorage.getItem('wft_train_unit');
  if (stored === 'kg' || stored === 'lb') return stored;
  const profile = getProfile();
  return profile ? (profile.weightUnit || 'kg') : 'kg';
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysBetween(a, b) {
  return Math.round((b.setHours(0,0,0,0) - a.setHours(0,0,0,0)) / 86400000);
}
function fmtDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function round2(n) { return Math.round(n * 100) / 100; }
function round0(n) { return Math.round(n); }
function parseIntOrNull(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
function fmtOrDash(val, fn) { return val == null ? '–' : fn(val); }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ---------------------------------------------------------------- */
/* Fitness math                                                       */
/* ---------------------------------------------------------------- */
function computeBMI(kg, cm) {
  if (!kg || !cm) return null;
  const m = cm / 100;
  return kg / (m * m);
}

/* Illustrative estimate, not a clinical measurement:
   nudges the standard BMI down for users showing high training intensity and step
   activity (a rough proxy for muscle mass BMI alone can't distinguish from fat),
   with a small extra credit if trend weight is falling alongside heavy training
   (suggesting fat loss/recomposition rather than plain weight loss). */
function computeAdjustedBMI(profile, baseBMI, logsArr) {
  const cutoff7 = new Date(); cutoff7.setDate(cutoff7.getDate() - 6); cutoff7.setHours(0, 0, 0, 0);
  const recent7 = logsArr.filter(l => parseISO(l.date) >= cutoff7);

  const workouts7d = recent7.filter(l => l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))).length;
  const workoutIntensity = Math.min(1, workouts7d / 5);

  const avgSteps = avgOfLastNDays(logsArr, 'steps', 7);
  const stepGoal = getEffectiveStepGoal(profile);
  const stepsIndex = avgSteps != null ? Math.min(1, avgSteps / stepGoal) : 0;

  const trendSeries = computeTrendSeries(logsArr);
  const delta14 = trendDeltaDaysAgo(trendSeries, 14);
  const losingWeight = delta14 != null && delta14 < -0.2;

  let activityIndex = (workoutIntensity + stepsIndex) / 2;
  if (losingWeight && workoutIntensity > 0.5) activityIndex = Math.min(1, activityIndex + 0.15);

  const adjustment = -2.5 * activityIndex;
  const adjustedBMI = Math.max(15, baseBMI + adjustment);
  return { adjustedBMI, activityIndex };
}

const SKINFOLD_SITES = ['chest', 'abdomen', 'thigh', 'triceps', 'suprailiac', 'subscapular', 'midaxillary'];

// Jackson-Pollock 7-site skinfold method (Siri equation for body fat % from
// body density). Same seven sites for both sexes; only the density formula
// coefficients differ by gender.
function computeBodyFatJP7(skinfolds, age, gender) {
  const sum = SKINFOLD_SITES.reduce((s, key) => s + (skinfolds[key] || 0), 0);
  if (sum <= 0 || !age) return null;
  const density = gender === 'female'
    ? 1.097 - 0.00046971 * sum + 0.00000056 * sum * sum - 0.00012828 * age
    : 1.112 - 0.00043499 * sum + 0.00000055 * sum * sum - 0.00028826 * age;
  return (495 / density) - 450;
}

function hasLoggedSkinfolds(entry) {
  return !!(entry && entry.skinfolds && SKINFOLD_SITES.some(k => (entry.skinfolds[k] || 0) > 0));
}

// Most recent entry on or before `onOrBeforeDate` that actually has skinfold
// data — lets the Body Fat widget keep showing your last known reading
// instead of dropping to "–" on days you didn't re-measure.
function findLastBodyFatEntry(onOrBeforeDate) {
  const logsArr = sortedLogsArray();
  let found = null;
  for (const l of logsArr) {
    if (l.date > onOrBeforeDate) break;
    if (hasLoggedSkinfolds(l)) found = l;
  }
  return found;
}

function classifyBodyFat(pct, gender) {
  if (pct == null) return { label: '–', status: 'muted' };
  const bounds = gender === 'female' ? [14, 21, 25, 32] : [6, 14, 18, 25];
  const labels = ['Essential/Athletic', 'Fitness', 'Average', 'Above average', 'Obese range'];
  const statuses = ['good', 'good', 'warning', 'serious', 'critical'];
  const idx = bounds.findIndex(b => pct < b);
  const i = idx === -1 ? labels.length - 1 : idx;
  return { label: labels[i], status: statuses[i] };
}

function computeBMR(kg, cm, age, gender) {
  if (!kg || !cm || !age) return null;
  const base = 10 * kg + 6.25 * cm - 5 * age;
  return gender === 'female' ? base - 161 : base + 5;
}
function computeTargets(profile, currentKg) {
  const bmr = computeBMR(currentKg, profile.heightCm, profile.age, profile.gender);
  if (!bmr) return null;
  const tdee = bmr * parseFloat(profile.activity || '1.2');
  return {
    bmr, tdee,
    cutting: [tdee * 0.75, tdee * 0.95],
    bulking: [tdee * 1.05, tdee * 1.15],
    protein: [1.6 * currentKg, 2.2 * currentKg],
  };
}

// A refeed window (set alongside the coach assignment) adds a flat +kcal
// bonus to the calorie target on every day from start through end, inclusive.
function getRefeedBonusForDate(profile, date) {
  if (!profile || !profile.refeedCalories || !profile.refeedStart || !profile.refeedEnd) return 0;
  if (date >= profile.refeedStart && date <= profile.refeedEnd) return profile.refeedCalories;
  return 0;
}

/* A coach-assigned value (set on the Fuel page) overrides the computed default
   wherever a single-number target is needed, until the coach updates it again.
   date (optional, defaults to today) only affects whether an active refeed
   window's +kcal bonus applies — it doesn't change which base target is used. */
function getEffectiveCalorieTarget(profile, date) {
  if (!profile) return null;
  let base;
  if (profile.coachCalorieTarget) base = profile.coachCalorieTarget;
  else {
    const kg = currentWeightKg(profile);
    const targets = kg ? computeTargets(profile, kg) : null;
    if (!targets) return null;
    const range = profile.goalMode === 'bulk' ? targets.bulking : targets.cutting;
    base = round0((range[0] + range[1]) / 2);
  }
  return base + getRefeedBonusForDate(profile, date || todayISO());
}

// Signed running balance, day by day: eating under target banks a surplus
// (adds to a later day's target), eating over target racks up a debt
// (subtracts from it) — a debt from one day and a surplus from another net
// against each other as they carry forward. Asymmetric weekly boundary: any
// banked surplus is forfeited at the start of each week (Monday) — "use it
// by Sunday or lose it" — but an unresolved debt is never forgiven, it keeps
// carrying into the next week until cancelled out by under-eating.
function getCarryoverResets() {
  try { return JSON.parse(localStorage.getItem('wft_carryover_resets')) || {}; } catch (e) { return {}; }
}
function saveCarryoverResets(obj) { localStorage.setItem('wft_carryover_resets', JSON.stringify(obj)); }

function getCalorieCarryover(date, profile) {
  if (!profile) return 0;
  const target = getEffectiveCalorieTarget(profile);
  if (!target) return 0;
  const logs = getLogs();
  const loggedDates = Object.keys(logs).filter(iso => logs[iso].calories != null).sort();
  if (!loggedDates.length) return 0;
  const cutoff = parseISO(date);

  // A manual reset (see resetCalorieCarryover) zeroes the running balance as
  // of a given day — everything logged before that day is ignored, everything
  // from that day forward accumulates normally.
  const resets = getCarryoverResets();
  let startIso = loggedDates[0];
  Object.keys(resets).forEach(rd => { if (rd <= date && rd > startIso) startIso = rd; });
  const cursor = parseISO(startIso);

  // Unused calories bank forward as a bonus for tomorrow; overeating banks
  // forward as debt that shrinks tomorrow's allowance. Surplus banked
  // (positive balance) is forfeited at each weekly reset (Monday); debt is
  // never forgiven and persists until offset by future undereating.
  let balance = 0;
  while (cursor < cutoff) {
    const iso = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0') + '-' + String(cursor.getDate()).padStart(2, '0');
    const entry = logs[iso];
    if (entry && entry.calories != null) balance += target - entry.calories;
    cursor.setDate(cursor.getDate() + 1);
    if (cursor.getDay() === 1 && balance > 0) balance = 0; // crossed into Monday — forfeit unused surplus
  }
  return balance;
}

function resetCalorieCarryover() {
  const profile = getProfile();
  if (!profile) return;
  const today = todayISO();
  const before = getCalorieCarryover(today, profile);
  if (Math.abs(before) < 1) { showRestToast('No banked or overflow calories to reset.'); return; }
  const label = before > 0 ? `+${round0(before)} kcal banked` : `${round0(before)} kcal overflow`;
  if (!confirm(`Reset ${label} to 0? This clears both banked and overflow calorie carryover going forward.`)) return;
  const resets = getCarryoverResets();
  resets[today] = { balanceBefore: before };
  saveCarryoverResets(resets);
  renderNutritionTargets();
  const missionLogOverlay = document.getElementById('missionLogOverlay');
  if (missionLogOverlay && !missionLogOverlay.hidden) renderMissionLogCalendar();
  showRestToast(`Carryover reset: ${label} cleared for ${fmtDate(parseISO(today))}. Noted on the calendar.`);
}

// Undoes the most recent cancel — since getCalorieCarryover always derives
// the balance fresh from the logs plus whichever reset markers still exist,
// simply removing the latest marker is enough to make the exact same math
// "see" further back into history again. Nothing about the balance is
// stored separately, so there's no way for this to drift out of sync no
// matter how many times it's cancelled and returned.
function returnCalorieOverflow() {
  const resets = getCarryoverResets();
  const resetDates = Object.keys(resets).sort();
  if (!resetDates.length) { showRestToast('No cancelled overflow to return yet.'); return; }
  const latestDate = resetDates[resetDates.length - 1];
  const record = resets[latestDate];
  const label = record.balanceBefore > 0 ? `+${round0(record.balanceBefore)} kcal banked` : `${round0(Math.abs(record.balanceBefore))} kcal overflow`;
  if (!confirm(`Bring back the ${label} that was cancelled on ${fmtDate(parseISO(latestDate))}?`)) return;
  delete resets[latestDate];
  saveCarryoverResets(resets);
  renderNutritionTargets();
  const missionLogOverlay = document.getElementById('missionLogOverlay');
  if (missionLogOverlay && !missionLogOverlay.hidden) renderMissionLogCalendar();
  showRestToast(`Returned: ${label} is back in your carryover.`);
}

function hasCancelledOverflow() {
  return Object.keys(getCarryoverResets()).length > 0;
}

function getEffectiveStepGoal(profile) {
  if (!profile) return 8000;
  return profile.coachStepGoal || profile.stepGoal || 8000;
}

function sortedLogsArray() {
  return Object.values(getLogs()).sort((a, b) => a.date.localeCompare(b.date));
}

function currentWeightKg(profile) {
  const logs = Object.values(getLogs()).filter(l => l.weightKg != null).sort((a, b) => a.date.localeCompare(b.date));
  if (logs.length) return logs[logs.length - 1].weightKg;
  return profile ? profile.startWeightKg : null;
}

function avgOfLastNDays(logsArr, field, n) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (n - 1)); cutoff.setHours(0,0,0,0);
  const vals = logsArr.filter(l => parseISO(l.date) >= cutoff && l[field] != null).map(l => l[field]);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function minOfLastNDays(logsArr, field, n) {
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - (n - 1)); cutoff.setHours(0,0,0,0);
  const vals = logsArr.filter(l => parseISO(l.date) >= cutoff && l[field] != null).map(l => l[field]);
  if (!vals.length) return null;
  return Math.min(...vals);
}

function computeTrendSeries(logsArr) {
  const weightLogs = logsArr.filter(l => l.weightKg != null).sort((a, b) => a.date.localeCompare(b.date));
  return weightLogs.map((l) => {
    const d = parseISO(l.date);
    const windowStart = new Date(d); windowStart.setDate(windowStart.getDate() - 6);
    const windowVals = weightLogs.filter(w => {
      const wd = parseISO(w.date);
      return wd >= windowStart && wd <= d;
    }).map(w => w.weightKg);
    const trend = windowVals.reduce((a, b) => a + b, 0) / windowVals.length;
    return { date: l.date, dateObj: d, actualKg: l.weightKg, trendKg: trend };
  });
}

function trendDeltaDaysAgo(series, days) {
  if (!series.length) return null;
  const latest = series[series.length - 1];
  const targetDate = new Date(latest.dateObj); targetDate.setDate(targetDate.getDate() - days);
  if (parseISO(series[0].date) > targetDate) return null;
  let best = null;
  for (const pt of series) {
    if (pt.dateObj <= targetDate) best = pt; else break;
  }
  if (!best) return null;
  return latest.trendKg - best.trendKg;
}

function statusForLevel(field, value) {
  if (value == null) return 'muted';
  if (field === 'sleep') {
    if (value >= 4) return 'good';
    if (value >= 3) return 'warning';
    return 'critical';
  }
  if (value <= 2) return 'good';
  if (value <= 3) return 'warning';
  if (value <= 4) return 'serious';
  return 'critical';
}

function labelForLevel(field, value) {
  if (value == null) return 'N/A';
  if (field === 'sleep') {
    if (value >= 4) return 'Good';
    if (value >= 3) return 'Fair';
    return 'Poor';
  }
  if (value <= 2) return 'Low';
  if (value <= 3) return 'Moderate';
  if (value <= 4) return 'Elevated';
  return 'High';
}

function last7DailyValues(field) {
  const logs = getLogs();
  const base = parseISO(todayISO());
  const arr = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const e = logs[iso];
    arr.push(e && e[field] != null ? e[field] : null);
  }
  return arr;
}

function getCurrentWeekReview() {
  const reviews = getReviews();
  const today = new Date(todayISO());
  let best = null;
  Object.values(reviews).forEach(r => {
    const diffDays = (today - new Date(r.date)) / 86400000;
    if (diffDays >= 0 && diffDays < 7 && (!best || r.date > best.date)) best = r;
  });
  return best;
}

function computeHabitCompletion(profile, entry) {
  const review = getCurrentWeekReview();
  const checks = [
    !!(entry && entry.exercises && entry.exercises.length > 0), // workout progress
    !!(entry && entry.steps != null && entry.steps >= getEffectiveStepGoal(profile)), // steps target
    !!(entry && entry.weightKg != null), // weight input
    localStorage.getItem('wft_lb_optin') === '1', // nexus synced
    !!(review && review.adjustments && review.adjustments.trim() !== ''), // adjustments made to keep progress on track
    !!(review && review.wins && review.wins.trim() !== ''), // wins this week
    !!(review && review.improvements && review.improvements.trim() !== ''), // improvements this week
    !!(review && review.focus && review.focus.length >= 1 && review.focus.length <= 2), // pick 1-2 focus for next week
    localStorage.getItem('wft_drive_last_backup') === todayISO(), // back up now
  ];
  let total = checks.length;
  let done = checks.filter(Boolean).length;
  (profile ? profile.extraHabits || [] : []).forEach((label, i) => {
    if (!label) return;
    total++;
    if (entry && entry.extra && entry.extra[i]) done++;
  });
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { pct, done, total };
}

/* ---------------------------------------------------------------- */
/* Radial ring renderer (reused by Status rings + Training timer)     */
/* ---------------------------------------------------------------- */
let ringGradCounter = 0;

function renderRing(container, pct, opts) {
  opts = opts || {};
  const size = opts.size || 120;
  const stroke = opts.stroke || 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, pct));
  const offset = c - (clamped / 100) * c;
  const center = opts.centerHtml || `<span style="font-size:${Math.round(size * 0.22)}px;font-weight:800;font-family:var(--font-mono);color:var(--text-primary);">${opts.centerText || ''}</span>`;
  const gradId = `ringGrad${ringGradCounter++}`;
  const strokeAttr = opts.gradient ? `url(#${gradId})` : '';
  const glow = opts.gradient ? `filter: drop-shadow(0 0 6.6px var(--gradient-glow));` : '';

  // Optional inset red arc showing progress beyond 100% (e.g. calories over target),
  // drawn just inside the main ring so it stays within the same viewBox.
  const overflowPct = Math.min(100, Math.max(0, opts.overflowPct || 0));
  const overflowStroke = Math.max(3, Math.round(stroke * 0.4));
  const overflowR = Math.max(4, r - stroke / 2 - overflowStroke / 2 - 3);
  const overflowC = 2 * Math.PI * overflowR;
  const overflowOffset = overflowC - (overflowPct / 100) * overflowC;
  const overflowRing = overflowPct > 0
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${overflowR}" stroke-width="${overflowStroke}" fill="none" stroke="var(--critical)"
        stroke-dasharray="${overflowC.toFixed(2)}" stroke-dashoffset="${overflowOffset.toFixed(2)}" stroke-linecap="round"
        transform="rotate(-90 ${size / 2} ${size / 2})" style="filter: drop-shadow(0 0 4px var(--critical));"></circle>`
    : '';

  container.innerHTML = `
    ${opts.modTag ? `<p class="mod-tag">${opts.modTag}</p>` : ''}
    <div style="position:relative;width:${size}px;height:${size}px;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        ${opts.gradient ? `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="#8b6bf2"/>
          <stop offset="55%" stop-color="#3f8ff0"/>
          <stop offset="100%" stop-color="#2de2e6"/>
        </linearGradient></defs>` : ''}
        <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"></circle>
        <circle class="ring-fill${opts.violet ? ' violet' : ''}${opts.magenta ? ' magenta' : ''}" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
          stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
          style="${strokeAttr ? `stroke:${strokeAttr};${glow}` : ''}"
          transform="rotate(-90 ${size / 2} ${size / 2})"></circle>
        ${overflowRing}
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;">${center}</div>
    </div>
    ${opts.label ? `<div class="ring-label">${opts.label}</div>` : ''}
    ${opts.sub ? `<div class="ring-sub">${opts.sub}</div>` : ''}
  `;
}

/* ---------------------------------------------------------------- */
/* Tab + sheet navigation                                              */
/* ---------------------------------------------------------------- */
function initSwipeNavigation() {
  const app = document.getElementById('app');
  const noSwipeSelector = 'input[type="range"], .weight-chart, .table-wrap, .tab-bar';
  let startX = 0, startY = 0, tracking = false;

  app.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || e.target.closest(noSwipeSelector)) { tracking = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  app.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const btns = Array.from(document.querySelectorAll('.tab-btn[data-target]'));
    const activeIdx = btns.findIndex(b => b.classList.contains('is-active'));
    if (activeIdx === -1) return;
    const nextIdx = Math.max(0, Math.min(btns.length - 1, dx < 0 ? activeIdx + 1 : activeIdx - 1));
    if (nextIdx !== activeIdx) btns[nextIdx].click();
  }, { passive: true });
}

// Android hardware/gesture back button: closes the topmost open sheet, or
// returns to the previously viewed tab, instead of the TWA/browser default
// (exiting the app) — only falls through to that default once nothing is
// open and the user is already on the Status (home) tab.
//
// Generic by design rather than hand-wiring history.pushState into each of
// the ~20 individual overlay open functions: a MutationObserver watches
// every .sheet-overlay's `hidden` attribute and pushes/pops a history entry
// whenever one opens/closes, however it was opened or closed (trigger
// button, backdrop tap, or another code path). The donation prompt
// (.donation-overlay) is deliberately excluded — its multi-step flow
// (prompt -> QR view) doesn't map cleanly onto a single close button, and
// it already has its own always-visible IGNORE button.
// Standard "tap the dim backdrop to close" handler for .sheet-overlay panels.
// Checking only the click's target isn't enough — on touch devices, a drag
// or scroll gesture that starts inside the sheet's content but releases
// over the backdrop (e.g. dragging down past the sheet's edge while trying
// to scroll it) synthesizes a click whose target IS the backdrop, which
// would wrongly close the sheet mid-drag. Requiring the press (pointerdown)
// to have ALSO started on the backdrop makes sure only a genuine tap
// outside the sheet — not a drag that merely ends there — closes it.
function bindOverlayBackdropClose(overlay, onClose) {
  let pressedOnBackdrop = false;
  overlay.addEventListener('pointerdown', e => { pressedOnBackdrop = (e.target === overlay); });
  overlay.addEventListener('click', e => {
    if (e.target === overlay && pressedOnBackdrop) onClose();
  });
}

function initBackButtonNav() {
  const DISMISSIBLE_SELECTOR = '.sheet-overlay';
  const SCROLL_TOP_THRESHOLD = 40; // px — "already basically at the top" vs. "actually scrolled down"
  let handlingPopstate = false;
  // Set right before the observer's own synthetic history.back() call (from
  // closing an overlay via X / backdrop tap / any non-back-button UI path).
  // The popstate that call triggers must NOT also run the "nothing open"
  // logic below — otherwise closing an overlay with the X button forces a
  // scroll-to-top/tab-change instead of just revealing whatever tab was
  // already underneath it.
  let closingViaObserver = false;
  // Which tab to return to on back — the tab you were on immediately
  // before the current one, so back walks backward through your actual
  // navigation instead of always jumping straight to Status. Popped (not
  // re-pushed) on every step back, so revisiting a tab forward again
  // starts a fresh trail from there.
  const initialTab = document.querySelector('.tab-btn.is-active');
  let tabHistory = initialTab ? [initialTab.dataset.target] : [];

  history.replaceState({ wftNav: true }, '');

  const observer = new MutationObserver(mutations => {
    if (handlingPopstate) return;
    mutations.forEach(m => {
      const el = m.target;
      if (!(el instanceof Element) || !el.matches(DISMISSIBLE_SELECTOR)) return;
      if (!el.hidden) {
        history.pushState({ wftNav: true }, '');
      } else {
        // Closed via the UI (close button / backdrop tap / other code),
        // not via the back button — pop the entry pushed on open so the
        // history stack doesn't drift out of sync with the visible UI.
        closingViaObserver = true;
        history.back();
      }
    });
  });
  document.querySelectorAll(DISMISSIBLE_SELECTOR).forEach(el => {
    observer.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });

  document.querySelectorAll('.tab-btn[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (handlingPopstate) return; // programmatic .click() from the back-nav branch below — already accounted for
      const target = btn.dataset.target;
      if (tabHistory[tabHistory.length - 1] !== target) tabHistory.push(target);
      history.pushState({ wftNav: true }, '');
    });
  });

  window.addEventListener('popstate', () => {
    if (closingViaObserver) {
      // The overlay is already closed (that's what triggered this pop) and
      // the tab underneath never changed — nothing left to do.
      closingViaObserver = false;
      return;
    }
    handlingPopstate = true;
    let openOverlay = null;
    document.querySelectorAll(DISMISSIBLE_SELECTOR).forEach(el => { if (!el.hidden) openOverlay = el; });
    if (openOverlay) {
      // Exception to everything below — a popup always just closes on back.
      const closeBtn = openOverlay.querySelector('.sheet-close');
      if (closeBtn) closeBtn.click(); else openOverlay.hidden = true;
    } else if (window.scrollY > SCROLL_TOP_THRESHOLD) {
      // First back press while scrolled down a tab: scroll to top instead
      // of navigating away, and re-push the state so there's still
      // something for the NEXT back press to pop — otherwise this press
      // would silently consume a history entry without actually doing
      // anything once already at the top.
      window.scrollTo({ top: 0, behavior: 'smooth' });
      history.pushState({ wftNav: true }, '');
    } else {
      // Already at the top — step back through actual tab visit history.
      tabHistory.pop(); // discard the current tab
      const prevTab = tabHistory[tabHistory.length - 1];
      const prevBtn = prevTab && document.querySelector(`.tab-btn[data-target="${prevTab}"]`);
      if (prevBtn) prevBtn.click();
      // Else: no previous tab left (the true "root") — let the browser/TWA's
      // own back behavior proceed (backgrounds/exits the app).
    }
    // MutationObserver callbacks run as a microtask (before this timeout's
    // macrotask), so it still sees handlingPopstate=true and correctly
    // skips pushing/popping for the change just made above.
    setTimeout(() => { handlingPopstate = false; }, 0);
  });
}

// Curated top-level overlays worth restoring on reopen — each maps to the
// same trigger button a user would tap to open it, so restoring re-runs the
// real open logic (populating content) instead of just toggling `hidden` and
// risking stale/empty content. Nested or action-specific overlays (Add Food,
// barcode scan, date picker, the donation prompt, etc.) are deliberately left
// out since their state can't be safely reconstructed from just an ID.
const RESTORABLE_OVERLAYS = {
  foodDiaryOverlay: 'btnOpenFoodDiary',
  settingsOverlay: 'btnOpenSettings',
  prBoardOverlay: 'btnOpenPRBoard',
  missionLogOverlay: 'btnOpenMissionLog',
};

function initLastStateRestore() {
  Object.entries(RESTORABLE_OVERLAYS).forEach(([overlayId, triggerId]) => {
    const overlay = document.getElementById(overlayId);
    const trigger = document.getElementById(triggerId);
    if (!overlay || !trigger) return;
    trigger.addEventListener('click', () => localStorage.setItem('wft_last_overlay', overlayId));
    const clearIfCurrent = () => {
      if (localStorage.getItem('wft_last_overlay') === overlayId) localStorage.removeItem('wft_last_overlay');
    };
    const closeBtn = overlay.querySelector('.sheet-close');
    if (closeBtn) closeBtn.addEventListener('click', clearIfCurrent);
    bindOverlayBackdropClose(overlay, clearIfCurrent);
  });
}

function restoreLastState() {
  const savedTab = localStorage.getItem('wft_last_tab');
  if (savedTab) {
    const btn = document.querySelector(`.tab-btn[data-target="${savedTab}"]`);
    if (btn && !btn.classList.contains('is-active')) btn.click();
  }
  const savedOverlay = localStorage.getItem('wft_last_overlay');
  const triggerId = savedOverlay && RESTORABLE_OVERLAYS[savedOverlay];
  if (triggerId) {
    const trigger = document.getElementById(triggerId);
    if (trigger) setTimeout(() => trigger.click(), 150);
  }
}

function initTabs() {
  const btns = document.querySelectorAll('.tab-btn[data-target]');
  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      localStorage.setItem('wft_last_tab', target);
      document.querySelectorAll('.tab-panel').forEach(p => p.hidden = p.dataset.tab !== target);
      btns.forEach(b => b.classList.toggle('is-active', b === btn));
      window.scrollTo(0, 0);
      if (target === 'status') { loadCheckinForm(); renderDashboard(); }
      if (target === 'training') {
        loadTrainingForDate(document.getElementById('trainDate').value);
        renderTrainingStats();
        renderExerciseTimerDisplays();
        checkTrainingIdle();
      }
      if (target === 'nutrition') {
        const nutDate = document.getElementById('nutDate').value;
        loadNutritionForDate(nutDate);
        renderNutritionTargets();
        renderNutritionAverages();
        refreshFuelWaterViews(nutDate);
        // Computed Targets widget now lives at the bottom of this tab (see
        // the Coach Assignment <-> Computed Targets tab swap).
        const pForTargets = getProfile();
        if (pForTargets) renderComputedTargets(pForTargets);
        renderMediaSyncWidget();
      }
      if (target === 'bio') {
        loadBioForDate(document.getElementById('bioDate').value);
        renderWaterRetentionOrb();
      }
      if (target === 'leaderboard' && sbConfigured()) {
        pullLeaderboard().then(renderNexusRankings).catch(() => {});
        refreshAppOpensStat();
        fetchChatMessages().then(renderChatMessages).then(() => {
          if (!currentChatRoomId) markRoomRead('public');
        }).catch(() => {});
        refreshChatRooms();
        startNexusPolling();
      } else {
        stopNexusPolling();
      }
      if (target === 'menu') {
        renderHistory();
        renderMeasureHistory();
        renderBodyFatHistory();
        renderDailyReviewChecklist(document.getElementById('dailyReviewDate').value || todayISO());
      }
      updateTabDots();
    });
  });
}

function isProfileComplete(p) {
  return !!(p && p.name && p.gender && p.age && p.heightCm && p.startWeightKg != null && p.activity && p.goalTargetKg != null);
}

function getTabCompletionMap() {
  const profile = getProfile();
  const entry = getLogs()[todayISO()] || {};
  return {
    status: entry.weightKg != null && entry.sleep != null,
    training: !!(entry.exercises && entry.exercises.length > 0),
    nutrition: entry.calories != null,
    bio: entry.stress != null && entry.fatigue != null && entry.hunger != null,
    menu: isProfileComplete(profile),
  };
}

function updateTabDots() {
  const map = getTabCompletionMap();
  Object.keys(map).forEach(tab => {
    const dot = document.querySelector(`.tab-btn[data-target="${tab}"] .tab-dot`);
    if (dot) dot.hidden = map[tab];
  });
}

let nexusPollId = null;
let nexusFastUntil = 0;
function startNexusPolling() {
  stopNexusPolling();
  const interval = Date.now() < nexusFastUntil ? 1500 : 5000;
  nexusPollId = setInterval(() => {
    fetchChatMessages().then(renderChatMessages).catch(() => {});
    if (interval !== 5000 && Date.now() >= nexusFastUntil) startNexusPolling();
  }, interval);
}
function stopNexusPolling() {
  if (nexusPollId) { clearInterval(nexusPollId); nexusPollId = null; }
}
function activateNexusFastChat() {
  nexusFastUntil = Date.now() + 3 * 60 * 1000;
  const lbTab = document.querySelector('.tab-btn[data-target="leaderboard"]');
  if (lbTab && lbTab.classList.contains('is-active')) startNexusPolling();
}

function initSettingsOverlay() {
  const overlay = document.getElementById('settingsOverlay');
  document.getElementById('btnOpenSettings').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseSettings').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });

  const toneSelect = document.getElementById('alarmToneSelect');
  toneSelect.value = localStorage.getItem('wft_alarm_tone') || 'chime';
  toneSelect.addEventListener('change', () => {
    localStorage.setItem('wft_alarm_tone', toneSelect.value);
    playAlarmTone(toneSelect.value);
  });
  document.getElementById('btnPreviewAlarmTone').addEventListener('click', () => playAlarmTone(toneSelect.value));

  initHydrationReminderSettings();
  initWebSyncSettings();
}

function initContact() {
  const overlay = document.getElementById('contactOverlay');
  document.getElementById('btnFooterContact').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseContact').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
}

async function generateShareCardBlob({ emoji, title, stats }) {
  const theme = getShareTheme();
  const canvas = document.createElement('canvas');
  canvas.width = 600; canvas.height = 600;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 600, 600);
  bg.addColorStop(0, theme.bgFrom);
  bg.addColorStop(1, theme.bgTo);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 600, 600);
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, 584, 584);

  ctx.textAlign = 'center';
  ctx.font = '76px sans-serif';
  ctx.fillText(emoji, 300, 140);
  ctx.fillStyle = theme.accent;
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(title, 300, 205);

  ctx.textAlign = 'left';
  let y = 310;
  const colW = 260, startX = 55;
  stats.forEach((s, i) => {
    const x = startX + (i % 2) * colW;
    if (i % 2 === 0 && i > 0) y += 110;
    ctx.fillStyle = theme.textMuted;
    ctx.font = '15px monospace';
    ctx.fillText(s.label.toUpperCase(), x, y);
    ctx.fillStyle = theme.textPrimary;
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText(s.value, x, y + 36);
  });

  await drawShareWatermark(ctx, 600, 600);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

// Browsers won't let a website silently write into the phone's protected
// Photos/Gallery library — that would be a privacy hole any site could
// abuse. Triggering a normal file download is the closest legitimate
// equivalent: on Android it lands in Downloads, which the OS's MediaStore
// auto-indexes into Gallery/Photos apps in most setups. On iOS/Safari it
// saves to the Files app instead (Safari doesn't support silently saving
// straight to Photos), so it isn't quite "automatic" there.
function slugifyFilename(text) {
  return (text || 'winfinity-share').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'winfinity-share';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

// navigator.share/canShare and the <a download> trick below are both
// browser APIs Chrome provides — inside the Capacitor-wrapped Android app's
// bare WebView (not real Chrome, unlike the old TWA) they're either absent
// or silently non-functional, which is why every share button and the
// "auto-save to gallery" behavior broke when the GPS fix moved off TWA.
// These native equivalents cover the same ground: Media.savePhoto() writes
// straight to a real gallery album via MediaStore (Filesystem writes alone
// don't show up in Gallery on Android 10+, scoped storage doesn't index
// them), and Share.share() with a real file:// URI opens the full native
// share sheet — every installed app that registers as a share target, not
// just whatever a web share sheet happens to offer.
async function nativeSaveImageToGallery(blob, filename) {
  if (!(isNativeApp() && window.Capacitor.Plugins.Media)) return false;
  try {
    const dataUrl = await blobToDataUrl(blob);
    await window.Capacitor.Plugins.Media.savePhoto({ path: dataUrl, albumIdentifier: 'Winfinity', fileName: filename.replace(/\.[^.]+$/, '') });
    return true;
  } catch (e) { return false; }
}

async function nativeShareFile(blob, filename, mimeType, { title, text } = {}) {
  if (!(isNativeApp() && window.Capacitor.Plugins.Filesystem && window.Capacitor.Plugins.Share)) return false;
  try {
    const dataUrl = await blobToDataUrl(blob);
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const { Filesystem, Share } = window.Capacitor.Plugins;
    await Filesystem.writeFile({ path: filename, data: base64, directory: 'CACHE' });
    const { uri } = await Filesystem.getUri({ path: filename, directory: 'CACHE' });
    await Share.share({ title, text, url: uri, dialogTitle: title || 'Share' });
    return true;
  } catch (e) {
    // AbortError-equivalent (user backed out of the native share sheet) —
    // not a failure, same as the web path's AbortError handling.
    return true;
  }
}

function downloadImageBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function shareViaWebShare(shareData, imageBlob) {
  if (isNativeApp()) {
    if (imageBlob) {
      const filename = `${slugifyFilename(shareData.title)}.png`;
      const saved = await nativeSaveImageToGallery(imageBlob, filename);
      if (saved) showRestToast('Image saved to your gallery.');
      await nativeShareFile(imageBlob, filename, 'image/png', shareData);
      return;
    }
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(shareData.text ? `${shareData.text} ${shareData.url || ''}`.trim() : shareData.url);
        showRestToast('Copied — paste it anywhere to share!');
      } catch (e) { /* ignore */ }
    }
    return;
  }
  if (imageBlob) {
    downloadImageBlob(imageBlob, `${slugifyFilename(shareData.title)}.png`);
    showRestToast('Image saved to your device.');
  }
  if (imageBlob && navigator.canShare) {
    const file = new File([imageBlob], 'winfinity-activity.png', { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: shareData.title, text: shareData.text, files: [file] });
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
  }
  if (navigator.share) {
    try { await navigator.share(shareData); } catch (e) { /* user cancelled or share failed — no-op */ }
  } else if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(shareData.text ? `${shareData.text} ${shareData.url || ''}`.trim() : shareData.url);
      showRestToast('Copied — paste it anywhere to share!');
    } catch (e) { /* ignore */ }
  }
}

// Returns 'shared' (share sheet opened and completed), 'cancelled' (user
// dismissed the share sheet — not a failure), or 'unsupported' (no share
// API path worked at all). Images are downloaded to the device in every
// case, matching "save automatically when share is tapped" regardless of
// what happens with the OS share sheet afterward.
async function shareMultipleViaWebShare(shareData, namedBlobs) {
  if (isNativeApp()) {
    if (namedBlobs.length) {
      await Promise.all(namedBlobs.map(({ name, blob }) => nativeSaveImageToGallery(blob, name)));
      showRestToast(`${namedBlobs.length} image${namedBlobs.length > 1 ? 's' : ''} saved to your gallery.`);
      await nativeShareFile(namedBlobs[0].blob, namedBlobs[0].name, 'image/png', shareData);
    }
    return 'shared';
  }
  // The share attempt goes first, as close as possible to the click that
  // triggered it — a mobile browser's "this came from a real tap" grace
  // period for navigator.share() is short, and generating several images
  // before attempting it can already eat into that window on slower devices.
  let result = 'unsupported';
  if (namedBlobs.length && navigator.canShare) {
    const files = namedBlobs.map(({ name, blob }) => new File([blob], name, { type: 'image/png' }));
    if (navigator.canShare({ files })) {
      try {
        await navigator.share({ title: shareData.title, text: shareData.text, files });
        result = 'shared';
      } catch (e) { result = (e && e.name === 'AbortError') ? 'cancelled' : 'unsupported'; }
    }
  }
  if (result === 'unsupported' && navigator.share) {
    try { await navigator.share(shareData); result = 'shared'; }
    catch (e) { result = (e && e.name === 'AbortError') ? 'cancelled' : 'unsupported'; }
  }
  if (namedBlobs.length) {
    namedBlobs.forEach(({ name, blob }) => downloadImageBlob(blob, name));
    showRestToast(`${namedBlobs.length} image${namedBlobs.length > 1 ? 's' : ''} saved to your device.`);
  }
  return result;
}

function initFooterShare() {
  // On a clean-variant install, shares carry the ?variant=clean flag forward
  // so whoever the link is shared with also lands on the Facebook/Instagram-free
  // experience — not just the person the link was originally sent to.
  const shareUrl = isCleanShareVariant()
    ? 'https://winfinityfitness.github.io/fitness-tracker?variant=clean'
    : 'https://winfinityfitness.github.io/fitness-tracker';
  document.getElementById('btnFooterShare').addEventListener('click', () => {
    shareViaWebShare({
      title: 'Winfinity Tracker',
      text: 'Check out Winfinity Tracker — my fitness tracking app:',
      url: shareUrl,
    });
  });
  // Same GCash QR as the Saturday-night donation prompt — jumps straight to
  // the QR view since tapping a dedicated Donate button is already explicit
  // intent, no need for the prompt's IGNORE/SURE step first.
  document.getElementById('btnFooterDonate').addEventListener('click', openDonationQr);
}

const FOOTER_TAGLINES = [
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

function initFooterTagline() {
  const el = document.getElementById('footerTagline');
  if (!el) return;
  let lastIdx = -1;
  setInterval(() => {
    let idx;
    do { idx = Math.floor(Math.random() * FOOTER_TAGLINES.length); } while (idx === lastIdx && FOOTER_TAGLINES.length > 1);
    lastIdx = idx;
    el.textContent = `"${FOOTER_TAGLINES[idx]}"`;
  }, 15000);
}

// Facebook/Instagram footer links are visible by default for everyone, same
// as before — an admin can selectively HIDE (or re-show) them for one
// specific Digital ID via an Assign Targets push, a discreet per-user
// override riding along on the same coach-assignment refresh channel,
// applied the moment that user pulls it (see
// refreshCoachAssignmentFromServer), whether or not they save the visible
// targets afterward.
function applyFooterSocialLinksVisibility(visible) {
  const fb = document.getElementById('footerFacebookLink');
  const ig = document.getElementById('footerInstagramLink');
  const show = visible && !isCleanShareVariant();
  if (fb) fb.hidden = !show;
  if (ig) ig.hidden = !show;
}

function initFooterSocialLinks() {
  const profile = getProfile();
  const visible = !profile || profile.footerSocialLinksVisible !== false;
  applyFooterSocialLinksVisibility(visible);
}

function initPrivacyPolicy() {
  const overlay = document.getElementById('privacyOverlay');
  document.getElementById('btnFooterPrivacy').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnClosePrivacy').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
}

function initTermsOfService() {
  const overlay = document.getElementById('termsOverlay');
  document.getElementById('btnFooterTerms').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseTerms').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
}

async function sharePersonalRecords() {
  const rows = computePRBoard();
  if (!rows.length) return;
  const top = rows
    .slice()
    .sort((a, b) => b.current.oneRM - a.current.oneRM)
    .slice(0, 6);
  const blob = await generateShareCardBlob({
    emoji: '🏆',
    title: 'Personal Records',
    stats: top.map(r => ({ label: r.name, value: `${round2(r.current.weightKg)}kg × ${r.current.reps}` })),
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Personal Records', text: '🏆 New personal records logged with Winfinity Tracker!' }, blob);
}

function initPRBoardOverlay() {
  const overlay = document.getElementById('prBoardOverlay');
  document.getElementById('btnOpenPRBoard').addEventListener('click', () => {
    renderPRBoard();
    overlay.hidden = false;
  });
  document.getElementById('btnClosePRBoard').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
  document.getElementById('btnSharePR').addEventListener('click', sharePersonalRecords);
}

function getSavedTimezone() {
  return localStorage.getItem('wft_timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function renderDateTimeClock() {
  const tz = getSavedTimezone();
  const now = new Date();
  try {
    document.getElementById('dtDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: tz });
    document.getElementById('dtClock').textContent = now.toLocaleTimeString('en-GB', { timeZone: tz });
  } catch (e) {
    document.getElementById('dtDate').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    document.getElementById('dtClock').textContent = now.toLocaleTimeString('en-GB');
  }
}

function initDateTimeWidget() {
  renderDateTimeClock();
  setInterval(renderDateTimeClock, 1000);
}

function initTimezonePicker() {
  const overlay = document.getElementById('timezoneOverlay');
  const select = document.getElementById('timezoneSelect');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch (e) {
    zones = ['UTC', 'Asia/Manila', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Dubai', 'Asia/Kolkata',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Denver',
      'America/Los_Angeles', 'America/Sao_Paulo', 'Australia/Sydney', 'Pacific/Auckland'];
  }
  select.innerHTML = zones.map(z => `<option value="${z}">${z.replace(/_/g, ' ')}</option>`).join('');

  document.getElementById('btnTimezone').addEventListener('click', () => {
    select.value = getSavedTimezone();
    overlay.hidden = false;
  });
  document.getElementById('btnCloseTimezone').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
  document.getElementById('btnSaveTimezone').addEventListener('click', () => {
    localStorage.setItem('wft_timezone', select.value);
    renderDateTimeClock();
    const note = document.getElementById('timezoneSaveNote');
    note.textContent = 'Timezone saved.';
    setTimeout(() => { note.textContent = ''; }, 2000);
    overlay.hidden = true;
  });
}

/* ---------------------------------------------------------------- */
/* Status: weather widget (Open-Meteo, no API key required)            */
/* ---------------------------------------------------------------- */
// Thin-line neon icons (cyan clouds/rain, amber sun/bolt) matching the app's
// terminal aesthetic, replacing default-emoji weather glyphs.
const WX_CLOUD_PATH = 'M6 15a4.5 4.5 0 0 1-.5-8.98A5.5 5.5 0 0 1 16 7.5a3.9 3.9 0 0 1-1 7.5H6z';
const WX_SUN_RAYS = `<g stroke="var(--warning)" stroke-width="1.5" stroke-linecap="round">
  <line x1="12" y1="1.6" x2="12" y2="3.8"/><line x1="12" y1="20.2" x2="12" y2="22.4"/>
  <line x1="1.6" y1="12" x2="3.8" y2="12"/><line x1="20.2" y1="12" x2="22.4" y2="12"/>
  <line x1="4.4" y1="4.4" x2="5.9" y2="5.9"/><line x1="18.1" y1="18.1" x2="19.6" y2="19.6"/>
  <line x1="4.4" y1="19.6" x2="5.9" y2="18.1"/><line x1="18.1" y1="5.9" x2="19.6" y2="4.4"/>
</g>`;
function wxSvg(inner) { return `<svg viewBox="0 0 24 24" class="wx-icon" fill="none">${inner}</svg>`; }
function wxCloud(cy) { return `<path d="${WX_CLOUD_PATH}" transform="translate(0 ${cy})" stroke="var(--cyan)" stroke-width="1.6" stroke-linejoin="round" style="filter:drop-shadow(0 0 3px var(--cyan-glow));"/>`; }
function wxSun(r, cy) { return `<circle cx="12" cy="${cy}" r="${r}" stroke="var(--warning)" stroke-width="1.5" style="filter:drop-shadow(0 0 3px rgba(219,165,44,0.6));"/>`; }
function wxRain(y) { return `<g stroke="var(--cyan)" stroke-width="1.6" stroke-linecap="round"><line x1="8" y1="${y}" x2="7" y2="${y + 3}"/><line x1="12" y1="${y}" x2="11" y2="${y + 3}"/><line x1="16" y1="${y}" x2="15" y2="${y + 3}"/></g>`; }
function wxSnow(y) { return `<g stroke="var(--cyan)" stroke-width="2.2" stroke-linecap="round"><line x1="8" y1="${y}" x2="8" y2="${y + 0.1}"/><line x1="12" y1="${y + 1.5}" x2="12" y2="${y + 1.6}"/><line x1="16" y1="${y}" x2="16" y2="${y + 0.1}"/></g>`; }
function wxBolt() { return `<path d="M12.8 12.5l-3.3 5.4h2.7l-1.6 4.2 4.4-6h-2.7l1.7-3.6z" fill="var(--warning)" stroke="var(--warning)" stroke-width="0.8" stroke-linejoin="round" style="filter:drop-shadow(0 0 3px rgba(219,165,44,0.7));"/>`; }

function weatherIconFor(code) {
  if (code === 0) return wxSvg(wxSun(4.6, 12) + WX_SUN_RAYS);
  if (code <= 3) return wxSvg(wxSun(3, 7) + `<g stroke="var(--warning)" stroke-width="1.4" stroke-linecap="round"><line x1="7" y1="1.4" x2="7" y2="2.6"/><line x1="1.4" y1="7" x2="2.6" y2="7"/><line x1="3" y1="3" x2="3.9" y2="3.9"/></g>` + wxCloud(2));
  if (code <= 48) return wxSvg(wxCloud(1) + `<g stroke="var(--cyan)" stroke-width="1.4" stroke-linecap="round" opacity="0.65"><line x1="4" y1="18" x2="20" y2="18"/><line x1="6.5" y1="20.5" x2="17.5" y2="20.5"/></g>`);
  if (code <= 67) return wxSvg(wxCloud(-1) + wxRain(14));
  if (code <= 77) return wxSvg(wxCloud(-1) + wxSnow(14));
  if (code <= 82) return wxSvg(wxSun(2.8, 6) + wxCloud(1) + wxRain(15));
  return wxSvg(wxCloud(-2) + wxBolt());
}

async function fetchWeather(lat, lon) {
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`);
  if (!res.ok) throw new Error('weather fetch failed');
  const data = await res.json();
  return { tempC: data.current.temperature_2m, code: data.current.weather_code };
}

function renderWeather(w) {
  document.getElementById('weatherIcon').innerHTML = weatherIconFor(w.code);
  document.getElementById('weatherTemp').textContent = Math.round(w.tempC) + '°C';
  // Fresh weather feeds the auto-computed hydration target — refresh it if that's on.
  const profile = getProfile();
  const nutDateEl = document.getElementById('nutDate');
  if (profile && profile.autoWaterGoal && nutDateEl) {
    renderFuelWaterOrb(nutDateEl.value || todayISO());
    renderNutritionTargets();
  }
}

function getManualWeatherLocation() {
  try { return JSON.parse(localStorage.getItem('wft_weather_location')); } catch (e) { return null; }
}

function initWeatherWidget() {
  // Icon/temp open weather.com in an external tab — kept off the location-pin
  // button (a separate element right next to these) so tapping that to change
  // location doesn't also trigger a tab open.
  document.getElementById('weatherIcon').addEventListener('click', openWeatherWebsite);
  document.getElementById('weatherTemp').addEventListener('click', openWeatherWebsite);

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('wft_weather_cache')); } catch (e) { /* ignore */ }
  if (cached && Date.now() - cached.time < 30 * 60 * 1000) renderWeather(cached);

  const manualLoc = getManualWeatherLocation();
  if (manualLoc) {
    fetchWeather(manualLoc.lat, manualLoc.lon).then(w => {
      renderWeather(w);
      localStorage.setItem('wft_weather_cache', JSON.stringify({ ...w, lat: manualLoc.lat, lon: manualLoc.lon, time: Date.now() }));
    }).catch(() => {
      if (!cached) { document.getElementById('weatherIcon').textContent = '⚠️'; document.getElementById('weatherTemp').textContent = '--°'; }
    });
    return;
  }

  if (!navigator.geolocation) {
    if (!cached) { document.getElementById('weatherIcon').textContent = '❔'; document.getElementById('weatherTemp').textContent = 'N/A'; }
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      fetchWeather(lat, lon).then(w => {
        renderWeather(w);
        localStorage.setItem('wft_weather_cache', JSON.stringify({ ...w, lat, lon, time: Date.now() }));
      }).catch(() => {
        if (!cached) { document.getElementById('weatherIcon').textContent = '⚠️'; document.getElementById('weatherTemp').textContent = '--°'; }
      });
    },
    () => {
      if (!cached) { document.getElementById('weatherIcon').textContent = '📍'; document.getElementById('weatherTemp').textContent = 'Off'; }
    },
    { timeout: 8000 }
  );
}

// weather.com resolves a plain lat,lon in its "today" URL to the nearest
// named location page (confirmed via direct request — it 301s to the
// resolved locality) — no need for its internal opaque location IDs.
function openWeatherWebsite() {
  const manualLoc = getManualWeatherLocation();
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('wft_weather_cache')); } catch (e) { /* ignore */ }
  const lat = (manualLoc && manualLoc.lat) ?? (cached && cached.lat);
  const lon = (manualLoc && manualLoc.lon) ?? (cached && cached.lon);
  const url = (lat != null && lon != null)
    ? `https://weather.com/weather/today/l/${lat},${lon}`
    : 'https://weather.com/';
  window.open(url, '_blank', 'noopener');
}

async function searchWeatherLocations(query) {
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=en&format=json`);
  if (!res.ok) throw new Error('geocoding failed');
  const data = await res.json();
  return data.results || [];
}

function renderWeatherLocationResults(results) {
  const container = document.getElementById('weatherLocationResults');
  if (!results.length) { container.innerHTML = '<p class="empty-note">No matches found.</p>'; return; }
  container.innerHTML = results.map(r => {
    const label = [r.name, r.admin2, r.admin1, r.country].filter(Boolean).join(', ');
    return `<button type="button" class="weather-location-row" data-lat="${r.latitude}" data-lon="${r.longitude}" data-label="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
  }).join('');
}

function initWeatherLocationPicker() {
  const overlay = document.getElementById('weatherLocationOverlay');
  const searchInput = document.getElementById('weatherLocationSearch');
  let debounceId = null;

  document.getElementById('btnWeatherLocation').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseWeatherLocation').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceId);
    const q = searchInput.value.trim();
    if (q.length < 2) { document.getElementById('weatherLocationResults').innerHTML = ''; return; }
    debounceId = setTimeout(() => {
      searchWeatherLocations(q).then(renderWeatherLocationResults).catch(() => {
        document.getElementById('weatherLocationResults').innerHTML = '<p class="empty-note">Search failed — check your connection.</p>';
      });
    }, 400);
  });

  document.getElementById('weatherLocationResults').addEventListener('click', e => {
    const row = e.target.closest('.weather-location-row');
    if (!row) return;
    const lat = parseFloat(row.dataset.lat), lon = parseFloat(row.dataset.lon);
    localStorage.setItem('wft_weather_location', JSON.stringify({ lat, lon, label: row.dataset.label }));
    localStorage.removeItem('wft_weather_cache');
    fetchWeather(lat, lon).then(w => {
      renderWeather(w);
      localStorage.setItem('wft_weather_cache', JSON.stringify({ ...w, time: Date.now() }));
    }).catch(() => {});
    const note = document.getElementById('weatherLocationNote');
    note.textContent = `Location set to ${row.dataset.label}.`;
    setTimeout(() => { overlay.hidden = true; note.textContent = ''; }, 1200);
  });

  document.getElementById('btnWeatherLocationAuto').addEventListener('click', () => {
    localStorage.removeItem('wft_weather_location');
    localStorage.removeItem('wft_weather_cache');
    initWeatherWidget();
    overlay.hidden = true;
  });
}

/* ---------------------------------------------------------------- */
/* Bio: profile form                                                   */
/* ---------------------------------------------------------------- */
/* ---------------------------------------------------------------- */
/* Auto-computed hydration target                                      */
/* ---------------------------------------------------------------- */
const AUTO_WATER_HINT_BASE_TEXT = "Base guidance: ~2.7L/day (women) or ~3.7L/day (men) total fluid, ~80% from drinking — plus extra for your logged training/cardio, today's weather (needs location access), and any health status above.";
const HEALTH_STATUS_WATER_EXTRA_ML = { pregnant: 300, breastfeeding: 700, illness: 500 };

// ~80% of total fluid need comes from drinking water (rest from food), per the
// guidance the app targets: 2.7L/day total for women, 3.7L/day for men.
function baseWaterTargetML(profile) {
  const totalFluidNeedMl = (profile && profile.gender === 'female') ? 2700 : 3700;
  return Math.round(totalFluidNeedMl * 0.8);
}

// Strength sets: ~3 min of work+rest per completed set at ~8 mL/min sweat rate.
// Cardio: duration-based sweat rate that varies by activity intensity.
function computeWaterActivityExtraML(date) {
  const entry = getLogs()[date] || {};
  let extraMl = 0;

  const completedSets = (entry.exercises || []).reduce((sum, ex) =>
    sum + (ex.sets || []).filter(s => s.completed).length, 0);
  extraMl += completedSets * 3 * 8;

  (entry.cardioSessions || []).forEach(s => {
    const minutes = (s.durationSec || 0) / 60;
    const rateMlPerMin = s.type === 'run' ? 12 : (s.type === 'walk' ? 6 : 9);
    extraMl += minutes * rateMlPerMin;
  });

  return Math.round(extraMl);
}

function healthStatusExtraML(profile) {
  return (profile && HEALTH_STATUS_WATER_EXTRA_ML[profile.healthStatus]) || 0;
}

function weatherExtraFromTempC(tempC) {
  if (tempC == null) return 0;
  if (tempC >= 32) return 750;
  if (tempC >= 27) return 400;
  if (tempC >= 21) return 150;
  return 0;
}

// Reuses the same Open-Meteo cache the Status weather widget already
// maintains (wft_weather_cache, refreshed by initWeatherWidget on load and
// on manual location changes) rather than running a second geolocation/fetch
// flow. Returns null if no fresh (<30 min) reading is cached yet.
function getCachedWeatherTempC() {
  try {
    const cached = JSON.parse(localStorage.getItem('wft_weather_cache'));
    if (cached && Date.now() - cached.time < 30 * 60 * 1000) return cached.tempC;
  } catch (e) { /* ignore */ }
  return null;
}

function computeAutoWaterTargetML(profile, date) {
  const base = baseWaterTargetML(profile);
  const activity = computeWaterActivityExtraML(date);
  const health = healthStatusExtraML(profile);
  const weather = (date === todayISO()) ? weatherExtraFromTempC(getCachedWeatherTempC()) : 0;
  return Math.round((base + activity + health + weather) / 50) * 50;
}

function effectiveWaterTargetML(date) {
  const profile = getProfile();
  if (!profile) return 3000;
  if (profile.autoWaterGoal) return computeAutoWaterTargetML(profile, date);
  return profile.waterGoal || 3000;
}

function updateAutoWaterHint() {
  const hintEl = document.getElementById('setupAutoWaterHint');
  const draftProfile = {
    gender: document.getElementById('setupGender').value,
    healthStatus: document.getElementById('setupHealthStatus').value,
    autoWaterGoal: true,
  };
  const est = computeAutoWaterTargetML(draftProfile, todayISO());
  hintEl.textContent = `Estimated for today: ${est} mL (updates daily with your training + weather). ` + AUTO_WATER_HINT_BASE_TEXT;
}

function initSetupForm() {
  const form = document.getElementById('setupForm');
  const heightUnitSel = document.getElementById('setupHeightUnit');
  const cmField = document.getElementById('heightCmField');
  const ftInField = document.getElementById('heightFtInField');
  const weightUnitSel = document.getElementById('setupWeightUnit');

  heightUnitSel.addEventListener('change', () => {
    cmField.hidden = heightUnitSel.value !== 'cm';
    ftInField.hidden = heightUnitSel.value !== 'ftin';
  });

  weightUnitSel.addEventListener('change', () => {
    document.getElementById('setupWeightUnitLabel').textContent = weightUnitSel.value.toUpperCase();
  });

  document.getElementById('setupAutoWaterGoal').addEventListener('change', e => {
    document.getElementById('setupWaterGoal').disabled = e.target.checked;
    if (e.target.checked) updateAutoWaterHint();
    else document.getElementById('setupAutoWaterHint').textContent = AUTO_WATER_HINT_BASE_TEXT;
  });
  document.getElementById('setupHealthStatus').addEventListener('change', () => {
    if (document.getElementById('setupAutoWaterGoal').checked) updateAutoWaterHint();
  });
  document.getElementById('setupGender').addEventListener('change', () => {
    if (document.getElementById('setupAutoWaterGoal').checked) updateAutoWaterHint();
    updateHealthStatusOptions();
  });

  form.querySelectorAll('.proto-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      const input = form.querySelector(`.extraHabitInput[data-idx="${idx}"]`);
      if (input) { input.value = ''; input.focus(); }
    });
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const weightUnit = document.getElementById('setupWeightUnit').value;
    const heightUnit = heightUnitSel.value;
    let heightCm;
    if (heightUnit === 'cm') {
      heightCm = parseFloat(document.getElementById('setupHeightCm').value) || null;
    } else {
      const ft = parseFloat(document.getElementById('setupHeightFt').value) || 0;
      const inch = parseFloat(document.getElementById('setupHeightIn').value) || 0;
      heightCm = ftInToCm(ft, inch);
    }
    const startWeightRaw = parseFloat(document.getElementById('setupStartWeight').value) || null;
    const goalMinRaw = parseFloat(document.getElementById('setupGoalMin').value) || null;
    const goalTargetRaw = parseFloat(document.getElementById('setupGoalTarget').value) || null;
    const goalDreamRaw = parseFloat(document.getElementById('setupGoalDream').value) || null;

    const extraHabits = Array.from(document.querySelectorAll('.extraHabitInput')).map(i => i.value.trim());

    // Merged onto the EXISTING profile, not built from scratch — this form
    // only has fields for a subset of the profile object. Building fresh
    // was silently dropping anything set outside this form (photoDataUrl
    // from Entity Identity's own photo upload, most notably) every time
    // this form was saved.
    const profile = Object.assign({}, getProfile(), {
      name: document.getElementById('setupName').value.trim(),
      weightUnit, heightUnit, heightCm,
      gender: document.getElementById('setupGender').value,
      age: parseInt(document.getElementById('setupAge').value, 10) || null,
      startWeightKg: startWeightRaw != null ? toKg(startWeightRaw, weightUnit) : null,
      activity: document.getElementById('setupActivity').value,
      goalMode: document.getElementById('setupGoalMode').value,
      lifting: document.getElementById('setupLifting').value,
      goalMinKg: goalMinRaw != null ? toKg(goalMinRaw, weightUnit) : null,
      goalTargetKg: goalTargetRaw != null ? toKg(goalTargetRaw, weightUnit) : null,
      goalDreamKg: goalDreamRaw != null ? toKg(goalDreamRaw, weightUnit) : null,
      startDate: document.getElementById('setupStartDate').value || null,
      programDays: parseInt(document.getElementById('setupProgramDays').value, 10) || 100,
      waterGoal: parseInt(document.getElementById('setupWaterGoal').value, 10) || 3000,
      autoWaterGoal: document.getElementById('setupAutoWaterGoal').checked,
      healthStatus: document.getElementById('setupHealthStatus').value,
      stepGoal: parseInt(document.getElementById('setupStepGoal').value, 10) || 8000,
      extraHabits,
    });
    saveProfile(profile);
    document.getElementById('setupSaveNote').textContent = 'Saved.';
    setTimeout(() => { document.getElementById('setupSaveNote').textContent = ''; }, 2000);
    renderComputedTargets(profile);
    renderExtraHabitFields(profile);
    document.getElementById('bioMenstruatingField').hidden = profile.gender !== 'female';
    renderNutritionTargets();
    renderDashboard();
    renderMeasureGuide();
    updateCodeNameHint();
    updateTabDots();
    setTimeout(() => {
      const overlay = document.getElementById('entityIdentityOverlay');
      if (overlay && !overlay.hidden) overlay.hidden = true;
    }, 600);
  });
}

function updateHealthStatusOptions() {
  const isFemale = document.getElementById('setupGender').value === 'female';
  const select = document.getElementById('setupHealthStatus');
  select.querySelectorAll('option[value="pregnant"], option[value="breastfeeding"]').forEach(opt => {
    opt.hidden = !isFemale;
  });
  if (!isFemale && (select.value === 'pregnant' || select.value === 'breastfeeding')) select.value = '';
}

function loadSetupForm() {
  const p = getProfile();
  refreshEntityPhotoUI();
  if (!p) { renderExtraHabitFields({ extraHabits: [] }); return; }
  document.getElementById('setupName').value = p.name || '';
  document.getElementById('setupWeightUnit').value = p.weightUnit || 'kg';
  document.getElementById('setupWeightUnitLabel').textContent = (p.weightUnit || 'kg').toUpperCase();
  document.getElementById('setupHeightUnit').value = p.heightUnit || 'cm';
  document.getElementById('setupGender').value = p.gender || 'male';
  document.getElementById('setupAge').value = p.age || '';
  document.getElementById('heightCmField').hidden = (p.heightUnit === 'ftin');
  document.getElementById('heightFtInField').hidden = (p.heightUnit !== 'ftin');
  if (p.heightCm) {
    if (p.heightUnit === 'ftin') {
      const totalIn = cmToIn(p.heightCm);
      document.getElementById('setupHeightFt').value = Math.floor(totalIn / 12);
      document.getElementById('setupHeightIn').value = Math.round((totalIn % 12) * 10) / 10;
    } else {
      document.getElementById('setupHeightCm').value = Math.round(p.heightCm * 10) / 10;
    }
  }
  const wu = p.weightUnit || 'kg';
  if (p.startWeightKg != null) document.getElementById('setupStartWeight').value = round2(fromKg(p.startWeightKg, wu));
  document.getElementById('setupActivity').value = p.activity || '1.2';
  document.getElementById('setupGoalMode').value = p.goalMode || 'cut';
  document.getElementById('setupLifting').value = p.lifting || '3-6';
  if (p.goalMinKg != null) document.getElementById('setupGoalMin').value = round2(fromKg(p.goalMinKg, wu));
  if (p.goalTargetKg != null) document.getElementById('setupGoalTarget').value = round2(fromKg(p.goalTargetKg, wu));
  if (p.goalDreamKg != null) document.getElementById('setupGoalDream').value = round2(fromKg(p.goalDreamKg, wu));
  document.getElementById('setupStartDate').value = p.startDate || '';
  document.getElementById('setupProgramDays').value = p.programDays || 100;
  document.getElementById('setupWaterGoal').value = p.waterGoal || 3000;
  document.getElementById('setupAutoWaterGoal').checked = !!p.autoWaterGoal;
  document.getElementById('setupHealthStatus').value = p.healthStatus || '';
  updateHealthStatusOptions();
  document.getElementById('setupWaterGoal').disabled = !!p.autoWaterGoal;
  if (p.autoWaterGoal) updateAutoWaterHint(); else document.getElementById('setupAutoWaterHint').textContent = AUTO_WATER_HINT_BASE_TEXT;
  document.getElementById('setupStepGoal').value = p.stepGoal || 8000;
  (p.extraHabits || []).forEach((v, i) => {
    const el = document.querySelector(`.extraHabitInput[data-idx="${i}"]`);
    if (el) el.value = v;
  });
  document.getElementById('bioMenstruatingField').hidden = p.gender !== 'female';
  renderComputedTargets(p);
  renderExtraHabitFields(p);
}

function renderComputedTargets(profile) {
  const list = document.getElementById('computedList');
  list.innerHTML = '';
  const kg = currentWeightKg(profile);
  const bmi = computeBMI(kg, profile.heightCm);
  const targets = kg ? computeTargets(profile, kg) : null;

  const rows = [];
  if (bmi) rows.push(['BMI', bmi.toFixed(1)]);
  if (targets) {
    rows.push(['Suggested calories (cutting)', `${round0(targets.cutting[0])}–${round0(targets.cutting[1])} kcal/day`]);
    rows.push(['Suggested calories (bulking)', `${round0(targets.bulking[0])}–${round0(targets.bulking[1])} kcal/day`]);
    rows.push(['Suggested protein', `${round0(targets.protein[0])}–${round0(targets.protein[1])} g/day`]);
  }
  if (!rows.length) {
    list.innerHTML = '<p class="empty-note">Fill in age, height and starting weight to see BMI and calorie/protein targets.</p>';
    return;
  }
  rows.forEach(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    list.appendChild(dt); list.appendChild(dd);
  });
}

function renderExtraHabitFields(profile) {
  const group = document.getElementById('extraHabitsGroup');
  group.querySelectorAll('.field--checkbox').forEach(el => el.remove());
  (profile.extraHabits || []).forEach((label, i) => {
    if (!label) return;
    const wrap = document.createElement('label');
    wrap.className = 'field field--checkbox';
    wrap.innerHTML = `<input type="checkbox" id="checkinExtra${i}"><span>${escapeHtml(label)}</span>`;
    group.appendChild(wrap);
  });
}

/* ---------------------------------------------------------------- */
/* Bio: today's biometrics                                             */
/* ---------------------------------------------------------------- */
function loadBioForDate(date) {
  const profile = getProfile();
  const logs = getLogs();
  const e = logs[date] || {};

  document.getElementById('bioMenstruating').checked = !!e.menstruating;
  document.getElementById('bioPeriodDays').value = e.periodDays ?? '';
  document.getElementById('bioPeriodFlow').value = e.periodFlow || 'normal';
  document.getElementById('bioPeriodDetailsRow').hidden = !e.menstruating;
  document.getElementById('bioStress').value = e.stress ?? 3;
  document.getElementById('bioStressOut').textContent = e.stress ?? 3;
  document.getElementById('bioFatigue').value = e.fatigue ?? 3;
  document.getElementById('bioFatigueOut').textContent = e.fatigue ?? 3;
  document.getElementById('bioHunger').value = e.hunger ?? 3;
  document.getElementById('bioHungerOut').textContent = e.hunger ?? 3;
  document.getElementById('bioMenstruatingField').hidden = !profile || profile.gender !== 'female';

  document.getElementById('skinfoldDate').value = date;
  loadSkinfoldsForDate(date);
}

// Caliper Entry Data has its own date field (separate from the Bio tab's
// main Temporal Entity Log date) so past skinfold readings can be corrected
// without also jumping the stress/fatigue/period fields to that date.
function loadSkinfoldsForDate(date) {
  const logs = getLogs();
  const e = logs[date] || {};
  const skinfolds = e.skinfolds || {};
  SKINFOLD_SITES.forEach(key => {
    const input = document.getElementById('skin' + key.charAt(0).toUpperCase() + key.slice(1));
    if (input) input.value = skinfolds[key] ?? '';
  });
  renderBodyFatWidget();
}

function readSkinfoldInputs() {
  const skinfolds = {};
  SKINFOLD_SITES.forEach(key => {
    const input = document.getElementById('skin' + key.charAt(0).toUpperCase() + key.slice(1));
    const v = input ? parseFloat(input.value) : NaN;
    skinfolds[key] = isNaN(v) ? 0 : v;
  });
  return skinfolds;
}

function renderBodyFatWidget() {
  const profile = getProfile();
  const date = document.getElementById('skinfoldDate').value || todayISO();
  const skinfolds = readSkinfoldInputs();
  const sum = SKINFOLD_SITES.reduce((s, key) => s + skinfolds[key], 0);
  const age = profile ? profile.age : null;
  const gender = profile ? profile.gender : 'male';

  let pct = (sum > 0 && age) ? computeBodyFatJP7(skinfolds, age, gender) : null;
  let carriedFromDate = null;
  if (pct == null) {
    const last = findLastBodyFatEntry(date);
    if (last) {
      pct = last.bodyFatPct ?? computeBodyFatJP7(last.skinfolds, age, gender);
      if (pct != null) carriedFromDate = last.date;
    }
  }

  const cls = classifyBodyFat(pct, gender);
  document.getElementById('bodyFatEmptyNote').hidden = pct != null;
  renderRing(document.getElementById('bodyFatRing'), pct != null ? Math.min(100, Math.max(0, pct)) : 0, {
    size: 108, stroke: 8,
    centerText: pct != null ? round2(pct) + '%' : '–',
    label: 'Body Fat',
    sub: carriedFromDate ? `${cls.label} · last logged ${fmtDate(parseISO(carriedFromDate))}` : cls.label,
  });
}

// Body Fat / Edema orbs: tap to reveal the methodology note, auto-hides
// after 2 minutes, or tap the orb again to close it early.
function initBioOrbDescToggle(ringId, descId) {
  const ring = document.getElementById(ringId);
  const desc = document.getElementById(descId);
  let hideTimer = null;
  const close = () => {
    desc.hidden = true;
    ring.setAttribute('aria-expanded', 'false');
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  };
  const toggle = () => {
    if (!desc.hidden) { close(); return; }
    desc.hidden = false;
    ring.setAttribute('aria-expanded', 'true');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(close, 120000);
  };
  ring.addEventListener('click', toggle);
  ring.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
}

function initBioLog() {
  initBioOrbDescToggle('bodyFatRing', 'bodyFatDesc');
  initBioOrbDescToggle('waterRetentionOrb', 'waterRetentionDesc');
  document.getElementById('bioDate').value = todayISO();
  updateBioLogBtnLabel();
  document.getElementById('bioDate').addEventListener('change', e => {
    loadBioForDate(e.target.value);
    updateBioLogBtnLabel();
  });

  ['bioStress', 'bioFatigue', 'bioHunger'].forEach(id => {
    const input = document.getElementById(id);
    const out = document.getElementById(id + 'Out');
    input.addEventListener('input', () => { out.textContent = input.value; });
  });

  document.getElementById('bioMenstruating').addEventListener('change', e => {
    document.getElementById('bioPeriodDetailsRow').hidden = !e.target.checked;
  });

  document.getElementById('btnSaveBio').addEventListener('click', () => {
    const profile = getProfile();
    const date = document.getElementById('bioDate').value;
    updateLogFields(date, {
      menstruating: document.getElementById('bioMenstruating').checked,
      periodDays: parseInt(document.getElementById('bioPeriodDays').value, 10) || 0,
      periodFlow: document.getElementById('bioPeriodFlow').value,
      stress: parseInt(document.getElementById('bioStress').value, 10),
      fatigue: parseInt(document.getElementById('bioFatigue').value, 10),
      hunger: parseInt(document.getElementById('bioHunger').value, 10),
    });
    document.getElementById('bioSaveNote').textContent = 'Saved biometrics for ' + date;
    setTimeout(() => { document.getElementById('bioSaveNote').textContent = ''; }, 2000);
    if (profile) renderComputedTargets(profile);
    renderWaterRetentionOrb();
    if (date === todayISO()) { renderDashboard(); }
    updateTabDots();
  });

  SKINFOLD_SITES.forEach(key => {
    const input = document.getElementById('skin' + key.charAt(0).toUpperCase() + key.slice(1));
    if (input) input.addEventListener('input', renderBodyFatWidget);
  });
  document.getElementById('btnToggleCaliperEntry').addEventListener('click', () => {
    const btn = document.getElementById('btnToggleCaliperEntry');
    const panel = document.getElementById('caliperEntryPanel');
    const expanded = panel.hidden;
    panel.hidden = !expanded;
    btn.setAttribute('aria-expanded', String(expanded));
  });
  document.getElementById('skinfoldDate').addEventListener('change', e => loadSkinfoldsForDate(e.target.value));
  document.getElementById('btnSaveSkinfolds').addEventListener('click', () => {
    const date = document.getElementById('skinfoldDate').value;
    const skinfolds = readSkinfoldInputs();
    const profile = getProfile();
    const bodyFatPct = computeBodyFatJP7(skinfolds, profile ? profile.age : null, profile ? profile.gender : 'male');
    updateLogFields(date, { skinfolds, bodyFatPct: bodyFatPct != null ? round2(bodyFatPct) : null });
    document.getElementById('skinfoldSaveNote').textContent = 'Saved skinfold measurements for ' + date;
    setTimeout(() => { document.getElementById('skinfoldSaveNote').textContent = ''; }, 2500);
    renderBodyFatWidget();
    renderBodyFatHistory();
  });

  loadBioForDate(todayISO());
  renderWaterRetentionOrb();
}

/* Watson (1980) total body water formula, in liters. */
function computeWatsonTBW(profile, kg) {
  if (!profile || !kg || !profile.heightCm || !profile.age) return null;
  const cm = profile.heightCm, age = profile.age;
  if (profile.gender === 'female') {
    return -2.097 + 0.1069 * cm + 0.2466 * kg;
  }
  return 2.447 - 0.09156 * age + 0.1074 * cm + 0.3362 * kg;
}

/* Illustrative estimate, not a medical measurement:
   ((carbs_g + sodium_g) x 3) glycogen-bound water, plus 1%-5% of Watson TBW
   scaled by today's 1-5 stress/fatigue/sleep average. */
function renderWaterRetentionOrb() {
  const container = document.getElementById('waterRetentionOrb');
  if (!container) return;
  const profile = getProfile();
  const kg = profile ? currentWeightKg(profile) : null;
  const tbwLiters = kg ? computeWatsonTBW(profile, kg) : null;

  if (!tbwLiters) {
    renderRing(container, 0, {
      size: 108, stroke: 8, magenta: true,
      centerText: '–', label: 'Edema extrapolation', sub: 'Complete Bio profile to estimate',
    });
    return;
  }

  const date = todayISO();
  const entry = getLogs()[date] || {};
  const carbsG = entry.carbs || 0;
  const sodiumG = (entry.sodium || 0) / 1000;
  const glycogenWaterG = (carbsG + sodiumG) * 3;

  const avgLevel = ((entry.stress ?? 3) + (entry.fatigue ?? 3) + (entry.sleep ?? 3)) / 3;
  const pct = avgLevel; // 1-5 scale maps directly to 1%-5%
  const stateWaterG = (pct / 100) * tbwLiters * 1000;

  // Flow intensity sets the base retention estimate (mild/normal/strong), and
  // longer estimated duration nudges it up slightly — both are rough
  // self-reported references, not a clinical model.
  const PERIOD_FLOW_BONUS_G = { mild: 1000, normal: 1750, strong: 2500 };
  const periodDaysFactor = 1 + Math.min(entry.periodDays || 0, 7) * 0.05;
  const periodBonusG = (profile.gender === 'female' && entry.menstruating)
    ? Math.round((PERIOD_FLOW_BONUS_G[entry.periodFlow] ?? PERIOD_FLOW_BONUS_G.normal) * periodDaysFactor)
    : 0;

  const totalG = glycogenWaterG + stateWaterG + periodBonusG;
  const gaugePct = Math.min(100, (totalG / 3500) * 100);

  renderRing(container, gaugePct, {
    size: 108, stroke: 8, magenta: true,
    centerText: round0(totalG) + 'g', label: 'Edema extrapolation', sub: `Estimate for ${fmtDate(parseISO(date))}`,
  });
}

/* ---------------------------------------------------------------- */
/* Status: check-in form                                              */
/* ---------------------------------------------------------------- */
function initCheckin() {
  const form = document.getElementById('checkinForm');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const profile = getProfile();
    const date = todayISO();
    const extra = {};
    (profile ? profile.extraHabits || [] : []).forEach((label, i) => {
      if (!label) return;
      const el = document.getElementById('checkinExtra' + i);
      if (el) extra[i] = el.checked;
    });
    updateLogFields(date, { extra });
    document.getElementById('checkinSaveNote').textContent = 'Check-in saved.';
    setTimeout(() => { document.getElementById('checkinSaveNote').textContent = ''; }, 2000);
    renderDashboard();
  });
}

function loadCheckinForm() {
  const profile = getProfile();
  renderExtraHabitFields(profile || { extraHabits: [] });
  const date = todayISO();
  const logs = getLogs();
  const e = logs[date] || {};
  (profile ? profile.extraHabits || [] : []).forEach((label, i) => {
    if (!label) return;
    const el = document.getElementById('checkinExtra' + i);
    if (el) el.checked = !!(e.extra && e.extra[i]);
  });
}

/* ---------------------------------------------------------------- */
/* Status: quick log (Start Day / End Day / Weekend floating logs)     */
/* ---------------------------------------------------------------- */
// Populates the sheet's fields for whichever date is selected — called both
// on first open (today) and whenever the date field itself changes, so a
// previous day can be picked and edited manually rather than only today.
function loadStartDayLogFields(date) {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const e = getLogs()[date] || {};
  document.getElementById('sdlWeight').value = e.weightKg != null ? round2(fromKg(e.weightKg, wu)) : '';
  document.getElementById('sdlWeightUnitLabel').textContent = wu;
  document.getElementById('sdlSleep').value = e.sleep ?? 3;
  document.getElementById('sdlSleepOut').textContent = e.sleep ?? 3;
  document.getElementById('sdlWater250').checked = false;
  document.getElementById('sdlSaveNote').textContent = '';
  document.getElementById('btnShareFromStartDayLog').hidden = true;
}

function openStartDayLog() {
  const date = todayISO();
  document.getElementById('sdlDate').value = date;
  loadStartDayLogFields(date);
  document.getElementById('startDayLogOverlay').hidden = false;
}

function saveStartDayLog() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const date = document.getElementById('sdlDate').value || todayISO();
  const weightRaw = parseFloat(document.getElementById('sdlWeight').value);
  const partial = {
    weightKg: isNaN(weightRaw) ? null : toKg(weightRaw, wu),
    sleep: parseInt(document.getElementById('sdlSleep').value, 10),
  };
  if (document.getElementById('sdlWater250').checked) {
    const current = getLogs()[date] || {};
    partial.water = (current.water || 0) + WATER_GLASS_ML;
  }
  updateLogFields(date, partial);
  document.getElementById('sdlWater250').checked = false;
  document.getElementById('sdlSaveNote').textContent = 'Saved.';
  document.getElementById('btnShareFromStartDayLog').hidden = false;
  renderDashboard();
  if (profile) renderComputedTargets(profile);
  // Refresh the Fuel tab's own currently-selected date, not necessarily the
  // date just edited here — passing the edited date directly would make the
  // water orb silently show a past day's data while the rest of the Fuel
  // tab still shows whatever date it actually has selected.
  refreshFuelWaterViews(document.getElementById('nutDate').value || todayISO());
  renderNutritionTargets();
  renderNutritionAverages();
  if (document.getElementById('bioDate').value === date) loadBioForDate(date);
  updateTabDots();
}

// Same as loadStartDayLogFields — populates for whichever date is selected,
// called on open (today) and whenever the date field changes.
function loadEndDayLogFields(date) {
  const profile = getProfile();
  const e = getLogs()[date] || {};
  document.getElementById('edlSteps').value = e.steps ?? '';
  document.getElementById('edlWorkoutDone').checked = !!e.workoutDone;
  document.getElementById('edlFatigue').value = e.fatigue ?? 3;
  document.getElementById('edlFatigueOut').textContent = e.fatigue ?? 3;
  document.getElementById('edlStress').value = e.stress ?? 3;
  document.getElementById('edlStressOut').textContent = e.stress ?? 3;
  document.getElementById('edlHunger').value = e.hunger ?? 3;
  document.getElementById('edlHungerOut').textContent = e.hunger ?? 3;

  const calorieTarget = profile ? getEffectiveCalorieTarget(profile, date) : null;
  const effectiveCalorieTarget = calorieTarget != null
    ? Math.max(1, calorieTarget + getCalorieCarryover(date, profile))
    : null;
  document.getElementById('edlCaloriesNow').textContent = e.calories ?? 0;
  document.getElementById('edlCaloriesTarget').textContent = effectiveCalorieTarget != null ? effectiveCalorieTarget : '–';

  const kg = profile ? currentWeightKg(profile) : null;
  const targets = (profile && kg) ? computeTargets(profile, kg) : null;
  const proteinTarget = targets ? round0((targets.protein[0] + targets.protein[1]) / 2) : null;
  document.getElementById('edlProteinNow').textContent = e.protein ?? 0;
  document.getElementById('edlProteinTarget').textContent = proteinTarget != null ? proteinTarget : '–';

  document.getElementById('edlSaveNote').textContent = '';
  document.getElementById('btnShareFromEndDayLog').hidden = true;

  // Day Review, embedded here so finishing End Day Log also covers it —
  // shares the same dailyReviews storage as the standalone Settings panel.
  const review = getDailyReviews()[date] || {};
  document.getElementById('edlReviewStruggle').value = review.struggle || '';
  document.getElementById('edlReviewFix').value = review.fix || '';
  renderDailyReviewChecklist(date, 'edl');
}

function openEndDayLog() {
  const date = todayISO();
  document.getElementById('edlDate').value = date;
  loadEndDayLogFields(date);
  document.getElementById('endDayLogOverlay').hidden = false;
}

// Reminder push notifications (Start/End Day Log) deep-link into the
// matching sheet instead of just opening the app. Two delivery paths from
// the service worker: a cold-open navigates to ?openSheet=..., an
// already-open tab gets a postMessage instead (a fresh navigation would
// reload the page and lose whatever the user was doing).
function openDailyFuelStatus() {
  const tabBtn = document.querySelector('.tab-btn[data-target="nutrition"]');
  if (tabBtn) tabBtn.click();
  const card = document.getElementById('fuelStatusCard');
  if (card) setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
}

function openMeasureEntry() {
  const overlay = document.getElementById('measureEntryOverlay');
  if (overlay) overlay.hidden = false;
}

// Tapping the weekly "Progress Photo" reminder opens the device camera
// directly via a hidden capture input, rather than just opening the app —
// there's no in-app photo library, so the captured shot is handed straight
// back to the OS as a normal downloaded file (same pattern as CSV/JSON
// backups elsewhere in this app), landing in the phone's usual gallery/
// downloads instead of being stored anywhere in Winfinity itself.
function openProgressPhotoCamera() {
  const input = document.getElementById('progressPhotoCameraInput');
  if (input) input.click();
}

function initProgressPhotoCamera() {
  const input = document.getElementById('progressPhotoCameraInput');
  if (!input) return;
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = `progress-photo-${todayISO()}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    showRestToast('Progress photo saved.');
  });
}

function handleDeepLinkUrl(url) {
  try {
    const sheet = new URL(url, location.href).searchParams.get('openSheet');
    if (sheet === 'startDayLog') openStartDayLog();
    else if (sheet === 'endDayLog') openEndDayLog();
    else if (sheet === 'dailyFuel') openDailyFuelStatus();
    else if (sheet === 'measureEntry') openMeasureEntry();
    else if (sheet === 'progressPhoto') openProgressPhotoCamera();
  } catch (e) { /* ignore malformed url */ }
}

function initDeepLinkHandling() {
  handleDeepLinkUrl(location.href);
  if (location.search) history.replaceState({}, '', location.pathname);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data && event.data.type === 'DEEP_LINK') handleDeepLinkUrl(event.data.url);
    });
  }
}

/* ---------------------------------------------------------------- */
/* Home-screen widgets (Training / Outdoor Activity) — native-only.    */
/* See WidgetBridgePlugin.java + Training/OutdoorWidgetProvider.java    */
/* in capacitor-app/native-src. A widget tap can't run this app's JS    */
/* directly, so MainActivity just stashes which action was tapped;      */
/* checkPendingWidgetAction asks for it once this JS is actually ready  */
/* to act on it (on load, and again on every resume from background).   */
/* ---------------------------------------------------------------- */
function handleWidgetAction(action) {
  const trainingTabBtn = document.querySelector('.tab-btn[data-target="training"]');
  if (action === 'startTraining' || action === 'finishTraining') {
    // No single-call "finish" exists (it's a confirm()-gated flow tied to
    // whatever date/exercises are currently loaded — see btnSessionCompleted
    // in initTraining) — deliberately NOT auto-triggered from a background
    // tap. Both actions just bring the app to the Training tab so the real
    // controls (including that confirmation) are the ones actually used.
    if (trainingTabBtn) trainingTabBtn.click();
  } else if (action === 'startOutdoor') {
    if (trainingTabBtn) trainingTabBtn.click();
    if (!cardioWatchId) startCardioTracking();
  } else if (action === 'finishOutdoor') {
    if (cardioWatchId) stopCardioTracking();
  }
}

async function checkPendingWidgetAction() {
  if (!isNativeApp() || !window.Capacitor.Plugins.WidgetBridge) return;
  try {
    const { action } = await window.Capacitor.Plugins.WidgetBridge.getPendingWidgetAction();
    if (action) handleWidgetAction(action);
  } catch (e) { /* plugin unavailable — ignore */ }
}

function initWidgetActionHandling() {
  if (!isNativeApp()) return;
  checkPendingWidgetAction();
  // Covers the "app was already running, just backgrounded" case — a
  // widget tap there lands in MainActivity.onNewIntent while this JS is
  // already loaded, so re-checking as soon as the WebView is visible again
  // picks it up without waiting for a fresh page load.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkPendingWidgetAction();
  });
}

function saveEndDayLog() {
  const profile = getProfile();
  const date = document.getElementById('edlDate').value || todayISO();
  updateLogFields(date, {
    steps: parseIntOrNull(document.getElementById('edlSteps').value),
    workoutDone: document.getElementById('edlWorkoutDone').checked,
    fatigue: parseInt(document.getElementById('edlFatigue').value, 10),
    stress: parseInt(document.getElementById('edlStress').value, 10),
    hunger: parseInt(document.getElementById('edlHunger').value, 10),
  });
  const reviews = getDailyReviews();
  reviews[date] = {
    date,
    struggle: document.getElementById('edlReviewStruggle').value,
    fix: document.getElementById('edlReviewFix').value,
  };
  saveDailyReviews(reviews);

  document.getElementById('edlSaveNote').textContent = 'Saved.';
  document.getElementById('btnShareFromEndDayLog').hidden = false;
  renderDashboard();
  if (profile) renderComputedTargets(profile);
  renderWaterRetentionOrb();
  if (document.getElementById('bioDate').value === date) loadBioForDate(date);
  // Keep the standalone Settings Daily Review panel in sync if it's showing
  // the same date, since both now share the same underlying storage.
  if (document.getElementById('dailyReviewDate').value === date) loadDailyReviewForDate(date);
  updateTabDots();
}

function openWeekendLog() {
  const date = todayISO();
  const r = getReviews()[date] || {};
  document.getElementById('wlDate').value = date;
  document.getElementById('wlProgressPhoto').checked = !!r.progressPhoto;
  document.getElementById('wlMeasurement').checked = !!r.measurementDone;
  document.getElementById('wlAdjustments').value = r.adjustments || '';
  document.getElementById('wlWins').value = r.wins || '';
  document.getElementById('wlImprovements').value = r.improvements || '';
  document.querySelectorAll('.wlFocus').forEach(c => { c.checked = (r.focus || []).includes(c.value); });
  document.getElementById('wlOther').value = r.other || '';
  document.getElementById('wlSaveNote').textContent = '';
  document.getElementById('btnShareFromWeekendLog').hidden = true;
  document.getElementById('weekendLogOverlay').hidden = false;
}

function saveWeekendLog() {
  const date = document.getElementById('wlDate').value || todayISO();
  const reviews = getReviews();
  const focus = Array.from(document.querySelectorAll('.wlFocus')).filter(c => c.checked).map(c => c.value);
  reviews[date] = {
    date,
    progressPhoto: document.getElementById('wlProgressPhoto').checked,
    measurementDone: document.getElementById('wlMeasurement').checked,
    adjustments: document.getElementById('wlAdjustments').value,
    wins: document.getElementById('wlWins').value,
    improvements: document.getElementById('wlImprovements').value,
    focus,
    other: document.getElementById('wlOther').value,
  };
  saveReviews(reviews);
  document.getElementById('wlSaveNote').textContent = 'Saved review for week ending ' + date;
  document.getElementById('btnShareFromWeekendLog').hidden = false;
  renderDashboard();
  updateTabDots();
}

function initQuickLogLaunchers() {
  document.getElementById('btnOpenStartDayLog').addEventListener('click', openStartDayLog);
  document.getElementById('btnCloseStartDayLog').addEventListener('click', () => { document.getElementById('startDayLogOverlay').hidden = true; });
  document.getElementById('startDayLogOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  document.getElementById('sdlSleep').addEventListener('input', e => { document.getElementById('sdlSleepOut').textContent = e.target.value; });
  document.getElementById('sdlDate').addEventListener('change', e => loadStartDayLogFields(e.target.value || todayISO()));
  document.getElementById('btnSaveStartDayLog').addEventListener('click', saveStartDayLog);
  document.getElementById('btnShareFromStartDayLog').addEventListener('click', () => {
    document.getElementById('startDayLogOverlay').hidden = true;
    openAssessmentOverlay();
  });

  document.getElementById('btnOpenEndDayLog').addEventListener('click', openEndDayLog);
  document.getElementById('btnCloseEndDayLog').addEventListener('click', () => { document.getElementById('endDayLogOverlay').hidden = true; });
  document.getElementById('endDayLogOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  ['edlFatigue', 'edlStress', 'edlHunger'].forEach(id => {
    document.getElementById(id).addEventListener('input', e => { document.getElementById(id + 'Out').textContent = e.target.value; });
  });
  document.getElementById('edlDate').addEventListener('change', e => loadEndDayLogFields(e.target.value || todayISO()));
  document.getElementById('btnSaveEndDayLog').addEventListener('click', saveEndDayLog);
  document.getElementById('btnShareFromEndDayLog').addEventListener('click', () => {
    document.getElementById('endDayLogOverlay').hidden = true;
    openAssessmentOverlay();
  });

  document.getElementById('btnOpenWeekendLog').addEventListener('click', openWeekendLog);
  document.getElementById('btnCloseWeekendLog').addEventListener('click', () => { document.getElementById('weekendLogOverlay').hidden = true; });
  document.getElementById('weekendLogOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
  document.getElementById('btnSaveWeekendLog').addEventListener('click', saveWeekendLog);
  document.getElementById('btnShareFromWeekendLog').addEventListener('click', () => {
    document.getElementById('weekendLogOverlay').hidden = true;
    openAssessmentOverlay();
  });
}

/* ---------------------------------------------------------------- */
/* Status: extra Quick Log popups (Training Log, Fuel Log, Community) */
/* ---------------------------------------------------------------- */

// Training Log reparents the Training tab's own session-template +
// protocol-queue block into a floating popup instead of duplicating it —
// same live elements, same IDs, so all existing add/finish/template logic
// keeps working untouched. Forced to today's date; whatever date the
// Training tab itself had selected is restored on close.
let trainingLogQuickPrevDate = null;

function openTrainingLogQuickPopup() {
  trainingLogQuickPrevDate = document.getElementById('trainDate').value;
  const today = todayISO();
  document.getElementById('trainDate').value = today;
  loadTrainingForDate(today);
  document.getElementById('trainingLogQuickMount').appendChild(document.getElementById('quickTrainingLogBlock'));
  document.getElementById('trainingLogQuickOverlay').hidden = false;
}

function closeTrainingLogQuickPopup() {
  document.getElementById('trainingLogQuickOverlay').hidden = true;
  document.getElementById('quickTrainingLogAnchor').after(document.getElementById('quickTrainingLogBlock'));
  if (trainingLogQuickPrevDate) {
    document.getElementById('trainDate').value = trainingLogQuickPrevDate;
    loadTrainingForDate(trainingLogQuickPrevDate);
  }
  trainingLogQuickPrevDate = null;
}

function initTrainingLogQuickPopup() {
  document.getElementById('btnOpenTrainingLogQuick').addEventListener('click', openTrainingLogQuickPopup);
  document.getElementById('btnCloseTrainingLogQuick').addEventListener('click', closeTrainingLogQuickPopup);
  bindOverlayBackdropClose(document.getElementById('trainingLogQuickOverlay'), closeTrainingLogQuickPopup);
}

// Fuel Log opens the existing Dietary Algorithm overlay directly, locked to
// today (date nav hidden) since this is a same-day quick shortcut. Opening
// it the normal way (Fuel tab's own button) still shows the date nav so
// past days remain reachable there.
function openFuelLogQuickPopup() {
  const overlay = document.getElementById('foodDiaryOverlay');
  const dateInput = document.getElementById('foodDiaryDateInput');
  const today = todayISO();
  dateInput.value = today;
  overlay.querySelector('.food-diary-date-nav').hidden = true;
  editingMealItem = null;
  renderFoodDiary(today);
  overlay.hidden = false;
}

function initFuelLogQuickPopup() {
  document.getElementById('btnOpenFuelLogQuick').addEventListener('click', openFuelLogQuickPopup);
  // Normal Fuel-tab entry point should always show the date nav, even if
  // the quick popup hid it during a previous use.
  document.getElementById('btnOpenFoodDiary').addEventListener('click', () => {
    document.getElementById('foodDiaryOverlay').querySelector('.food-diary-date-nav').hidden = false;
  });
}

// Community reparents the chat card (plus its fixed-position user/reaction
// menus, which would otherwise stay trapped inside the hidden Nexus tab)
// into a floating popup, expanded via the same button the Nexus tab uses.
function openCommunityQuickPopup() {
  document.getElementById('communityQuickMount').appendChild(document.getElementById('quickCommunityBlock'));
  document.getElementById('communityQuickOverlay').hidden = false;
  if (!document.getElementById('chatCard').classList.contains('is-expanded')) {
    document.getElementById('btnChatExpand').click();
  }
}

function closeCommunityQuickPopup() {
  document.getElementById('communityQuickOverlay').hidden = true;
  document.getElementById('quickCommunityAnchor').after(document.getElementById('quickCommunityBlock'));
}

function initCommunityQuickPopup() {
  document.getElementById('btnOpenCommunityQuick').addEventListener('click', openCommunityQuickPopup);
  document.getElementById('btnCloseCommunityQuick').addEventListener('click', closeCommunityQuickPopup);
  bindOverlayBackdropClose(document.getElementById('communityQuickOverlay'), closeCommunityQuickPopup);
}

/* ---------------------------------------------------------------- */
/* Status: body measurement scan                                       */
/* ---------------------------------------------------------------- */
function renderMeasureGuide() {
  const profile = getProfile();
  const gender = profile ? profile.gender : 'male';
  const src = gender === 'female' ? 'icons/measure-guide-female.jpg' : 'icons/measure-guide-male.jpg';
  document.getElementById('measureGuide').innerHTML = `<img src="${src}" alt="${gender === 'female' ? 'Female' : 'Male'} measurement slice guide">`;
  document.getElementById('hipsField').hidden = gender !== 'female';
}

function loadMeasurementsForDate(date) {
  const logs = getLogs();
  const m = (logs[date] && logs[date].measurements) || {};
  document.getElementById('measureChest').value = m.chest ?? '';
  document.getElementById('measureShoulder').value = m.shoulder ?? '';
  document.getElementById('measureLBicep').value = m.lBicep ?? '';
  document.getElementById('measureRBicep').value = m.rBicep ?? '';
  document.getElementById('measureAbdSupra').value = m.abdSupra ?? '';
  document.getElementById('measureStomach').value = m.stomach ?? '';
  document.getElementById('measureAbdInfra').value = m.abdInfra ?? '';
  document.getElementById('measureHips').value = m.hips ?? '';
  document.getElementById('measureLThigh').value = m.lThigh ?? '';
  document.getElementById('measureRThigh').value = m.rThigh ?? '';
  document.getElementById('measureLCalf').value = m.lCalf ?? '';
  document.getElementById('measureRCalf').value = m.rCalf ?? '';
}

function initMeasurements() {
  renderMeasureGuide();
  document.getElementById('measureDate').value = todayISO();
  document.getElementById('measureDate').addEventListener('change', e => loadMeasurementsForDate(e.target.value));

  document.getElementById('btnSaveMeasurements').addEventListener('click', () => {
    const date = document.getElementById('measureDate').value;
    const val = id => {
      const n = parseFloat(document.getElementById(id).value);
      return isNaN(n) ? null : Math.round(n * 10) / 10;
    };
    updateLogFields(date, {
      measurements: {
        chest: val('measureChest'),
        shoulder: val('measureShoulder'),
        lBicep: val('measureLBicep'),
        rBicep: val('measureRBicep'),
        abdSupra: val('measureAbdSupra'),
        stomach: val('measureStomach'),
        abdInfra: val('measureAbdInfra'),
        hips: val('measureHips'),
        lThigh: val('measureLThigh'),
        rThigh: val('measureRThigh'),
        lCalf: val('measureLCalf'),
        rCalf: val('measureRCalf'),
      },
    });
    renderMeasureHistory();
    const note = document.getElementById('measureSaveNote');
    note.textContent = 'Saved measurements for ' + date;
    setTimeout(() => {
      note.textContent = '';
      const overlay = document.getElementById('measureEntryOverlay');
      if (overlay && !overlay.hidden) overlay.hidden = true;
    }, 900);
  });

  loadMeasurementsForDate(todayISO());
}

function initMeasureEntryOverlay() {
  const overlay = document.getElementById('measureEntryOverlay');
  document.getElementById('btnOpenMeasureEntry').addEventListener('click', () => { overlay.hidden = false; });
  document.getElementById('btnCloseMeasureEntry').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
}

function initEntityIdentityOverlay() {
  const overlay = document.getElementById('entityIdentityOverlay');
  document.getElementById('btnOpenEntityIdentity').addEventListener('click', () => { overlay.hidden = false; refreshEntityPhotoUI(); });
  document.getElementById('btnCloseEntityIdentity').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
}

// Entity Identity profile photo — center-cropped to a small square JPEG so
// it stays cheap to store in localStorage and in the synced profile blob.
// Locked until the auto-seeded 7-day sample data is gone (isDemoDataActive)
// so a brand-new user isn't personalizing a profile that's about to be
// wiped by "Clear all data" or the 7-day demo-expiry sweep.
function resizeAvatarImage(file) {
  const AVATAR_DIM = 320;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_DIM; canvas.height = AVATAR_DIM;
        canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, AVATAR_DIM, AVATAR_DIM);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Profile cover photo — downscaled only (never force-cropped), since the
// user drags to choose their own vertical focal point afterward (see the
// pointer-drag wiring in initDesktopShell). The chosen point is saved
// separately as profile.coverPhotoPosY (0-100) and applied via CSS
// background-position, same idea as Facebook's cover-photo repositioning.
function resizeCoverImageFull(file) {
  // Capped lower than the original 1600px/0.85 — that combination could
  // push the base64 payload (this rides inside the same profile jsonb
  // blob as the avatar photo, sent as a single RPC argument) large enough
  // to fail silently against a request-size limit, which is exactly what
  // made "Save Position" look like it worked but never actually persisted.
  const MAX_W = 960;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_W) { height = Math.round(height * (MAX_W / width)); width = MAX_W; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function wdsSetAvatarVisual(el, photoDataUrl, initial) {
  if (!el) return;
  if (photoDataUrl) {
    el.style.backgroundImage = `url(${photoDataUrl})`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = initial || '–';
  }
}

function refreshEntityPhotoUI() {
  const preview = document.getElementById('setupPhotoPreview');
  const uploadBtn = document.getElementById('btnSetupPhotoUpload');
  const removeBtn = document.getElementById('btnSetupPhotoRemove');
  const lockHint = document.getElementById('setupPhotoLockHint');
  if (!preview) return;
  const p = getProfile();
  const initial = ((p && p.name) || '').trim().charAt(0).toUpperCase() || '–';
  wdsSetAvatarVisual(preview, p && p.photoDataUrl, initial);
  removeBtn.hidden = !(p && p.photoDataUrl);
  const locked = isDemoDataActive();
  uploadBtn.disabled = locked;
  lockHint.hidden = !locked;
}

function initEntityPhotoUpload() {
  const uploadBtn = document.getElementById('btnSetupPhotoUpload');
  const removeBtn = document.getElementById('btnSetupPhotoRemove');
  const input = document.getElementById('setupPhotoInput');
  const noteEl = document.getElementById('setupPhotoNote');
  uploadBtn.addEventListener('click', () => { if (!uploadBtn.disabled) input.click(); });
  // Web sync only ever pushes to the server when "Sync Now" is tapped —
  // a photo saved locally otherwise never reaches the desktop dashboard
  // until the user remembers to sync separately. Auto-push here (best
  // effort, only when sync is already enabled) closes that gap.
  const autoSyncIfEnabled = async () => {
    if (localStorage.getItem('wft_web_sync_enabled') !== '1') return;
    try { await pushWebSyncSnapshot(); } catch (e) { /* best effort — Sync Now still works as a fallback */ }
    // Also mirror the photo onto leaderboard's public-safe avatar column —
    // the private profile blob (pushed above) never leaves web_sync_accounts,
    // but Friends cards/feed avatars need SOMETHING public to show for
    // other people, not just initials.
    if (sbConfigured()) {
      try {
        await sb.rpc('set_leaderboard_avatar', {
          p_share_key: getOrCreateShareKey(),
          p_avatar_data_url: (getProfile() || {}).photoDataUrl || null,
        });
      } catch (e) { /* best effort */ }
    }
  };
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const dataUrl = await resizeAvatarImage(file);
      const p = getProfile() || {};
      p.photoDataUrl = dataUrl;
      saveProfile(p);
      refreshEntityPhotoUI();
      noteEl.textContent = 'Saved.';
      setTimeout(() => { noteEl.textContent = ''; }, 2000);
      await autoSyncIfEnabled();
    } catch (e) {
      noteEl.textContent = (e && e.message) || 'Could not save that photo.';
    }
  });
  removeBtn.addEventListener('click', async () => {
    const p = getProfile() || {};
    delete p.photoDataUrl;
    saveProfile(p);
    refreshEntityPhotoUI();
    await autoSyncIfEnabled();
  });
}

/* ---------------------------------------------------------------- */
/* Status: dashboard rendering                                         */
/* ---------------------------------------------------------------- */
function renderStepsCaloriesChart() {
  const profile = getProfile();
  const stepGoal = getEffectiveStepGoal(profile);
  const calorieTarget = getEffectiveCalorieTarget(profile) || 2000;

  const logsArr = sortedLogsArray();
  const MAX_SCALE = 130; // % of goal a bar can visually reach before being capped
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const entry = logsArr.find(l => l.date === iso);
    const stepsPct = entry && entry.steps != null ? (entry.steps / stepGoal) * 100 : 0;
    const calPct = entry && entry.calories != null ? (entry.calories / calorieTarget) * 100 : 0;
    days.push({ dateObj: d, stepsPct, calPct });
  }

  const container = document.getElementById('stepsCaloriesChart');
  const labels = document.getElementById('stepsCaloriesLabels');
  container.innerHTML = ''; labels.innerHTML = '';
  // Bars are capped at MAX_SCALE% of goal visually; anything past 100% of
  // goal renders as a second, differently-colored segment stacked on top of
  // the base bar so going over the target is obvious at a glance instead of
  // just blending into a taller bar of the same color.
  const buildBar = (modifierClass, pct, title) => {
    const bar = document.createElement('div');
    bar.className = 'dual-bar ' + modifierClass;
    bar.title = title;
    const base = document.createElement('div');
    base.className = 'dual-bar-base';
    base.style.height = `${(Math.min(100, pct) / MAX_SCALE) * 100}%`;
    bar.appendChild(base);
    if (pct > 100) {
      const over = document.createElement('div');
      over.className = 'dual-bar-over';
      over.style.height = `${(Math.min(MAX_SCALE, pct) - 100) / MAX_SCALE * 100}%`;
      bar.appendChild(over);
    }
    return bar;
  };

  days.forEach(d => {
    const col = document.createElement('div');
    col.className = 'dual-bar-day';

    const stepsBar = buildBar('dual-bar--steps', d.stepsPct, `Steps: ${round0(d.stepsPct)}% of daily goal`);
    const calBar = buildBar('dual-bar--calories', d.calPct, `Calories: ${round0(d.calPct)}% of daily target`);

    col.appendChild(stepsBar);
    col.appendChild(calBar);
    container.appendChild(col);

    const lbl = document.createElement('span');
    lbl.textContent = d.dateObj.toLocaleDateString(undefined, { weekday: 'narrow' });
    labels.appendChild(lbl);
  });
}



// Only shrinks when the name would actually overflow its line (short names
// stay at the normal 90%-scaled size) — text width scales linearly with
// font-size for a given string, so one measurement is enough to compute
// the exact ratio needed, no iterative loop required.
function fitHeroNameToWidth() {
  const el = document.getElementById('heroName');
  const container = el.closest('.hero-title');
  if (!el || !container) return;
  el.style.fontSize = '';
  const maxWidth = container.clientWidth;
  const naturalWidth = el.scrollWidth;
  if (maxWidth > 0 && naturalWidth > maxWidth) {
    const currentSize = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = (currentSize * (maxWidth / naturalWidth) * 0.96) + 'px';
  }
}

function renderDashboard() {
  const profile = getProfile();
  const logsArr = sortedLogsArray();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';

  document.getElementById('heroName').textContent = (profile && profile.name) ? profile.name : 'Operator';
  fitHeroNameToWidth();

  if (profile && profile.startDate) {
    const start = parseISO(profile.startDate);
    const total = profile.programDays || 100;
    const elapsed = Math.max(0, Math.min(total, daysBetween(new Date(start), new Date())));
    document.getElementById('daysLeftValue').textContent = `${elapsed} / ${total}`;
  } else {
    document.getElementById('daysLeftValue').textContent = '–';
  }

  const today = todayISO();
  const todayEntry = getLogs()[today];

  const habit = computeHabitCompletion(profile, todayEntry);
  renderRing(document.getElementById('ringHabitCard'), habit.pct, {
    size: 140, stroke: 9, modTag: 'MOD_HABIT_01', centerText: habit.pct + '%', label: 'Habit completion', sub: `${habit.done}/${habit.total} today`,
  });

  const waterGoal = (profile && profile.waterGoal) || 3000;
  const waterToday = (todayEntry && todayEntry.water != null) ? todayEntry.water : 0;
  const waterPct = waterGoal > 0 ? (waterToday / waterGoal) * 100 : 0;

  const calorieTarget = getEffectiveCalorieTarget(profile) || 2000;
  const caloriesToday = (todayEntry && todayEntry.calories != null) ? todayEntry.calories : 0;
  const caloriePct = calorieTarget > 0 ? (caloriesToday / calorieTarget) * 100 : 0;

  const kgForFuel = currentWeightKg(profile);
  const targetsForFuel = (profile && kgForFuel) ? computeTargets(profile, kgForFuel) : null;
  const proteinTarget = targetsForFuel ? round0((targetsForFuel.protein[0] + targetsForFuel.protein[1]) / 2) : null;
  const proteinToday = (todayEntry && todayEntry.protein != null) ? todayEntry.protein : 0;
  const proteinPct = proteinTarget ? (proteinToday / proteinTarget) * 100 : 0;

  const lifeFuelPct = Math.round((Math.min(100, waterPct) + Math.min(100, caloriePct) + Math.min(100, proteinPct)) / 3);
  const fuelMetCount = [waterPct, caloriePct, proteinPct].filter(p => p >= 100).length;
  renderRing(document.getElementById('ringHydrationCard'), lifeFuelPct, {
    size: 140, stroke: 9, magenta: true, modTag: 'MOD_FUEL_02', centerText: lifeFuelPct + '%', label: 'Life Fuel', sub: `${fuelMetCount}/3 today`,
  });

  document.getElementById('avgSteps').textContent = fmtOrDash(avgOfLastNDays(logsArr, 'steps', 7), v => round0(v));
  const kgNow = currentWeightKg(profile);
  const bmi = profile ? computeBMI(kgNow, profile.heightCm) : null;
  document.getElementById('currentBMI').textContent = bmi ? bmi.toFixed(1) : '–';

  const adjTile = document.getElementById('adjustedBmiTile');
  const adjusted = (profile && bmi) ? computeAdjustedBMI(profile, bmi, logsArr) : null;
  if (adjusted) {
    adjTile.hidden = false;
    document.getElementById('adjustedBMI').textContent = adjusted.adjustedBMI.toFixed(1);
  } else {
    adjTile.hidden = true;
    adjTile.setAttribute('aria-expanded', 'false');
    document.getElementById('adjustedBmiHint').hidden = true;
  }

  const trendSeries = computeTrendSeries(logsArr);
  ['7', '14', '21'].forEach(n => {
    const delta = trendDeltaDaysAgo(trendSeries, parseInt(n, 10));
    const el = document.getElementById('delta' + n);
    if (delta == null) { el.textContent = '–'; return; }
    const val = wu === 'lb' ? kgToLb(delta) : delta;
    const sign = val > 0 ? '+' : '';
    el.textContent = sign + round2(val) + ' ' + wu;
  });

  const perfGrid = document.getElementById('perfGrid');
  perfGrid.innerHTML = '';
  const perfItems = [
    ['Sleep quality', avgOfLastNDays(logsArr, 'sleep', 7), 'sleep'],
    ['Stress', avgOfLastNDays(logsArr, 'stress', 7), 'stress'],
    ['Fatigue', avgOfLastNDays(logsArr, 'fatigue', 7), 'fatigue'],
    ['Hunger', avgOfLastNDays(logsArr, 'hunger', 7), 'hunger'],
  ];
  perfItems.forEach(([label, val, field]) => {
    const status = statusForLevel(field, val);
    const days = last7DailyValues(field);
    const bars = days.map((v, i) => {
      const h = v != null ? Math.max(6, Math.round((v / 5) * 100)) : 4;
      const dayStatus = statusForLevel(field, v);
      const today = i === days.length - 1;
      return `<div class="perf-spark-bar status-${dayStatus}${today ? ' is-today' : ''}" style="height:${h}%"></div>`;
    }).join('');
    const tile = document.createElement('div');
    tile.className = 'perf-tile';
    tile.innerHTML = `<div class="perf-tile-head">
        <span class="perf-tile-label">${label}</span>
        <span class="perf-tile-value"><span class="status-dot status-${status}"></span>${labelForLevel(field, val)}</span>
      </div>
      <div class="perf-spark">${bars}</div>`;
    perfGrid.appendChild(tile);
  });

  renderWeightChart(trendSeries, wu);
  renderGoalProgress(profile, kgNow, wu, logsArr);
  renderStepsCaloriesChart();
}

/* ---- Weight chart (SVG, hover tooltip) ---- */
let weightChartFullJourney = false;

function renderWeightChart(fullSeries, wu) {
  // "Show recent" previews just the current day plus the 6 days before it
  // (7 days total); "Full journey" shows everything since day one. Both
  // modes plot the same two lines (actual + trend) — axes auto-fit to
  // whichever window is showing.
  const series = weightChartFullJourney ? fullSeries : fullSeries.slice(-7);
  const container = document.getElementById('weightChart');
  const legend = document.getElementById('chartLegend');
  const emptyNote = document.getElementById('chartEmptyNote');
  container.innerHTML = '';
  legend.innerHTML = '';
  document.getElementById('chartRange').textContent = series.length ? `${series.length} entries` : '';

  if (series.length < 1) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  const W = 600, H = 260, padL = 40, padR = 14, padT = 14, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const displayVals = series.map(p => fromKg(p.actualKg, wu));
  const trendVals = series.map(p => fromKg(p.trendKg, wu));
  const allVals = displayVals.concat(trendVals);
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;

  const xFor = i => padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const yFor = v => padT + plotH - ((v - min) / (max - min)) * plotH;

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const v = min + (g / gridCount) * (max - min);
    const y = yFor(v);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--gridline)'); line.setAttribute('stroke-width', '1');
    svg.appendChild(line);
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', 4); label.setAttribute('y', y + 3);
    label.setAttribute('font-size', '9'); label.setAttribute('fill', 'var(--text-muted)');
    label.textContent = round2(v);
    svg.appendChild(label);
  }

  [0, Math.floor((series.length - 1) / 2), series.length - 1].forEach(i => {
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', xFor(i));
    label.setAttribute('y', H - 6);
    label.setAttribute('font-size', '9');
    label.setAttribute('fill', 'var(--text-muted)');
    label.setAttribute('text-anchor', i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle');
    label.textContent = fmtDate(series[i].dateObj);
    svg.appendChild(label);
  });

  if (series.length > 1) {
    const trendPath = trendVals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ');
    const tp = document.createElementNS(svgNS, 'path');
    tp.setAttribute('d', trendPath);
    tp.setAttribute('fill', 'none');
    tp.setAttribute('stroke', 'var(--series-2)');
    tp.setAttribute('stroke-width', '2');
    tp.setAttribute('stroke-dasharray', '5 4');
    svg.appendChild(tp);
  }

  if (series.length > 1) {
    const actualPath = displayVals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ');
    const ap = document.createElementNS(svgNS, 'path');
    ap.setAttribute('d', actualPath);
    ap.setAttribute('fill', 'none');
    ap.setAttribute('stroke', 'var(--series-1)');
    ap.setAttribute('stroke-width', '2.5');
    ap.setAttribute('stroke-linejoin', 'round');
    ap.setAttribute('stroke-linecap', 'round');
    ap.style.filter = 'drop-shadow(0 0 4px var(--cyan-glow))';
    svg.appendChild(ap);
  }

  const lowestIdx = displayVals.indexOf(Math.min(...displayVals));
  displayVals.forEach((v, i) => {
    const isLowest = i === lowestIdx;
    const c = document.createElementNS(svgNS, 'circle');
    c.setAttribute('cx', xFor(i)); c.setAttribute('cy', yFor(v));
    c.setAttribute('r', (isLowest ? 1.4 : 1) * (series.length > 40 ? 2 : 3.5));
    c.setAttribute('fill', isLowest ? 'var(--warning)' : 'var(--series-1)');
    if (isLowest) c.style.filter = 'drop-shadow(0 0 4px var(--warning))';
    svg.appendChild(c);
  });

  const crosshair = document.createElementNS(svgNS, 'line');
  crosshair.setAttribute('y1', padT); crosshair.setAttribute('y2', H - padB);
  crosshair.setAttribute('stroke', 'var(--baseline)'); crosshair.setAttribute('stroke-width', '1');
  crosshair.setAttribute('visibility', 'hidden');
  svg.appendChild(crosshair);

  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  container.appendChild(tooltip);

  const hitArea = document.createElementNS(svgNS, 'rect');
  hitArea.setAttribute('x', padL); hitArea.setAttribute('y', padT);
  hitArea.setAttribute('width', plotW); hitArea.setAttribute('height', plotH);
  hitArea.setAttribute('fill', 'transparent');
  svg.appendChild(hitArea);

  function showAt(i) {
    const x = xFor(i);
    crosshair.setAttribute('x1', x); crosshair.setAttribute('x2', x);
    crosshair.setAttribute('visibility', 'visible');
    const pt = series[i];
    tooltip.innerHTML = `<strong>${fmtDate(pt.dateObj)}</strong><br>Weight: ${round2(fromKg(pt.actualKg, wu))} ${wu}<br>Trend: ${round2(fromKg(pt.trendKg, wu))} ${wu}`;
    tooltip.style.display = 'block';
    const containerWidth = container.clientWidth || W;
    const pxX = (x / W) * containerWidth;
    const tooltipWidth = tooltip.offsetWidth;
    let left = pxX + 8;
    if (left + tooltipWidth > containerWidth) left = pxX - tooltipWidth - 8;
    if (left < 4) left = 4;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = '4px';
  }
  function hideTooltip() {
    crosshair.setAttribute('visibility', 'hidden');
    tooltip.style.display = 'none';
  }
  function pointerToIndex(evt) {
    const rect = svg.getBoundingClientRect();
    const relX = ((evt.clientX - rect.left) / rect.width) * W;
    let closest = 0, closestDist = Infinity;
    series.forEach((_, i) => {
      const d = Math.abs(xFor(i) - relX);
      if (d < closestDist) { closestDist = d; closest = i; }
    });
    return closest;
  }
  // Press-and-hold (works for both touch and mouse) instead of hover-only —
  // details for any point stay hidden until pressed, and disappear on
  // release. Disabled in the full-journey view (see weightChartFullJourney
  // below) since that series can be long enough to make per-point touch
  // targets impractical.
  if (!weightChartFullJourney) {
    let pressed = false;
    svg.addEventListener('pointerdown', evt => {
      pressed = true;
      svg.setPointerCapture(evt.pointerId);
      showAt(pointerToIndex(evt));
    });
    svg.addEventListener('pointermove', evt => { if (pressed) showAt(pointerToIndex(evt)); });
    const release = () => { pressed = false; hideTooltip(); };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
    svg.addEventListener('pointerleave', () => { if (!pressed) hideTooltip(); });
  }

  legend.innerHTML = `<span><span class="legend-swatch" style="background:var(--series-1)"></span>Actual weight</span>
    <span><span class="legend-dash"></span>Trend (7-day avg)</span>
    <button type="button" id="chartFullJourneyToggle" class="chart-toggle-link">${weightChartFullJourney ? 'Show recent' : 'Full journey'}</button>`;
}

function initWeightChartToggle() {
  document.getElementById('chartLegend').addEventListener('click', e => {
    if (e.target.closest('#chartFullJourneyToggle')) {
      weightChartFullJourney = !weightChartFullJourney;
      renderDashboard();
    }
  });
  document.getElementById('btnShareWeightJourney').addEventListener('click', shareWeightJourney);
  document.getElementById('btnShareRecentPerformance').addEventListener('click', shareRecentPerformance);
}

/* ---- Goal progress bar ---- */
function renderGoalProgress(profile, kgNow, wu, logsArr) {
  const card = document.getElementById('goalProgressCard');
  const emptyNote = document.getElementById('goalEmptyNote');
  card.querySelectorAll('.goal-track, .goal-now-lowest-row').forEach(el => el.remove());

  if (!profile || kgNow == null || profile.goalTargetKg == null) {
    emptyNote.hidden = false;
    return;
  }
  emptyNote.hidden = true;

  const lowestKg7d = logsArr ? minOfLastNDays(logsArr, 'weightKg', 7) : null;

  const points = [
    { label: 'Start', kg: profile.startWeightKg },
    { label: 'Min goal', kg: profile.goalMinKg },
    { label: 'Target', kg: profile.goalTargetKg },
    { label: 'Dream', kg: profile.goalDreamKg },
  ].filter(p => p.kg != null);

  const allKg = points.map(p => p.kg).concat([kgNow]);
  if (lowestKg7d != null) allKg.push(lowestKg7d);
  let min = Math.min(...allKg), max = Math.max(...allKg);
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const pctFor = kg => ((kg - min) / range) * 100;

  const track = document.createElement('div');
  track.className = 'goal-track';

  const startPct = points.length ? pctFor(points[0].kg) : 0;
  const nowPct = pctFor(kgNow);
  const fill = document.createElement('div');
  fill.className = 'goal-fill';
  fill.style.left = Math.min(startPct, nowPct) + '%';
  fill.style.width = Math.abs(nowPct - startPct) + '%';
  track.appendChild(fill);

  points.forEach(p => {
    const marker = document.createElement('div');
    marker.className = 'goal-marker';
    marker.style.left = pctFor(p.kg) + '%';
    marker.textContent = `${p.label}: ${round2(fromKg(p.kg, wu))}${wu}`;
    track.appendChild(marker);
  });

  card.appendChild(track);

  // Now/Lowest render as a plain justified row below the track rather than
  // positioned at their weight's % point on the scale — pinning them to the
  // scale meant a value near either end pushed the (centered, nowrap) label
  // straight past the card's edge instead of just clipping gracefully.
  const summaryRow = document.createElement('div');
  summaryRow.className = 'goal-now-lowest-row';
  const now = document.createElement('span');
  now.className = 'goal-now';
  now.textContent = `Now: ${round2(fromKg(kgNow, wu))}${wu}`;
  summaryRow.appendChild(now);
  if (lowestKg7d != null) {
    const lowest = document.createElement('span');
    lowest.className = 'goal-lowest';
    lowest.textContent = `Lowest (7d): ${round2(fromKg(lowestKg7d, wu))}${wu}`;
    summaryRow.appendChild(lowest);
  }
  card.appendChild(summaryRow);
}

/* ---------------------------------------------------------------- */
/* Training: Strong-style exercise log + rest timer                    */
/* ---------------------------------------------------------------- */
let currentExercises = [];

function loadTrainingForDate(date) {
  const logs = getLogs();
  currentExercises = (logs[date] && logs[date].exercises) ? JSON.parse(JSON.stringify(logs[date].exercises)) : [];
  renderExerciseCards();
  const label = document.getElementById('trainDateLabel');
  if (label) label.textContent = fmtDate(parseISO(date));
}

function persistExercises() {
  const date = document.getElementById('trainDate').value;
  const completedCount = currentExercises.reduce((n, ex) => n + ex.sets.filter(s => s.completed).length, 0);
  updateLogFields(date, { exercises: JSON.parse(JSON.stringify(currentExercises)), workout: completedCount > 0 });
  markTrainingActivity();
  if (date === todayISO()) updateTabDots();
}

function markTrainingActivity() {
  localStorage.setItem('wft_train_last_activity', Date.now().toString());
  localStorage.removeItem('wft_train_idle_notified');
}

function checkTrainingIdle() {
  const dateEl = document.getElementById('trainDate');
  if (!dateEl) return;
  const date = dateEl.value;
  if (!currentExercises.length || isSessionFinished(date)) return;
  const last = parseInt(localStorage.getItem('wft_train_last_activity'), 10);
  if (!last) return;
  const idleMs = Date.now() - last;
  if (idleMs < 30 * 60 * 1000) return;
  if (localStorage.getItem('wft_train_idle_notified') === String(last)) return;
  localStorage.setItem('wft_train_idle_notified', String(last));

  const message = 'Still training? Finish this session or keep going.';
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  playBeep();
  showAppReminder(message);
  fireSystemNotification('Winfinity Tracker', message);
}

function findPreviousSets(name, beforeDate) {
  const logs = getLogs();
  const dates = Object.keys(logs).filter(d => d < beforeDate).sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const ex = (logs[dates[i]].exercises || []).find(e => e.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (ex) return ex.sets;
  }
  return null;
}

function estOneRM(weightKg, reps) {
  if (weightKg == null || reps == null || reps <= 0) return 0;
  return weightKg * (1 + reps / 30);
}

function bestHistoricalOneRM(name, beforeDate) {
  const logs = getLogs();
  let best = 0;
  Object.keys(logs).forEach(d => {
    if (d >= beforeDate) return;
    (logs[d].exercises || []).forEach(ex => {
      if (ex.name.trim().toLowerCase() !== name.trim().toLowerCase()) return;
      (ex.sets || []).forEach(s => {
        if (!s.completed) return;
        const rm = estOneRM(s.weightKg, s.reps);
        if (rm > best) best = rm;
      });
    });
  });
  return best;
}

let exerciseDb = [];
let exerciseDbLoaded = false;
let recentExerciseNames = [];
let exerciseSuggestDebounceId = null;

async function loadExerciseDb() {
  if (exerciseDbLoaded) return;
  try {
    const res = await fetch('data/exercises.json');
    exerciseDb = await res.json();
  } catch (e) { exerciseDb = []; /* offline-friendly: suggestions from own history still work */ }
  exerciseDbLoaded = true;
  // The DB (and its "timed" flags, e.g. Dead Hang) loads async, after the
  // exercise cards for today may have already rendered with plain rep
  // inputs — re-render so any timed exercise picks up its timer button.
  if (currentExercises.length) renderExerciseCards();
}

// Timed holds (Dead Hang, etc.) log a hold duration instead of a rep count —
// the duration is still stored in the set's `reps` field to avoid a schema
// change, just interpreted as seconds instead of reps when rendering/reading.
function isTimedExercise(name) {
  if (!name) return false;
  const entry = exerciseDb.find(e => e.name.trim().toLowerCase() === name.trim().toLowerCase());
  return !!(entry && entry.timed);
}

function initExerciseNameAutocomplete() {
  renderExerciseNameOptions();
  loadExerciseDb();

  const input = document.getElementById('exerciseName');
  const results = document.getElementById('exerciseSuggestResults');

  input.addEventListener('input', () => {
    clearTimeout(exerciseSuggestDebounceId);
    const q = input.value.trim();
    if (!q) { results.hidden = true; results.innerHTML = ''; return; }
    exerciseSuggestDebounceId = setTimeout(() => renderExerciseSuggestions(q), 150);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) renderExerciseSuggestions(input.value.trim());
  });
  document.addEventListener('click', e => {
    if (!results.hidden && !results.contains(e.target) && e.target !== input) results.hidden = true;
  });
}

function renderExerciseSuggestions(query) {
  const results = document.getElementById('exerciseSuggestResults');
  const q = query.toLowerCase();

  const seen = new Set();
  const matches = [];

  // Own exercise history first — these are the ones actually relevant to this user.
  recentExerciseNames.forEach(name => {
    if (name.toLowerCase().includes(q) && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      matches.push({ name, tag: 'Recent' });
    }
  });

  // Then the exercise library, prefix matches ranked above substring matches.
  const dbMatches = exerciseDb
    .filter(ex => ex.name.toLowerCase().includes(q) && !seen.has(ex.name.toLowerCase()))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    });
  dbMatches.forEach(ex => {
    if (seen.has(ex.name.toLowerCase())) return;
    seen.add(ex.name.toLowerCase());
    matches.push(ex);
  });

  const top = matches.slice(0, 20);
  if (!top.length) { results.hidden = true; results.innerHTML = ''; return; }

  results.innerHTML = top.map((ex, i) => {
    const muscles = (ex.primaryMuscles || []).slice(0, 2);
    const tags = [];
    if (ex.tag === 'Recent') tags.push('<span class="exercise-tag">Recent</span>');
    muscles.forEach(m => tags.push(`<span class="exercise-tag exercise-tag--muscle">${escapeHtml(m)}</span>`));
    if (ex.equipment) tags.push(`<span class="exercise-tag">${escapeHtml(ex.equipment)}</span>`);
    return `
      <button type="button" class="food-search-result-row" data-idx="${i}">
        <div>
          <div class="food-result-name">${escapeHtml(ex.name)}</div>
          <div class="exercise-result-tags">${tags.join('')}</div>
        </div>
      </button>
    `;
  }).join('');
  results.hidden = false;

  results.querySelectorAll('.food-search-result-row').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('exerciseName').value = top[parseInt(btn.dataset.idx, 10)].name;
      results.hidden = true;
    });
  });
}

function renderExerciseNameOptions() {
  const logs = getLogs();
  const seen = new Map();
  Object.keys(logs).forEach(date => {
    (logs[date].exercises || []).forEach(ex => {
      if (!ex.name) return;
      const key = ex.name.trim().toLowerCase();
      const existing = seen.get(key);
      if (!existing || date > existing.lastDate) seen.set(key, { name: ex.name.trim(), lastDate: date });
    });
  });
  recentExerciseNames = Array.from(seen.values()).sort((a, b) => b.lastDate.localeCompare(a.lastDate)).map(v => v.name);
}

function getFinishedDates() {
  try { return JSON.parse(localStorage.getItem('wft_finished_dates')) || {}; } catch (e) { return {}; }
}
function setSessionFinished(date, val) {
  const all = getFinishedDates();
  if (val) all[date] = true; else delete all[date];
  localStorage.setItem('wft_finished_dates', JSON.stringify(all));
}
function isSessionFinished(date) { return !!getFinishedDates()[date]; }

function renderExerciseCards() {
  const container = document.getElementById('exerciseCards');
  const emptyNote = document.getElementById('exerciseEmptyNote');
  const newProtocolBox = document.getElementById('newProtocolBox');
  const profile = getProfile();
  const wu = getTrainUnit();
  const date = document.getElementById('trainDate').value;
  container.innerHTML = '';

  if (!currentExercises.length) { emptyNote.hidden = false; newProtocolBox.hidden = false; return; }
  emptyNote.hidden = true;

  if (isSessionFinished(date)) {
    newProtocolBox.hidden = true;
    const totalSets = currentExercises.reduce((n, ex) => n + ex.sets.filter(s => s.completed).length, 0);
    const isToday = date === todayISO();
    container.innerHTML = `<div class="session-done-card">
      <p class="session-done-title">✓ Workout finished</p>
      <p class="session-done-meta">${currentExercises.length} exercise${currentExercises.length !== 1 ? 's' : ''} · ${totalSets} set${totalSets !== 1 ? 's' : ''} logged</p>
      <div class="session-done-actions">
        ${isToday ? '<button type="button" class="btn" id="btnSessionContinue">Continue</button>' : ''}
        <button type="button" class="btn" id="btnSessionEdit">Edit</button>
        <button type="button" class="btn btn--danger" id="btnSessionCompleted">Completed</button>
      </div>
    </div>`;
    return;
  }
  newProtocolBox.hidden = false;

  currentExercises.forEach((ex, exIdx) => {
    const exUnit = ex.unit || wu;
    const prevSets = findPreviousSets(ex.name, date);
    const timed = isTimedExercise(ex.name);
    const card = document.createElement('div');
    card.className = 'ex-card';
    const restMins = Math.round((ex.restSeconds || 180) / 60);
    const restOptions = Array.from({ length: 15 }, (_, i) => i + 1)
      .map(m => `<option value="${m}"${m === restMins ? ' selected' : ''}>${m}m</option>`).join('');

    const rows = ex.sets.map((s, setIdx) => {
      const prev = prevSets && prevSets[setIdx]
        ? (timed ? formatTime(prevSets[setIdx].reps || 0) : `${prevSets[setIdx].reps} × ${round2(fromKg(prevSets[setIdx].weightKg, exUnit))}${exUnit}`)
        : '–';
      const weightDisplay = s.weightKg != null ? round2(fromKg(s.weightKg, exUnit)) : '';
      const repsCell = timed
        ? `<button type="button" class="ex-set-timer-btn${s.reps != null ? ' is-set' : ''}" data-ex="${exIdx}" data-set="${setIdx}">${s.reps != null ? formatTime(s.reps) : '⏱ Timer'}</button>`
        : `<input type="number" class="ex-set-reps" data-ex="${exIdx}" data-set="${setIdx}" value="${s.reps ?? ''}" min="0">`;
      return `<tr class="${s.completed ? 'is-complete' : ''}">
        <td>${setIdx + 1}</td>
        <td class="ex-set-prev">${prev}</td>
        <td>${repsCell}</td>
        <td><input type="number" class="ex-set-weight" data-ex="${exIdx}" data-set="${setIdx}" value="${weightDisplay}" step="0.5" min="0"></td>
        <td><button type="button" class="ex-set-check${s.completed ? ' is-done' : ''}" data-ex="${exIdx}" data-set="${setIdx}">✓</button></td>
        <td><button type="button" class="ex-set-remove" data-ex="${exIdx}" data-set="${setIdx}">✕</button></td>
      </tr>`;
    }).join('');

    const timerInfo = exTimerDisplayFor(date, exIdx);
    const completedSets = ex.sets.filter(s => s.completed && s.weightKg != null && s.reps != null);
    const bestOneRM = completedSets.reduce((max, s) => Math.max(max, estOneRM(s.weightKg, s.reps)), 0);
    const historicalBest = bestHistoricalOneRM(ex.name, date);
    const isPR = completedSets.length > 0 && historicalBest > 0 && bestOneRM > historicalBest + 0.01;
    card.innerHTML = `
      <p class="mod-tag">MOD_P_${String(exIdx + 1).padStart(2, '0')}</p>
      <div class="ex-card-head">
        <div class="ex-card-title">${escapeHtml(ex.name)}</div>
        <div class="ex-unit-toggle" data-ex="${exIdx}">
          <button type="button" class="ex-unit-btn${exUnit === 'kg' ? ' is-active' : ''}" data-ex="${exIdx}" data-unit="kg">KG</button>
          <button type="button" class="ex-unit-btn${exUnit === 'lb' ? ' is-active' : ''}" data-ex="${exIdx}" data-unit="lb">LB</button>
        </div>
        <div class="ex-card-rest">
          ${isPR ? '<span class="pr-pill">🏆 PR</span>' : ''}
          <span class="ex-rest-timer ${timerInfo.state}" data-ex="${exIdx}">${timerInfo.text}</span>
          ⏱ <select class="ex-rest-select" data-ex="${exIdx}">${restOptions}</select>
        </div>
        <div class="ex-card-menu-wrap">
          <button type="button" class="ex-card-remove" data-ex="${exIdx}">⋮</button>
          <div class="ex-card-menu" data-ex="${exIdx}" hidden>
            <button type="button" class="ex-menu-item ex-menu-rename" data-ex="${exIdx}">Rename</button>
            <button type="button" class="ex-menu-item ex-menu-reset" data-ex="${exIdx}">Reset</button>
            <button type="button" class="ex-menu-item ex-menu-delete" data-ex="${exIdx}">Delete</button>
          </div>
        </div>
      </div>
      <input type="text" class="ex-card-notes" data-ex="${exIdx}" placeholder="Add notes here…" value="${escapeHtml(ex.notes || '')}">
      <table class="ex-sets-table">
        <thead><tr><th>Set</th><th>Previous</th><th>${timed ? 'Hold' : 'Reps'}</th><th>Load (${exUnit})</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button type="button" class="btn btn--sm ex-add-set" data-ex="${exIdx}">+ Append set block</button>
    `;
    container.appendChild(card);
  });
}

/* ---------------------------------------------------------------- */
/* Training: outdoor activity tracker (GPS, foreground-only)          */
/* ---------------------------------------------------------------- */
let cardioWatchId = null;
let cardioTickId = null;
let cardioTrack = [];
let cardioGpsErrorShown = false;
let cardioDistanceKm = 0;
let cardioMaxSpeedKmh = 0;
let cardioStartTime = null;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distUnitForProfile(profile) { return (profile && profile.weightUnit === 'lb') ? 'mi' : 'km'; }
function kmToMi(km) { return km * 0.621371; }

function formatCardioClock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function formatCardioDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}

function renderCardioRouteSketch() {
  const svg = document.getElementById('cardioRouteSketch');
  if (cardioTrack.length < 2) { svg.innerHTML = ''; return; }
  const lats = cardioTrack.map(p => p.lat), lons = cardioTrack.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const w = 300, h = 300, pad = 12;
  const spanLat = Math.max(maxLat - minLat, 0.0001);
  const spanLon = Math.max(maxLon - minLon, 0.0001);
  const points = cardioTrack.map(p => {
    const x = pad + ((p.lon - minLon) / spanLon) * (w - pad * 2);
    const y = h - pad - ((p.lat - minLat) / spanLat) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  svg.innerHTML = `<polyline points="${points}" fill="none" stroke="var(--cyan)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
}

// Same bounding-box normalization as renderCardioRouteSketch above, just
// drawn to an offscreen canvas and exported as a PNG data URL — the
// Outdoor widget can't host a real interactive map, so this static
// snapshot of the path-so-far is what WidgetBridgePlugin.updateOutdoorWidget
// decodes into a Bitmap for the widget's RemoteViews ImageView.
function renderCardioPathSnapshot() {
  const size = 144, pad = 14;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0e12';
  ctx.fillRect(0, 0, size, size);
  if (cardioTrack.length < 2) return canvas.toDataURL('image/png');
  const lats = cardioTrack.map(p => p.lat), lons = cardioTrack.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const spanLat = Math.max(maxLat - minLat, 0.0001);
  const spanLon = Math.max(maxLon - minLon, 0.0001);
  const points = cardioTrack.map(p => {
    const x = pad + ((p.lon - minLon) / spanLon) * (size - pad * 2);
    const y = size - pad - ((p.lat - minLat) / spanLat) * (size - pad * 2);
    return [x, y];
  });
  ctx.strokeStyle = '#33c8cc';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach(([x, y], i) => { if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  return canvas.toDataURL('image/png');
}

// Throttled to every 5th tick (updateCardioStats runs every 1s) — the path
// snapshot re-render is real canvas work, no need to pay for it every
// single second when the widget itself only repaints when the OS gets
// around to it anyway.
let cardioWidgetSyncTick = 0;
function syncOutdoorWidget(elapsedSec) {
  if (!isNativeApp() || !window.Capacitor.Plugins.WidgetBridge) return;
  cardioWidgetSyncTick++;
  if (cardioWidgetSyncTick % 5 !== 0) return;
  const type = document.getElementById('cardioType').value;
  const steps = estimateCardioSteps(cardioDistanceKm, type);
  // Independent of distUnitForProfile — the widget's layout always labels
  // this "km/h" (see widget_outdoor_active.xml), so it needs a true km/h
  // value regardless of whether the on-screen stat is showing mph for a
  // mile-preferring profile.
  const avgSpeedKmh = elapsedSec > 0 ? cardioDistanceKm / (elapsedSec / 3600) : 0;
  window.Capacitor.Plugins.WidgetBridge.updateOutdoorWidget({
    state: 'active',
    steps: steps != null ? String(steps) : '0',
    paceKph: avgSpeedKmh.toFixed(1),
    distanceKm: cardioDistanceKm.toFixed(2),
    pathImageBase64: renderCardioPathSnapshot(),
  }).catch(() => { /* widget not present / plugin unavailable — non-fatal */ });
}

function setOutdoorWidgetIdle() {
  if (!isNativeApp() || !window.Capacitor.Plugins.WidgetBridge) return;
  window.Capacitor.Plugins.WidgetBridge.updateOutdoorWidget({ state: 'idle' }).catch(() => {});
}

function formatPaceSecPerUnit(sec) {
  if (!sec || !isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const CARDIO_STRIDE_M = { run: 1.0, walk: 0.75 };

function estimateCardioSteps(distanceKm, type) {
  const stride = CARDIO_STRIDE_M[type];
  if (!stride) return null; // e.g. "ride" — steps don't apply
  return Math.round((distanceKm * 1000) / stride);
}

let cardioStatsErrorShown = false;
function updateCardioStats() {
  // Wrapped defensively — this drives every on-screen tracking stat on a
  // 1-second loop, so one unexpected exception (e.g. the addWatcher()
  // promise-shape bug this once caught — see startGpsWatch) would otherwise
  // freeze the whole display silently for the rest of the session with no
  // signal that anything had gone wrong.
  try {
    const elapsed = Math.round((Date.now() - cardioStartTime) / 1000);
    document.getElementById('cardioDuration').textContent = formatCardioClock(elapsed);
    const unit = distUnitForProfile(getProfile());
    const dist = unit === 'mi' ? kmToMi(cardioDistanceKm) : cardioDistanceKm;
    document.getElementById('cardioDistance').textContent = dist.toFixed(2);
    document.getElementById('cardioDistanceLabel').textContent = `Distance (${unit})`;
    document.getElementById('cardioPaceLabel').textContent = `Avg pace /${unit}`;
    document.getElementById('cardioBestPaceLabel').textContent = `Fastest /${unit}`;
    document.getElementById('cardioAvgSpeedLabel').textContent = `Avg speed ${unit === 'mi' ? 'mph' : 'km/h'}`;
    document.getElementById('cardioMaxSpeedLabel').textContent = `Max speed ${unit === 'mi' ? 'mph' : 'km/h'}`;

    if (dist > 0.05) {
      document.getElementById('cardioPace').textContent = formatPaceSecPerUnit(elapsed / dist);
    }
    const avgSpeedKmh = elapsed > 0 ? cardioDistanceKm / (elapsed / 3600) : 0;
    const avgSpeed = unit === 'mi' ? kmToMi(avgSpeedKmh) : avgSpeedKmh;
    document.getElementById('cardioAvgSpeed').textContent = avgSpeed.toFixed(1);
    const maxSpeed = unit === 'mi' ? kmToMi(cardioMaxSpeedKmh) : cardioMaxSpeedKmh;
    document.getElementById('cardioMaxSpeed').textContent = maxSpeed.toFixed(1);
    if (cardioMaxSpeedKmh > 0) {
      const bestPaceSecPerKm = 3600 / cardioMaxSpeedKmh;
      const bestPaceSecPerUnit = unit === 'mi' ? bestPaceSecPerKm / 0.621371 : bestPaceSecPerKm;
      document.getElementById('cardioBestPace').textContent = formatPaceSecPerUnit(bestPaceSecPerUnit);
    }

    const type = document.getElementById('cardioType').value;
    const steps = estimateCardioSteps(cardioDistanceKm, type);
    document.getElementById('cardioStepsTile').hidden = steps == null;
    if (steps != null) document.getElementById('cardioSteps').textContent = steps.toLocaleString();
    syncOutdoorWidget(elapsed);
  } catch (e) {
    if (!cardioStatsErrorShown) {
      cardioStatsErrorShown = true;
      showRestToast('⚠️ updateCardioStats error: ' + (e && (e.message || e)) + (e && e.stack ? ' | ' + e.stack.split('\n')[0] : ''));
    }
  }
}

// In the plain browser / installed PWA, GPS tracking is regular
// navigator.geolocation.watchPosition — the OS suspends it once the tab is
// backgrounded, same as any web page. In the Capacitor-wrapped Android APK
// (window.Capacitor present), BackgroundGeolocation instead runs a native
// foreground service with a persistent notification, so tracking keeps
// running while the app is backgrounded or the screen is off. Both paths
// feed the exact same per-point callback, so the rest of the cardio
// tracking logic below doesn't need to know which one is active.
function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}
let cardioNativeWatcherId = null;
function startGpsWatch(onPosition, onError) {
  if (isNativeApp() && window.Capacitor.Plugins.BackgroundGeolocation) {
    // Android 13+ requires POST_NOTIFICATIONS to be explicitly granted, or
    // the foreground-service notification the background tracking depends
    // on can silently fail to post once the app leaves the foreground,
    // killing tracking along with it. The geolocation plugin only requests
    // the location permission, never this one — MainActivity.onCreate
    // requests POST_NOTIFICATIONS natively at app launch instead.
    // addWatcher() does NOT reliably return a real Promise when called via
    // the raw window.Capacitor.Plugins proxy (rather than this plugin's own
    // npm JS wrapper, which this remote-loaded app doesn't bundle) under
    // this app's useLegacyBridge config — chaining .then() on it threw
    // "addWatcher(...).then is not a function" every time, aborting the
    // rest of startCardioTracking() (including the setInterval that drives
    // the on-screen stats) before it ever ran, even though the location
    // callback itself still fired fine since it's registered separately.
    // Guard the chain instead of assuming a promise.
    const addWatcherResult = window.Capacitor.Plugins.BackgroundGeolocation.addWatcher({
      backgroundTitle: 'Winfinity Tracker',
      backgroundMessage: 'Tracking your outdoor activity — tap to return to the app.',
      requestPermissions: true,
      stale: false,
      distanceFilter: 3,
    }, (location, error) => {
      if (error) { onError(error); return; }
      onPosition({ coords: { latitude: location.latitude, longitude: location.longitude, accuracy: location.accuracy } });
    });
    if (addWatcherResult && typeof addWatcherResult.then === 'function') {
      addWatcherResult.then(id => { cardioNativeWatcherId = id; }).catch(err => onError(err));
    } else {
      // Not a promise — the raw bridge call likely already returned the
      // watcher id (or nothing) synchronously instead. Either way, the
      // location callback above works regardless; this only affects
      // removeWatcher() being able to target the right id on stop.
      cardioNativeWatcherId = addWatcherResult || null;
    }
    return 'native';
  }
  return navigator.geolocation.watchPosition(onPosition, onError, {
    enableHighAccuracy: true, maximumAge: 2000, timeout: 10000,
  });
}
function stopGpsWatch(watchId) {
  if (watchId === 'native') {
    if (cardioNativeWatcherId != null && isNativeApp() && window.Capacitor.Plugins.BackgroundGeolocation) {
      window.Capacitor.Plugins.BackgroundGeolocation.removeWatcher({ id: cardioNativeWatcherId });
    }
    cardioNativeWatcherId = null;
    return;
  }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
}

function startCardioTracking() {
  if (!isNativeApp() && !navigator.geolocation) { alert('Geolocation is not available on this device/browser.'); return; }
  cardioTrack = [];
  cardioDistanceKm = 0;
  cardioMaxSpeedKmh = 0;
  cardioStartTime = Date.now();
  document.getElementById('btnCardioStart').hidden = true;
  document.getElementById('btnCardioStop').hidden = false;
  document.getElementById('btnShareCardio').hidden = true;
  document.getElementById('cardioType').disabled = true;
  document.getElementById('cardioDuration').textContent = '00:00';
  document.getElementById('cardioDistance').textContent = '0.00';
  document.getElementById('cardioPace').textContent = '--:--';
  document.getElementById('cardioBestPace').textContent = '--:--';
  document.getElementById('cardioAvgSpeed').textContent = '0.0';
  document.getElementById('cardioMaxSpeed').textContent = '0.0';
  document.getElementById('cardioSteps').textContent = '0';
  document.getElementById('cardioStepsTile').hidden = estimateCardioSteps(0, document.getElementById('cardioType').value) == null;
  document.getElementById('cardioRouteSketch').hidden = false;
  document.getElementById('cardioMapView').hidden = true;
  document.getElementById('cardioMapZoomRow').hidden = true;
  renderCardioRouteSketch();
  cardioGpsErrorShown = false;
  cardioStatsErrorShown = false;

  cardioWatchId = startGpsWatch(pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy != null && accuracy > 50) return;
    const point = { lat: latitude, lon: longitude, t: Date.now(), accuracy: accuracy || 0 };
    if (cardioTrack.length) {
      const last = cardioTrack[cardioTrack.length - 1];
      const segKm = haversineKm(last.lat, last.lon, point.lat, point.lon);
      // GPS jitters a few meters even standing still — with a flat 3m floor,
      // that jitter alone can register as "movement" while stopped. Scaling
      // the floor to the worse of the two fixes' own reported accuracy fixes
      // that (a sloppy 20m fix needs a real ~12m move to count) without
      // dulling sensitivity to genuine slow walking, since a sharp 4-5m fix
      // still only needs the same ~4m floor it always had.
      const noiseFloorKm = Math.max(0.004, (Math.max(point.accuracy, last.accuracy || 0) * 0.6) / 1000);
      if (segKm > noiseFloorKm) {
        const segHours = (point.t - last.t) / 3600000;
        const segSpeedKmh = segHours > 0 ? segKm / segHours : 0;
        const speedCap = document.getElementById('cardioType').value === 'ride' ? 80 : 45;
        if (segSpeedKmh > 0 && segSpeedKmh <= speedCap) cardioMaxSpeedKmh = Math.max(cardioMaxSpeedKmh, segSpeedKmh);
        cardioDistanceKm += segKm;
        cardioTrack.push(point);
        renderCardioRouteSketch();
      }
    } else {
      cardioTrack.push(point);
    }
  }, err => {
    // Keep the timer running either way — a transient GPS blip shouldn't end
    // the session — but surface it once so a permission denial or a failed
    // native watcher (silent otherwise) is actually visible instead of just
    // quietly producing a flat, un-tracked stretch of the route.
    if (!cardioGpsErrorShown) {
      cardioGpsErrorShown = true;
      const msg = (err && (err.message || err.code)) || 'unknown error';
      showRestToast(`⚠️ GPS tracking issue: ${msg}. Check location/notification permissions in phone settings.`);
    }
  });

  cardioTickId = setInterval(updateCardioStats, 1000);
  startCardioHydrationReminders();

  cardioWidgetSyncTick = 0;
  if (isNativeApp() && window.Capacitor.Plugins.WidgetBridge) {
    window.Capacitor.Plugins.WidgetBridge.updateOutdoorWidget({
      state: 'active', steps: '0', paceKph: '0.0', distanceKm: '0.00', pathImageBase64: null,
    }).catch(() => {});
  }
}

let lastCardioSession = null;

function stopCardioTracking() {
  stopGpsWatch(cardioWatchId);
  if (cardioTickId) clearInterval(cardioTickId);
  cardioWatchId = null;
  cardioTickId = null;
  stopCardioHydrationReminders();
  setOutdoorWidgetIdle();

  const elapsedSec = Math.round((Date.now() - cardioStartTime) / 1000);
  const type = document.getElementById('cardioType').value;
  const date = document.getElementById('trainDate').value;
  const logs = getLogs();
  const sessions = (logs[date] && logs[date].cardioSessions) || [];
  const session = {
    type,
    distanceKm: round2(cardioDistanceKm),
    durationSec: elapsedSec,
    startedAt: new Date(cardioStartTime).toISOString(),
    maxSpeedKmh: round2(cardioMaxSpeedKmh),
  };
  sessions.push(session);
  updateLogFields(date, { cardioSessions: sessions });
  lastCardioSession = session;

  document.getElementById('btnCardioStart').hidden = false;
  document.getElementById('btnCardioStop').hidden = true;
  document.getElementById('cardioType').disabled = false;
  document.getElementById('cardioSaveNote').textContent = 'Activity saved.';
  setTimeout(() => { document.getElementById('cardioSaveNote').textContent = ''; }, 2500);
  document.getElementById('btnShareCardio').hidden = false;
  renderCardioMap(cardioTrack);
  renderCardioHistory();
  autoSyncLeaderboardIfOptedIn();
}

let cardioMapInstance = null;
let cardioMapTileLayer = null;

// Two free, no-API-key tile sources standing in for Google's road map and
// satellite looks — CARTO Voyager (built on OSM data) is styled close to
// Google's clean default road map, Esri World Imagery is free aerial
// photography for the satellite view. Neither needs a key or billing
// account, unlike the actual Google Maps JS API.
const CARDIO_MAP_STYLES = {
  road: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: { maxZoom: 19, subdomains: 'abcd', attribution: '&copy; OpenStreetMap contributors &copy; CARTO' },
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
  },
};

function getCardioMapStyle() {
  const s = localStorage.getItem('wft_map_style');
  return CARDIO_MAP_STYLES[s] ? s : 'road';
}

function setCardioMapStyle(style) {
  localStorage.setItem('wft_map_style', style);
  const btn = document.getElementById('btnCardioMapStyle');
  if (btn) btn.textContent = style === 'satellite' ? 'Satellite' : 'Road';
  if (!cardioMapInstance) return;
  if (cardioMapTileLayer) cardioMapInstance.removeLayer(cardioMapTileLayer);
  const def = CARDIO_MAP_STYLES[style];
  cardioMapTileLayer = L.tileLayer(def.url, def.options).addTo(cardioMapInstance);
}

function renderCardioMap(track) {
  const sketch = document.getElementById('cardioRouteSketch');
  const mapEl = document.getElementById('cardioMapView');
  if (!window.L || track.length < 2) return; // no internet/Leaflet, or nothing to plot — keep the offline sketch visible
  sketch.hidden = true;
  mapEl.hidden = false;
  document.getElementById('cardioMapZoomRow').hidden = false;

  if (cardioMapInstance) { cardioMapInstance.remove(); cardioMapInstance = null; }
  const map = L.map(mapEl, { zoomControl: false, attributionControl: true });
  cardioMapInstance = map;
  const def = CARDIO_MAP_STYLES[getCardioMapStyle()];
  cardioMapTileLayer = L.tileLayer(def.url, def.options).addTo(map);

  const latlngs = track.map(p => [p.lat, p.lon]);
  const path = L.polyline(latlngs, { color: '#33c8cc', weight: 4, lineCap: 'round', lineJoin: 'round' }).addTo(map);
  L.circleMarker(latlngs[0], { radius: 7, weight: 2, color: '#fff', fillColor: '#34bd7c', fillOpacity: 1 }).addTo(map);
  L.circleMarker(latlngs[latlngs.length - 1], { radius: 7, weight: 2, color: '#fff', fillColor: '#e6516a', fillOpacity: 1 }).addTo(map);
  // mapEl was just unhidden this same tick — it's sized via aspect-ratio,
  // not a fixed px height, so Leaflet can measure it before the browser
  // finishes committing that layout change and init at the wrong (sometimes
  // zero) size, which throws fitBounds' zoom pick off too. One deferred
  // frame lets layout settle before Leaflet re-measures and fits the path.
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitBounds(path.getBounds(), { padding: [20, 20] });
  });
}

function lonToPixelX(lon, zoom) { return (lon + 180) / 360 * 256 * Math.pow(2, zoom); }
function latToPixelY(lat, zoom) {
  const latRad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * 256 * Math.pow(2, zoom);
}

function pickMapZoom(track, mapW, mapH) {
  const lats = track.map(p => p.lat), lons = track.map(p => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  for (let z = 18; z >= 1; z--) {
    const w = lonToPixelX(maxLon, z) - lonToPixelX(minLon, z);
    const h = latToPixelY(minLat, z) - latToPixelY(maxLat, z);
    if (w <= mapW * 0.8 && h <= mapH * 0.8) return z;
  }
  return 1;
}

function loadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function drawMapBackground(ctx, track, mapW, mapH) {
  const zoom = pickMapZoom(track, mapW, mapH);
  const lats = track.map(p => p.lat), lons = track.map(p => p.lon);
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const originX = lonToPixelX(centerLon, zoom) - mapW / 2;
  const originY = latToPixelY(centerLat, zoom) - mapH / 2;

  const tileMin = { x: Math.floor(originX / 256), y: Math.floor(originY / 256) };
  const tileMax = { x: Math.floor((originX + mapW) / 256), y: Math.floor((originY + mapH) / 256) };
  const subdomains = ['a', 'b', 'c'];
  let sIdx = 0;
  const loads = [];
  for (let tx = tileMin.x; tx <= tileMax.x; tx++) {
    for (let ty = tileMin.y; ty <= tileMax.y; ty++) {
      const s = subdomains[sIdx++ % subdomains.length];
      const url = `https://${s}.tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
      loads.push(loadImage(url).then(img => ({ img, tx, ty })));
    }
  }
  const tiles = await Promise.all(loads);
  tiles.forEach(({ img, tx, ty }) => {
    if (!img) return;
    ctx.drawImage(img, tx * 256 - originX, ty * 256 - originY, 256, 256);
  });

  return { zoom, originX, originY };
}

function projectTrackToMap(track, proj) {
  return track.map(p => ({
    x: lonToPixelX(p.lon, proj.zoom) - proj.originX,
    y: latToPixelY(p.lat, proj.zoom) - proj.originY,
  }));
}

async function generateCardioShareCardWithMap(track, { emoji, title, stats }) {
  const canvas = document.createElement('canvas');
  canvas.width = 600; canvas.height = 600;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#171f24';
  ctx.fillRect(0, 0, 600, 600);

  let proj = null;
  if (track.length > 1) {
    try { proj = await drawMapBackground(ctx, track, 600, 600); } catch (e) { proj = null; }
  }
  if (!proj) return generateShareCardBlob({ emoji, title, stats }); // offline or track too short — plain card instead

  {
    const pts = projectTrackToMap(track, proj);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 7;
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();
    ctx.strokeStyle = '#33c8cc';
    ctx.lineWidth = 4;
    ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();

    [{ p: pts[0], color: '#34bd7c' }, { p: pts[pts.length - 1], color: '#e6516a' }].forEach(({ p, color }) => {
      ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
    });
  }

  const bannerTop = stats.length > 3 ? 330 : 380;
  const gradient = ctx.createLinearGradient(0, bannerTop, 0, 600);
  gradient.addColorStop(0, 'rgba(10,14,18,0)');
  gradient.addColorStop(1, 'rgba(10,14,18,0.92)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, bannerTop, 600, 600 - bannerTop);

  ctx.textAlign = 'left';
  ctx.font = '32px sans-serif';
  ctx.fillText(emoji, 30, bannerTop + 55);
  ctx.fillStyle = '#33c8cc';
  ctx.font = 'bold 24px sans-serif';
  ctx.fillText(title, 76, bannerTop + 50);

  const cols = [30, 220, 410];
  const rowY = [bannerTop + 115, bannerTop + 175];
  stats.forEach((s, i) => {
    const x = cols[i % 3];
    const y = rowY[Math.floor(i / 3)];
    ctx.fillStyle = '#7e8e95';
    ctx.font = '12px monospace';
    ctx.fillText(s.label.toUpperCase(), x, y);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 21px sans-serif';
    ctx.fillText(s.value, x, y + 28);
  });

  await drawShareWatermark(ctx, 600, 600);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareCardioSession() {
  if (!lastCardioSession) return;
  const unit = distUnitForProfile(getProfile());
  const dist = unit === 'mi' ? kmToMi(lastCardioSession.distanceKm) : lastCardioSession.distanceKm;
  const typeLabel = { run: 'run', walk: 'walk', ride: 'ride' }[lastCardioSession.type] || 'activity';
  const emoji = { run: '🏃', walk: '🚶', ride: '🚴' }[lastCardioSession.type] || '🏁';
  const text = `${emoji} Just finished a ${dist.toFixed(2)} ${unit} ${typeLabel} in ${formatCardioDuration(lastCardioSession.durationSec)} with Winfinity Tracker!`;
  const paceMin = lastCardioSession.distanceKm > 0 ? (lastCardioSession.durationSec / 60) / dist : 0;
  const paceText = paceMin > 0 ? `${Math.floor(paceMin)}:${String(Math.round((paceMin % 1) * 60)).padStart(2, '0')} /${unit}` : '--';
  const avgSpeedKmh = lastCardioSession.durationSec > 0 ? lastCardioSession.distanceKm / (lastCardioSession.durationSec / 3600) : 0;
  const avgSpeed = unit === 'mi' ? kmToMi(avgSpeedKmh) : avgSpeedKmh;
  const maxSpeedKmh = lastCardioSession.maxSpeedKmh || 0;
  const maxSpeed = unit === 'mi' ? kmToMi(maxSpeedKmh) : maxSpeedKmh;
  const bestPaceSecPerUnit = maxSpeedKmh > 0 ? (unit === 'mi' ? (3600 / maxSpeedKmh) / 0.621371 : 3600 / maxSpeedKmh) : 0;
  const bestPaceText = bestPaceSecPerUnit > 0 ? formatPaceSecPerUnit(bestPaceSecPerUnit) + ` /${unit}` : '--';
  const speedUnit = unit === 'mi' ? 'mph' : 'km/h';
  const blob = await generateCardioShareCardWithMap(cardioTrack, {
    emoji,
    title: `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} complete!`,
    stats: [
      { label: 'Distance', value: `${dist.toFixed(2)} ${unit}` },
      { label: 'Duration', value: formatCardioDuration(lastCardioSession.durationSec) },
      { label: 'Avg pace', value: paceText },
      { label: 'Fastest', value: bestPaceText },
      { label: 'Avg speed', value: `${avgSpeed.toFixed(1)} ${speedUnit}` },
      { label: 'Max speed', value: `${maxSpeed.toFixed(1)} ${speedUnit}` },
    ],
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Activity', text }, blob);
}

function deleteCardioSession(date, sessionIndex) {
  if (!confirm('Delete this activity? This cannot be undone.')) return;
  const logs = getLogs();
  const sessions = (logs[date] && logs[date].cardioSessions) || [];
  sessions.splice(sessionIndex, 1);
  updateLogFields(date, { cardioSessions: sessions });
  renderCardioHistory();
}

function renderCardioHistory() {
  const logsArr = sortedLogsArray().slice().reverse();
  const unit = distUnitForProfile(getProfile());
  const container = document.getElementById('cardioHistory');
  const empty = document.getElementById('cardioHistoryEmpty');
  const rows = [];
  logsArr.forEach(l => { (l.cardioSessions || []).forEach((s, i) => rows.push({ date: l.date, sessionIndex: i, ...s })); });
  container.innerHTML = '';
  if (!rows.length) { empty.hidden = false; return; }
  empty.hidden = true;
  rows.slice(0, 10).forEach(s => {
    const dist = unit === 'mi' ? kmToMi(s.distanceKm) : s.distanceKm;
    const row = document.createElement('div');
    row.className = 'cardio-history-row';
    row.innerHTML = `<span class="cardio-history-date">${s.date}</span>
      <span class="cardio-history-type">${s.type}</span>
      <span class="cardio-history-dist">${dist.toFixed(2)} ${unit}</span>
      <span class="cardio-history-dur">${formatCardioDuration(s.durationSec)}</span>
      <button type="button" class="cardio-history-delete" data-date="${s.date}" data-index="${s.sessionIndex}" aria-label="Delete activity">✕</button>`;
    container.appendChild(row);
  });
}

function initCardioHistoryDelete() {
  document.getElementById('cardioHistory').addEventListener('click', e => {
    const btn = e.target.closest('.cardio-history-delete');
    if (!btn) return;
    deleteCardioSession(btn.dataset.date, parseInt(btn.dataset.index, 10));
  });
}

function initCardioTracker() {
  document.getElementById('btnCardioStart').addEventListener('click', startCardioTracking);
  document.getElementById('btnCardioStop').addEventListener('click', stopCardioTracking);
  document.getElementById('btnShareCardio').addEventListener('click', shareCardioSession);
  document.getElementById('btnCardioZoomIn').addEventListener('click', () => { if (cardioMapInstance) cardioMapInstance.zoomIn(); });
  document.getElementById('btnCardioZoomOut').addEventListener('click', () => { if (cardioMapInstance) cardioMapInstance.zoomOut(); });
  const styleBtn = document.getElementById('btnCardioMapStyle');
  styleBtn.textContent = getCardioMapStyle() === 'satellite' ? 'Satellite' : 'Road';
  styleBtn.addEventListener('click', () => {
    setCardioMapStyle(getCardioMapStyle() === 'satellite' ? 'road' : 'satellite');
  });
  initClickToRevealHint('btnToggleActivityHistory', 'activityHistoryPanel');
  initCardioHistoryDelete();
  renderCardioHistory();
}

function getActiveTrainingDate() {
  const stored = localStorage.getItem('wft_active_train_date');
  if (!stored) return todayISO();
  const logs = getLogs();
  const hasData = logs[stored] && logs[stored].exercises && logs[stored].exercises.length > 0;
  return (hasData && !isSessionFinished(stored)) ? stored : todayISO();
}

/* ---------------------------------------------------------------- */
/* Training: temporal mission log (calendar of workout days)          */
/* ---------------------------------------------------------------- */
let missionLogViewDate = new Date();

function getWorkoutDaysSet() {
  const logs = getLogs();
  const set = new Set();
  Object.keys(logs).forEach(date => {
    const l = logs[date];
    if (l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))) set.add(date);
  });
  return set;
}

function getPeriodDaysSet() {
  const logs = getLogs();
  const set = new Set();
  Object.keys(logs).forEach(date => {
    if (logs[date].menstruating) set.add(date);
  });
  return set;
}

// Generic "which days have data" set builder for the shared date-picker's
// highlight dots — each calendar marks the days relevant to whatever
// widget/tab opened it, not just workout days.
function getLogDaysSet(predicate) {
  const logs = getLogs();
  const set = new Set();
  Object.keys(logs).forEach(date => { if (predicate(logs[date])) set.add(date); });
  return set;
}
function getNutritionDaysSet() { return getLogDaysSet(l => l.calories != null); }
function getBioDaysSet() {
  return getLogDaysSet(l => (l.stress != null && l.fatigue != null && l.hunger != null) || hasLoggedSkinfolds(l));
}
function getMeasurementDaysSet() { return getLogDaysSet(l => !!l.measurements); }

function renderMissionLogCalendar() {
  const year = missionLogViewDate.getFullYear();
  const month = missionLogViewDate.getMonth();
  document.getElementById('missionLogMonthLabel').textContent =
    missionLogViewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const profile = getProfile();
  const showPeriod = profile && profile.gender === 'female';
  const workoutDays = getWorkoutDaysSet();
  const periodDays = showPeriod ? getPeriodDaysSet() : new Set();
  const carryoverResets = getCarryoverResets();
  const todayIso = todayISO();
  const selectedIso = document.getElementById('trainDate').value;

  document.getElementById('missionLogPeriodLegend').hidden = !showPeriod;

  const firstOfMonth = new Date(year, month, 1);
  const firstWeekday = firstOfMonth.getDay(); // Sunday-first index
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push({ day: daysInPrevMonth - firstWeekday + 1 + i, muted: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({ day: d, iso, isToday: iso === todayIso, isSelected: iso === selectedIso, isWorkout: workoutDays.has(iso), isPeriod: periodDays.has(iso), isReset: !!carryoverResets[iso] });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) { cells.push({ day: nextDay++, muted: true }); }

  const grid = document.getElementById('missionLogGrid');
  grid.innerHTML = cells.map(c => {
    const classes = ['mission-log-day'];
    if (c.muted) classes.push('is-muted');
    if (c.isWorkout) classes.push('is-workout');
    if (c.isToday) classes.push('is-today');
    if (c.isSelected) classes.push('is-selected');
    if (c.isPeriod) classes.push('is-period');
    if (c.isReset) classes.push('is-reset');
    const dot = c.isPeriod ? '<span class="mission-log-period-dot"></span>' : '';
    const resetDot = c.isReset ? '<span class="mission-log-reset-dot"></span>' : '';
    if (c.muted) return `<div class="${classes.join(' ')}">${c.day}</div>`;
    return `<button type="button" class="${classes.join(' ')}" data-iso="${c.iso}">${c.day}${dot}${resetDot}</button>`;
  }).join('');
}

function updateCalendarBtnLabel(inputId, labelId, prefixText) {
  const dateVal = document.getElementById(inputId).value;
  const label = document.getElementById(labelId);
  if (!label || !dateVal) return;
  label.textContent = `${prefixText} · ${fmtDate(parseISO(dateVal))}`;
}

function updateMissionLogBtnLabel() {
  updateCalendarBtnLabel('trainDate', 'missionLogBtnDate', 'Temporal Mission Log');
}
function updateFuelLogBtnLabel() {
  updateCalendarBtnLabel('nutDate', 'fuelLogBtnDate', 'Temporal Fuel Log');
}
function updateBioLogBtnLabel() {
  updateCalendarBtnLabel('bioDate', 'bioLogBtnDate', 'Temporal Entity Log');
}

function initMissionLog() {
  const overlay = document.getElementById('missionLogOverlay');
  document.getElementById('btnOpenMissionLog').addEventListener('click', () => {
    const current = document.getElementById('trainDate').value;
    const base = current ? parseISO(current) : new Date();
    missionLogViewDate = new Date(base.getFullYear(), base.getMonth(), 1);
    renderMissionLogCalendar();
    overlay.hidden = false;
  });
  document.getElementById('btnCloseMissionLog').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
  document.getElementById('btnMissionLogPrev').addEventListener('click', () => {
    missionLogViewDate = new Date(missionLogViewDate.getFullYear(), missionLogViewDate.getMonth() - 1, 1);
    renderMissionLogCalendar();
  });
  document.getElementById('btnMissionLogNext').addEventListener('click', () => {
    missionLogViewDate = new Date(missionLogViewDate.getFullYear(), missionLogViewDate.getMonth() + 1, 1);
    renderMissionLogCalendar();
  });
  document.getElementById('missionLogGrid').addEventListener('click', e => {
    const cell = e.target.closest('.mission-log-day[data-iso]');
    if (!cell) return;
    const iso = cell.dataset.iso;
    if (cell.classList.contains('is-reset')) {
      const rec = getCarryoverResets()[iso];
      if (rec) {
        const label = rec.balanceBefore > 0 ? `+${round0(rec.balanceBefore)} kcal banked` : `${round0(rec.balanceBefore)} kcal overflow`;
        showRestToast(`Carryover reset on ${fmtDate(parseISO(iso))}: ${label} cleared.`);
      }
    }
    const dateEl = document.getElementById('trainDate');
    dateEl.value = iso;
    localStorage.setItem('wft_active_train_date', iso);
    loadTrainingForDate(iso);
    updateMissionLogBtnLabel();
    overlay.hidden = true;
  });
}

/* ---------------------------------------------------------------- */
/* Shared date-picker popup (same visual as Temporal Mission Log)     */
/* Every readonly .date-picker-trigger input opens this instead of     */
/* the native OS picker; selecting a day sets .value + fires change,  */
/* so every existing change-listener keeps working unmodified.        */
/* ---------------------------------------------------------------- */
let datePickerViewDate = new Date();
let datePickerTargetInput = null;
// Optional Set of ISO dates to mark with a dot (e.g. days that already have
// saved Daily Review data) — set per-picker-open, cleared when not relevant.
let datePickerHighlightDates = null;

function renderDatePickerGrid(selectedIso) {
  const year = datePickerViewDate.getFullYear();
  const month = datePickerViewDate.getMonth();
  document.getElementById('datePickerMonthLabel').textContent =
    datePickerViewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const todayIso = todayISO();
  const firstOfMonth = new Date(year, month, 1);
  const firstWeekday = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push({ day: daysInPrevMonth - firstWeekday + 1 + i, muted: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push({
      day: d, iso, isToday: iso === todayIso, isSelected: iso === selectedIso,
      hasData: !!(datePickerHighlightDates && datePickerHighlightDates.has(iso)),
    });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0) cells.push({ day: nextDay++, muted: true });

  const grid = document.getElementById('datePickerGrid');
  grid.innerHTML = cells.map(c => {
    const classes = ['mission-log-day'];
    if (c.isToday) classes.push('is-today');
    if (c.isSelected) classes.push('is-selected');
    if (c.hasData) classes.push('is-has-data');
    if (c.muted) { classes.push('is-muted'); return `<div class="${classes.join(' ')}">${c.day}</div>`; }
    const dot = c.hasData ? '<span class="mission-log-data-dot"></span>' : '';
    return `<button type="button" class="${classes.join(' ')}" data-iso="${c.iso}">${c.day}${dot}</button>`;
  }).join('');
}

function openDatePicker(inputEl, title, highlightDates) {
  const current = inputEl.value;
  const base = current ? parseISO(current) : new Date();
  datePickerViewDate = new Date(base.getFullYear(), base.getMonth(), 1);
  datePickerTargetInput = inputEl;
  datePickerHighlightDates = highlightDates || null;
  document.getElementById('datePickerTitle').textContent = title || 'Select Date';
  renderDatePickerGrid(current);
  document.getElementById('datePickerOverlay').hidden = false;
}

function initDatePicker() {
  const overlay = document.getElementById('datePickerOverlay');
  document.getElementById('btnCloseDatePicker').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
  document.getElementById('btnDatePickerPrev').addEventListener('click', () => {
    datePickerViewDate = new Date(datePickerViewDate.getFullYear(), datePickerViewDate.getMonth() - 1, 1);
    renderDatePickerGrid(datePickerTargetInput ? datePickerTargetInput.value : null);
  });
  document.getElementById('btnDatePickerNext').addEventListener('click', () => {
    datePickerViewDate = new Date(datePickerViewDate.getFullYear(), datePickerViewDate.getMonth() + 1, 1);
    renderDatePickerGrid(datePickerTargetInput ? datePickerTargetInput.value : null);
  });
  document.getElementById('btnDatePickerToday').addEventListener('click', () => {
    datePickerViewDate = new Date();
    renderDatePickerGrid(todayISO());
  });
  document.getElementById('datePickerGrid').addEventListener('click', e => {
    const btn = e.target.closest('button[data-iso]');
    if (!btn || !datePickerTargetInput) return;
    overlay.hidden = true;
    datePickerTargetInput.value = btn.dataset.iso;
    datePickerTargetInput.dispatchEvent(new Event('change', { bubbles: true }));
  });

  const titles = {
    nutDate: 'Temporal Fuel Log', bioDate: 'Temporal Entity Log',
    reviewDate: 'Week Ending', setupStartDate: 'Challenge Start', measureDate: 'Measurement Date',
    foodDiaryDateInput: 'Food Diary Date',
    coachRefeedStart: 'Refeed Start', coachRefeedEnd: 'Refeed End',
    dailyReviewDate: 'Daily Review Date', skinfoldDate: 'Caliper Entry Date',
  };
  // Each entry marks, on that input's calendar, the days that already have
  // data relevant to it — nutrition days on nutDate, etc. (trainDate uses
  // its own Temporal Mission Log calendar instead of this generic picker.)
  // Inputs with no "has logs" concept (challenge start date, refeed range
  // picks) are simply omitted, leaving their calendar plain.
  const DATE_PICKER_HIGHLIGHT_SETS = {
    nutDate: getNutritionDaysSet,
    foodDiaryDateInput: getNutritionDaysSet,
    bioDate: getBioDaysSet,
    measureDate: getMeasurementDaysSet,
    skinfoldDate: () => getLogDaysSet(hasLoggedSkinfolds),
    reviewDate: () => new Set(Object.keys(getReviews())),
    dailyReviewDate: () => {
      const reviews = getDailyReviews();
      return new Set(Object.keys(reviews).filter(d => reviews[d] && (reviews[d].struggle || reviews[d].fix)));
    },
  };
  document.querySelectorAll('.date-picker-trigger').forEach(input => {
    input.addEventListener('click', () => {
      const getHighlight = DATE_PICKER_HIGHLIGHT_SETS[input.id];
      openDatePicker(input, titles[input.id] || 'Select Date', getHighlight ? getHighlight() : null);
    });
  });

  // Fuel/Bio tabs use a single "Temporal ___ Log" button (like Training's
  // Temporal Mission Log) instead of a visible date field — the button opens
  // this same shared calendar, targeting the tab's now-hidden date input.
  const calendarBtnLinks = { btnOpenFuelLog: 'nutDate', btnOpenBioLog: 'bioDate' };
  Object.entries(calendarBtnLinks).forEach(([btnId, inputId]) => {
    const btn = document.getElementById(btnId);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
      const getHighlight = DATE_PICKER_HIGHLIGHT_SETS[inputId];
      openDatePicker(input, titles[inputId] || 'Select Date', getHighlight ? getHighlight() : null);
    });
  });
}

function initTraining() {
  document.getElementById('trainDate').value = getActiveTrainingDate();
  localStorage.setItem('wft_active_train_date', document.getElementById('trainDate').value);
  updateMissionLogBtnLabel();
  document.getElementById('trainDate').addEventListener('change', e => {
    localStorage.setItem('wft_active_train_date', e.target.value);
    loadTrainingForDate(e.target.value);
    updateMissionLogBtnLabel();
  });

  document.getElementById('btnAddExercise').addEventListener('click', () => {
    const nameInput = document.getElementById('exerciseName');
    const name = nameInput.value.trim();
    if (!name) return;
    const date = document.getElementById('trainDate').value;
    const prevSets = findPreviousSets(name, date);
    const firstSet = prevSets && prevSets[0] ? { reps: prevSets[0].reps, weightKg: prevSets[0].weightKg, completed: false } : { reps: null, weightKg: null, completed: false };
    currentExercises.push({ name, restSeconds: 180, notes: '', unit: getTrainUnit(), sets: [firstSet] });
    persistExercises();
    renderExerciseCards();
    renderExerciseNameOptions();
    nameInput.value = '';
    nameInput.focus();
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.ex-card-menu-wrap')) {
      document.querySelectorAll('.ex-card-menu').forEach(m => { m.hidden = true; });
    }
  });

  const cards = document.getElementById('exerciseCards');

  cards.addEventListener('click', e => {
    const wu = (getProfile() || {}).weightUnit || 'kg';

    const sessionContinueBtn = e.target.closest('#btnSessionContinue');
    if (sessionContinueBtn) {
      const date = document.getElementById('trainDate').value;
      setSessionFinished(date, false);
      markTrainingActivity();
      renderExerciseCards();
      renderTrainingStats();
      return;
    }

    const sessionEditBtn = e.target.closest('#btnSessionEdit');
    if (sessionEditBtn) {
      const date = document.getElementById('trainDate').value;
      setSessionFinished(date, false);
      renderExerciseCards();
      renderTrainingStats();
      return;
    }

    const sessionCompletedBtn = e.target.closest('#btnSessionCompleted');
    if (sessionCompletedBtn) {
      if (confirm('Mark this session as completed? Your logged exercises stay saved in your history.')) {
        const date = document.getElementById('trainDate').value;
        const allTimers = getExTimers();
        if (allTimers[date]) { delete allTimers[date]; saveExTimers(allTimers); }
        showRestToast('Session completed — saved to your Accomplishment Log.');
        renderExerciseCards();
        renderTrainingStats();
      }
      return;
    }

    const menuToggleBtn = e.target.closest('.ex-card-remove');
    if (menuToggleBtn) {
      const menu = menuToggleBtn.closest('.ex-card-menu-wrap').querySelector('.ex-card-menu');
      const wasOpen = !menu.hidden;
      document.querySelectorAll('.ex-card-menu').forEach(m => { m.hidden = true; });
      menu.hidden = wasOpen;
      return;
    }

    const unitBtn = e.target.closest('.ex-unit-btn');
    if (unitBtn) {
      const exIdx = parseInt(unitBtn.dataset.ex, 10);
      currentExercises[exIdx].unit = unitBtn.dataset.unit;
      persistExercises();
      renderExerciseCards();
      return;
    }

    const renameBtn = e.target.closest('.ex-menu-rename');
    if (renameBtn) {
      const exIdx = parseInt(renameBtn.dataset.ex, 10);
      const newName = prompt('Rename exercise', currentExercises[exIdx].name);
      if (newName && newName.trim()) {
        currentExercises[exIdx].name = newName.trim();
        persistExercises();
        renderExerciseCards();
        renderExerciseNameOptions();
      }
      return;
    }

    const resetBtn = e.target.closest('.ex-menu-reset');
    if (resetBtn) {
      const exIdx = parseInt(resetBtn.dataset.ex, 10);
      if (confirm('Reset all sets for this exercise? Completed checkmarks will be cleared.')) {
        currentExercises[exIdx].sets.forEach(s => { s.completed = false; });
        persistExercises();
        const date = document.getElementById('trainDate').value;
        const allTimers = getExTimers();
        if (allTimers[date]) { delete allTimers[date][exIdx]; saveExTimers(allTimers); }
        renderExerciseCards();
        renderTrainingStats();
      }
      return;
    }

    const deleteBtn = e.target.closest('.ex-menu-delete');
    if (deleteBtn) {
      const exIdx = parseInt(deleteBtn.dataset.ex, 10);
      if (confirm('Delete this exercise from today\'s session?')) {
        currentExercises.splice(exIdx, 1);
        persistExercises();
        renderExerciseCards();
        renderTrainingStats();
      }
      return;
    }

    const addSetBtn = e.target.closest('.ex-add-set');
    if (addSetBtn) {
      const exIdx = parseInt(addSetBtn.dataset.ex, 10);
      const ex = currentExercises[exIdx];
      const last = ex.sets[ex.sets.length - 1];
      const date = document.getElementById('trainDate').value;
      const prevSets = findPreviousSets(ex.name, date);
      const nextIdx = ex.sets.length;
      const fallback = prevSets && prevSets[nextIdx] ? { reps: prevSets[nextIdx].reps, weightKg: prevSets[nextIdx].weightKg } : (last ? { reps: last.reps, weightKg: last.weightKg } : { reps: null, weightKg: null });
      ex.sets.push({ reps: fallback.reps, weightKg: fallback.weightKg, completed: false });
      persistExercises(); renderExerciseCards(); return;
    }

    const removeSetBtn = e.target.closest('.ex-set-remove');
    if (removeSetBtn) {
      if (!confirm('Delete this set? This cannot be undone.')) return;
      const exIdx = parseInt(removeSetBtn.dataset.ex, 10);
      const setIdx = parseInt(removeSetBtn.dataset.set, 10);
      currentExercises[exIdx].sets.splice(setIdx, 1);
      if (!currentExercises[exIdx].sets.length) currentExercises.splice(exIdx, 1);
      persistExercises(); renderExerciseCards(); return;
    }

    const checkBtn = e.target.closest('.ex-set-check');
    if (checkBtn) {
      const exIdx = parseInt(checkBtn.dataset.ex, 10);
      const setIdx = parseInt(checkBtn.dataset.set, 10);
      const set = currentExercises[exIdx].sets[setIdx];
      set.completed = !set.completed;
      persistExercises();
      renderExerciseCards();
      renderTrainingStats();
      if (set.completed) startExerciseTimer(exIdx, currentExercises[exIdx].restSeconds || 180);
      return;
    }

    const timerBtn = e.target.closest('.ex-set-timer-btn');
    if (timerBtn) {
      const exIdx = parseInt(timerBtn.dataset.ex, 10);
      const setIdx = parseInt(timerBtn.dataset.set, 10);
      openExerciseTimerPopup(exIdx, setIdx);
      return;
    }
  });

  cards.addEventListener('change', e => {
    if (e.target.classList.contains('ex-set-reps')) {
      const exIdx = parseInt(e.target.dataset.ex, 10), setIdx = parseInt(e.target.dataset.set, 10);
      currentExercises[exIdx].sets[setIdx].reps = parseIntOrNull(e.target.value);
      persistExercises();
    } else if (e.target.classList.contains('ex-set-weight')) {
      const exIdx = parseInt(e.target.dataset.ex, 10), setIdx = parseInt(e.target.dataset.set, 10);
      const exUnit = currentExercises[exIdx].unit || getTrainUnit();
      const val = parseFloat(e.target.value);
      currentExercises[exIdx].sets[setIdx].weightKg = isNaN(val) ? null : toKg(val, exUnit);
      persistExercises();
    } else if (e.target.classList.contains('ex-card-notes')) {
      const exIdx = parseInt(e.target.dataset.ex, 10);
      currentExercises[exIdx].notes = e.target.value;
      persistExercises();
    } else if (e.target.classList.contains('ex-rest-select')) {
      const exIdx = parseInt(e.target.dataset.ex, 10);
      currentExercises[exIdx].restSeconds = parseInt(e.target.value, 10) * 60;
      persistExercises();
    }
  });

  let lastWorkoutSummary = null;
  document.getElementById('btnFinishWorkout').addEventListener('click', () => {
    persistExercises();
    const date = document.getElementById('trainDate').value;
    const summary = computeWorkoutSummary(date);
    lastWorkoutSummary = summary;
    renderWorkoutSummary(summary);
    document.getElementById('summaryOverlay').hidden = false;
    if (currentExercises.length) setSessionFinished(date, true);
    renderExerciseCards();
    renderTrainingStats();
    autoSyncLeaderboardIfOptedIn();
  });

  document.getElementById('btnCloseSummary').addEventListener('click', () => { document.getElementById('summaryOverlay').hidden = true; });
  document.getElementById('btnDoneSummary').addEventListener('click', () => { document.getElementById('summaryOverlay').hidden = true; });
  document.getElementById('btnShareSummary').addEventListener('click', async () => {
    if (!lastWorkoutSummary) return;
    const wu = lastWorkoutSummary.wu;
    const prCount = lastWorkoutSummary.exercises.filter(e => e.isPR).length;
    const vol = round0(fromKg(lastWorkoutSummary.totalVolumeKg, wu));
    let text = `💪 Just finished a Winfinity Tracker session: ${lastWorkoutSummary.exercises.length} exercises, ${lastWorkoutSummary.totalSets} sets, ${vol} ${wu} total volume.`;
    if (prCount > 0) text += ` 🏆 ${prCount} new PR${prCount > 1 ? 's' : ''}!`;
    const profile = getProfile();
    const trainDate = document.getElementById('trainDate').value || todayISO();
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const blob = await generateWorkoutSummaryShareCard({
      name: (profile && profile.name) || 'Operator',
      digitalId: getOrCreatePublicId(),
      dateTime: `${fmtDate(parseISO(trainDate))} · ${timeStr}`,
      summary: lastWorkoutSummary,
      volumeTrend: computeVolumeTrendData(),
    });
    shareViaWebShare({ title: 'Winfinity Tracker — Workout Summary', text }, blob);
  });

  loadTrainingForDate(document.getElementById('trainDate').value);
  renderTrainingStats();
  ensureExTimerTicking();
  initSessionTemplates();
  initExerciseNameAutocomplete();
  checkTrainingIdle();
  setInterval(checkTrainingIdle, 60000);
}

function renderTrainingStats() {
  const logsArr = sortedLogsArray();
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0,0,0,0);
  const recent = logsArr.filter(l => parseISO(l.date) >= cutoff);
  const workouts = recent.filter(l => l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))).length;
  const sets = recent.reduce((sum, l) => sum + (l.exercises || []).reduce((s, ex) => s + ex.sets.filter(st => st.completed).length, 0), 0);
  const profile = getProfile();
  const workoutTarget = profile && profile.coachWorkoutsPerWeek;
  document.getElementById('statWorkoutsWeek').textContent = workoutTarget ? `${workouts} / ${workoutTarget}` : workouts;
  document.getElementById('statSetsWeek').textContent = sets;
  renderPRBoard();
  renderVolumeTrendChart();
}

// Same "last 8 gym days" volume data renderVolumeTrendChart() draws as an
// SVG on the Training tab, reused here so the share cards can draw the
// identical trend as a canvas chart.
function computeVolumeTrendData() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray();
  const gymDays = logsArr.filter(l => l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed))).slice(-8);
  const volumes = gymDays.map(l => fromKg(computeDayVolumeKg(l), wu));
  const labels = gymDays.map(l => { const d = parseISO(l.date); return `${d.getMonth() + 1}/${d.getDate()}`; });
  return { wu, volumes, labels, total: round0(volumes.reduce((s, v) => s + v, 0)) };
}

function computeDayVolumeKg(entry) {
  if (!entry || !entry.exercises) return 0;
  return entry.exercises.reduce((sum, ex) =>
    sum + (ex.sets || []).filter(s => s.completed && s.weightKg != null && s.reps != null)
      .reduce((s2, s) => s2 + s.weightKg * s.reps, 0), 0);
}

function allGymDays(logsArr) {
  return logsArr.filter(l => l.exercises && l.exercises.some(ex => ex.sets.some(s => s.completed)));
}

// "Show recent" = the last 7 gym days; "Full journey" = every gym day
// ever logged — same recent/full-journey framing as the Entity Weight
// Journey chart, just toggled independently.
let volumeChartFullJourney = false;

function renderVolumeTrendChart() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray();
  const full = allGymDays(logsArr);
  const gymDays = volumeChartFullJourney ? full : full.slice(-7);
  const chart = document.getElementById('volumeTrendChart');
  const labels = document.getElementById('volumeTrendLabels');
  const emptyNote = document.getElementById('volumeTrendEmptyNote');
  const totalLabel = document.getElementById('volumeTrendTotal');
  const legend = document.getElementById('volumeTrendLegend');
  chart.innerHTML = ''; labels.innerHTML = ''; legend.innerHTML = '';
  if (!gymDays.length) {
    emptyNote.hidden = false;
    totalLabel.textContent = '';
    return;
  }
  emptyNote.hidden = true;
  const volumes = gymDays.map(l => fromKg(computeDayVolumeKg(l), wu));
  totalLabel.textContent = `${round0(volumes.reduce((s, v) => s + v, 0)).toLocaleString()} ${wu} total`;
  const max = Math.max(...volumes, 1);
  const w = 280, h = 90, pad = 6;
  const stepX = gymDays.length > 1 ? w / (gymDays.length - 1) : 0;
  const points = volumes.map((v, i) => ({
    x: gymDays.length > 1 ? i * stepX : w / 2,
    y: h - pad - (v / max) * (h - pad * 2),
  }));
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPath = `M${points[0].x.toFixed(1)},${h} ${linePath.replace(/^M/, 'L')} L${points[points.length - 1].x.toFixed(1)},${h} Z`;

  const dots = points.map((p, i) => {
    const tip = `${fmtDate(parseISO(gymDays[i].date))}: ${round0(volumes[i])} ${wu}`;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"><title>${escapeHtml(tip)}</title></circle>`;
  }).join('');

  chart.innerHTML = `
    <path d="${areaPath}" fill="var(--cyan)" opacity="0.12"></path>
    <path d="${linePath}" fill="none" stroke="var(--cyan)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <g fill="var(--cyan)">${dots}</g>
  `;
  gymDays.forEach(l => {
    const lbl = document.createElement('span');
    const d = parseISO(l.date);
    lbl.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
    labels.appendChild(lbl);
  });
  legend.innerHTML = `<button type="button" id="volumeTrendFullJourneyToggle" class="chart-toggle-link">${volumeChartFullJourney ? 'Show recent' : 'Full journey'}</button>`;
}

function initVolumeTrendToggle() {
  document.getElementById('volumeTrendLegend').addEventListener('click', e => {
    if (e.target.closest('#volumeTrendFullJourneyToggle')) {
      volumeChartFullJourney = !volumeChartFullJourney;
      renderVolumeTrendChart();
    }
  });
  document.getElementById('btnShareVolumeTrend').addEventListener('click', shareVolumeJourney);
}

/* ---- Session templates ---- */
function getSessionTemplates() {
  try { return JSON.parse(localStorage.getItem('wft_session_templates')) || []; }
  catch { return []; }
}
function saveSessionTemplates(list) { localStorage.setItem('wft_session_templates', JSON.stringify(list)); }

function renderSessionTemplateOptions() {
  const sel = document.getElementById('sessionTemplateSelect');
  const templates = getSessionTemplates();
  const current = sel.value;
  sel.innerHTML = '<option value="">— Select —</option>' +
    templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  if (templates.some(t => t.id === current)) sel.value = current;
}

function initSessionTemplates() {
  renderSessionTemplateOptions();

  document.getElementById('btnSaveTemplate').addEventListener('click', () => {
    const nameInput = document.getElementById('sessionTemplateName');
    const name = nameInput.value.trim();
    const note = document.getElementById('sessionTemplateNote');
    if (!name) { alert('Enter a name for this session.'); return; }
    if (!currentExercises.length) { alert('Add at least one exercise before saving a session.'); return; }
    const templates = getSessionTemplates();
    const templateExercises = currentExercises.map(ex => ({
      name: ex.name,
      restSeconds: ex.restSeconds,
      unit: ex.unit || getTrainUnit(),
      sets: ex.sets.map(s => ({ reps: s.reps, weightKg: s.weightKg })),
    }));
    templates.push({ id: generateShareKey(), name, exercises: templateExercises });
    saveSessionTemplates(templates);
    renderSessionTemplateOptions();
    nameInput.value = '';
    note.textContent = `Saved "${name}".`;
    setTimeout(() => { note.textContent = ''; }, 2500);
  });

  document.getElementById('btnLoadTemplate').addEventListener('click', () => {
    const id = document.getElementById('sessionTemplateSelect').value;
    if (!id) { alert('Select a session to load.'); return; }
    const template = getSessionTemplates().find(t => t.id === id);
    if (!template) return;
    if (currentExercises.length && !confirm('This replaces the exercises currently logged for this date. Continue?')) return;
    currentExercises = template.exercises.map(ex => ({
      name: ex.name,
      restSeconds: ex.restSeconds || 180,
      notes: '',
      unit: ex.unit || getTrainUnit(),
      sets: ex.sets.map(s => ({ reps: s.reps, weightKg: s.weightKg, completed: false })),
    }));
    persistExercises();
    setSessionFinished(document.getElementById('trainDate').value, false);
    renderExerciseCards();
    renderTrainingStats();
    const note = document.getElementById('sessionTemplateNote');
    note.textContent = `Loaded "${template.name}".`;
    setTimeout(() => { note.textContent = ''; }, 2500);
  });

  document.getElementById('btnDeleteTemplate').addEventListener('click', () => {
    const id = document.getElementById('sessionTemplateSelect').value;
    if (!id) { alert('Select a session to delete.'); return; }
    const templates = getSessionTemplates();
    const template = templates.find(t => t.id === id);
    if (!template || !confirm(`Delete session "${template.name}"?`)) return;
    saveSessionTemplates(templates.filter(t => t.id !== id));
    renderSessionTemplateOptions();
  });
}

/* ---- Personal records board ---- */
function computePRBoard() {
  const logs = getLogs();
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const byExercise = {};
  Object.keys(logs).sort().forEach(date => {
    (logs[date].exercises || []).forEach(ex => {
      const key = ex.name.trim().toLowerCase();
      if (!byExercise[key]) byExercise[key] = { name: ex.name.trim(), entries: [] };
      (ex.sets || []).forEach(s => {
        if (!s.completed || s.weightKg == null || s.reps == null) return;
        byExercise[key].entries.push({ date, weightKg: s.weightKg, reps: s.reps, oneRM: estOneRM(s.weightKg, s.reps) });
      });
    });
  });
  const rows = Object.values(byExercise).map(ex => {
    if (!ex.entries.length) return null;
    let best = null, prevBest = null;
    ex.entries.forEach(e => {
      if (!best || e.oneRM > best.oneRM + 0.01) { prevBest = best; best = e; }
    });
    return { name: ex.name, current: best, previous: prevBest, wu };
  }).filter(Boolean);
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

function renderPRBoard() {
  const rows = computePRBoard();
  const board = document.getElementById('prBoard');
  const empty = document.getElementById('prBoardEmpty');
  board.innerHTML = '';
  if (!rows.length) { empty.hidden = false; return; }
  empty.hidden = true;
  const fmtCompact = (weightKg, reps) => `${round2(weightKg)}kg×${reps}`;
  rows.forEach(r => {
    const curText = fmtCompact(r.current.weightKg, r.current.reps);
    const prevText = r.previous ? fmtCompact(r.previous.weightKg, r.previous.reps) : '–';
    const deltaPct = r.previous ? round2(((r.current.oneRM - r.previous.oneRM) / r.previous.oneRM) * 100) : null;
    const row = document.createElement('div');
    row.className = 'pr-board-row';
    row.innerHTML = `
      <div class="pr-board-name">${escapeHtml(r.name)}</div>
      <div class="pr-board-compare">
        <span class="pr-board-value">${prevText}</span>
        <span class="pr-board-arrow">→</span>
        <span class="pr-board-value pr-board-value--current">${curText}</span>
      </div>
      ${deltaPct != null
        ? `<div class="pr-board-delta ${deltaPct >= 0 ? 'is-up' : 'is-down'}">${deltaPct >= 0 ? '+' : ''}${deltaPct}%</div>`
        : `<div class="pr-board-delta is-up">New PR!</div>`}
    `;
    board.appendChild(row);
  });
}

/* ---- Finish workout summary + PR detection ---- */
function computeWorkoutSummary(date) {
  return computeWorkoutSummaryFromExercises(currentExercises, date);
}

function computeWorkoutSummaryFromExercises(exercisesList, date) {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  let totalVolumeKg = 0, totalSets = 0;
  const exercises = (exercisesList || []).map(ex => {
    const completed = ex.sets.filter(s => s.completed && s.weightKg != null && s.reps != null);
    const volumeKg = completed.reduce((sum, s) => sum + s.weightKg * s.reps, 0);
    totalVolumeKg += volumeKg;
    totalSets += completed.length;
    const bestOneRM = completed.reduce((max, s) => Math.max(max, estOneRM(s.weightKg, s.reps)), 0);
    const historicalBest = bestHistoricalOneRM(ex.name, date);
    const isPR = completed.length > 0 && historicalBest > 0 && bestOneRM > historicalBest + 0.01;
    const topSet = completed.reduce((best, s) => (!best || s.weightKg > best.weightKg) ? s : best, null);
    return {
      name: ex.name,
      completedSets: completed.length,
      volumeKg,
      isPR,
      topWeightKg: topSet ? topSet.weightKg : null,
      topReps: topSet ? topSet.reps : null,
    };
  });
  return { exercises, totalVolumeKg, totalSets, wu };
}

function renderWorkoutSummary(summary) {
  const content = document.getElementById('summaryContent');
  const wu = summary.wu;
  const prCount = summary.exercises.filter(e => e.isPR).length;
  let html = `<div class="summary-stats">
    <div class="stat-tile"><div class="stat-tile-value">${summary.exercises.length}</div><div class="stat-tile-label">Exercises</div></div>
    <div class="stat-tile"><div class="stat-tile-value">${summary.totalSets}</div><div class="stat-tile-label">Sets</div></div>
    <div class="stat-tile"><div class="stat-tile-value">${round0(fromKg(summary.totalVolumeKg, wu))}</div><div class="stat-tile-label">Volume (${wu})</div></div>
  </div>`;
  if (prCount > 0) {
    html += `<p style="text-align:center;color:var(--warning);font-family:var(--font-mono);font-size:0.8rem;margin-bottom:10px;">🏆 ${prCount} new personal record${prCount > 1 ? 's' : ''}!</p>`;
  }
  if (!summary.exercises.length) {
    html += `<p class="empty-note">No exercises logged for this date.</p>`;
  }
  summary.exercises.forEach(ex => {
    html += `<div class="summary-ex-row">
      <div>
        <div class="summary-ex-name">${escapeHtml(ex.name)}</div>
        <div class="summary-ex-meta">${ex.completedSets} sets · ${round0(fromKg(ex.volumeKg, wu))} ${wu} volume${ex.topWeightKg != null ? ` · Top: ${round0(fromKg(ex.topWeightKg, wu))} ${wu} × ${ex.topReps} reps` : ''}</div>
      </div>
      ${ex.isPR ? '<span class="pr-pill">🏆 PR</span>' : ''}
    </div>`;
  });
  content.innerHTML = html;
}

/* ---- Per-exercise rest timers ---- */
let exTimerTickId = null;
let notifyPermissionAsked = false;

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------------------------------------------------------------- */
/* Exercise hold timer popup (Dead Hang, etc.)                        */
/* ---------------------------------------------------------------- */
let exTimerPopupState = null; // { exIdx, setIdx, phase: 'idle'|'countdown'|'running', intervalId, countdownId, startedAt }

function openExerciseTimerPopup(exIdx, setIdx) {
  exTimerPopupState = { exIdx, setIdx, phase: 'idle', intervalId: null, startedAt: null };
  const overlay = document.getElementById('exerciseTimerOverlay');
  const display = document.getElementById('exerciseTimerDisplay');
  document.getElementById('exerciseTimerLabel').textContent = (currentExercises[exIdx] || {}).name || 'Timer';
  display.textContent = 'Ready';
  display.className = 'timer-popup-display';
  document.getElementById('btnExerciseTimerStart').hidden = false;
  document.getElementById('btnExerciseTimerStart').disabled = false;
  document.getElementById('btnExerciseTimerStop').hidden = true;
  overlay.hidden = false;
}

function closeExerciseTimerPopup() {
  if (exTimerPopupState && exTimerPopupState.intervalId) clearInterval(exTimerPopupState.intervalId);
  if (exTimerPopupState && exTimerPopupState.countdownId) clearInterval(exTimerPopupState.countdownId);
  exTimerPopupState = null;
  document.getElementById('exerciseTimerOverlay').hidden = true;
}

// startCount defaults to a full 5s "get ready" countdown; skipExerciseCountdown
// below restarts this at 2s instead, for tapping the circle mid-countdown to
// fast-forward through the wait rather than sitting through the rest of it.
function startExerciseHoldCountdown(startCount) {
  if (!exTimerPopupState || (exTimerPopupState.phase !== 'idle' && exTimerPopupState.phase !== 'countdown')) return;
  exTimerPopupState.phase = 'countdown';
  const display = document.getElementById('exerciseTimerDisplay');
  display.className = 'timer-popup-display is-counting-in';
  document.getElementById('btnExerciseTimerStart').disabled = true;

  let count = startCount || 5;
  display.textContent = String(count);
  if (navigator.vibrate) navigator.vibrate(80);
  playBeep();
  exTimerPopupState.countdownId = setInterval(() => {
    count -= 1;
    if (count > 0) {
      display.textContent = String(count);
      if (navigator.vibrate) navigator.vibrate(80);
      playBeep();
      return;
    }
    clearInterval(exTimerPopupState.countdownId);
    if (!exTimerPopupState) return; // popup was closed mid-countdown
    beginExerciseHoldStopwatch();
  }, 1000);
}

// Tapping the big circle while it's already counting down skips ahead to a
// final 2-second stretch instead of waiting out the full 5 — for when
// you're already set up and ready before the countdown finishes.
function skipExerciseCountdown() {
  if (!exTimerPopupState || exTimerPopupState.phase !== 'countdown') return;
  clearInterval(exTimerPopupState.countdownId);
  startExerciseHoldCountdown(2);
}

function beginExerciseHoldStopwatch() {
  exTimerPopupState.phase = 'running';
  exTimerPopupState.startedAt = Date.now();
  const display = document.getElementById('exerciseTimerDisplay');
  display.className = 'timer-popup-display is-running';
  display.textContent = formatTime(0);
  document.getElementById('btnExerciseTimerStart').hidden = true;
  document.getElementById('btnExerciseTimerStop').hidden = false;
  if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  playBeep();

  exTimerPopupState.intervalId = setInterval(() => {
    const elapsed = Math.round((Date.now() - exTimerPopupState.startedAt) / 1000);
    display.textContent = formatTime(elapsed);
  }, 250);
}

function stopExerciseHold() {
  if (!exTimerPopupState || exTimerPopupState.phase !== 'running') return;
  clearInterval(exTimerPopupState.intervalId);
  // -2s reaction-time compensation: the phone is typically set down at a
  // distance during a hold, not in hand, so there's a real gap between
  // actually letting go and reaching over to tap the stop circle. Trims
  // that lag back out of the recorded duration.
  const elapsedSec = Math.max(0, Math.round((Date.now() - exTimerPopupState.startedAt) / 1000) - 2);
  const { exIdx, setIdx } = exTimerPopupState;
  if (currentExercises[exIdx] && currentExercises[exIdx].sets[setIdx]) {
    currentExercises[exIdx].sets[setIdx].reps = elapsedSec;
    persistExercises();
    renderExerciseCards();
  }
  if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]);
  playBeep();
  closeExerciseTimerPopup();
}

// The big circle itself is tappable — same actions as the Start/Stop
// buttons below it, dispatched by whichever phase is currently active, so
// it doubles as the large, easy-to-hit target the buttons already are.
function handleTimerDisplayTap() {
  if (!exTimerPopupState) return;
  if (exTimerPopupState.phase === 'idle') startExerciseHoldCountdown();
  else if (exTimerPopupState.phase === 'countdown') skipExerciseCountdown();
  else if (exTimerPopupState.phase === 'running') stopExerciseHold();
}

function initExerciseTimerPopup() {
  const overlay = document.getElementById('exerciseTimerOverlay');
  document.getElementById('btnExerciseTimerStart').addEventListener('click', () => startExerciseHoldCountdown());
  document.getElementById('btnExerciseTimerStop').addEventListener('click', stopExerciseHold);
  document.getElementById('exerciseTimerDisplay').addEventListener('click', handleTimerDisplayTap);
  document.getElementById('btnCloseExerciseTimer').addEventListener('click', closeExerciseTimerPopup);
  bindOverlayBackdropClose(overlay, closeExerciseTimerPopup);
}

function getExTimers() {
  try { return JSON.parse(localStorage.getItem('wft_ex_timers')) || {}; } catch (e) { return {}; }
}
function saveExTimers(obj) { localStorage.setItem('wft_ex_timers', JSON.stringify(obj)); }

function exTimerDisplayFor(date, exIdx) {
  const day = getExTimers()[date];
  const t = day && day[exIdx];
  if (!t) return { text: '—', state: '' };
  const remaining = Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
  if (remaining <= 0) return { text: 'Done', state: 'is-done' };
  return { text: formatTime(remaining), state: 'is-active' };
}

function startExerciseTimer(exIdx, seconds) {
  const date = document.getElementById('trainDate').value;
  const all = getExTimers();
  if (!all[date]) all[date] = {};
  all[date][exIdx] = { endAt: Date.now() + seconds * 1000, duration: seconds, done: false, exName: (currentExercises[exIdx] || {}).name || '' };
  saveExTimers(all);
  if (window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
    notifyPermissionAsked = true;
    Notification.requestPermission().catch(() => {});
  }
  ensureExTimerTicking();
  renderExerciseTimerDisplays();
}

function ensureExTimerTicking() {
  if (exTimerTickId) return;
  exTimerTickId = setInterval(renderExerciseTimerDisplays, 1000);
}

function showRestToast(message) {
  const toast = document.getElementById('restToast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function showAppReminder(message) {
  const toast = document.getElementById('restToast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.hidden = true; }, 7000);
}

function checkDataReminder() {
  const profile = getProfile();
  if (!profile) return;
  if (sessionStorage.getItem('wft_data_reminder_shown')) return;

  const logs = getLogs();
  const completeDates = Object.keys(logs)
    .filter(d => logs[d].calories != null && logs[d].weightKg != null)
    .sort();
  const lastComplete = completeDates.length ? completeDates[completeDates.length - 1] : null;

  const today = parseISO(todayISO());
  let daysSince;
  if (lastComplete) {
    daysSince = Math.round((today - parseISO(lastComplete)) / 86400000);
  } else if (profile.startDate) {
    daysSince = Math.round((today - parseISO(profile.startDate)) / 86400000);
  } else {
    return;
  }

  if (daysSince > 3) {
    sessionStorage.setItem('wft_data_reminder_shown', '1');
    const message = 'Fill up the fuel datas and weigh ins at least completely to keep the app working, thank you.';
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    playBeep();
    showAppReminder(message);
    if (window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
      notifyPermissionAsked = true;
      Notification.requestPermission().then(() => fireSystemNotification('Winfinity Tracker', message)).catch(() => {});
    } else {
      fireSystemNotification('Winfinity Tracker', message);
    }
  }
}

/* Best-effort only: a PWA can't wake up in the background at an exact time,
   so this fires the first time the app happens to be opened on/after Sunday
   8am, once per week (not a guaranteed exact-8am alarm). */
function checkMeasurementReminder() {
  const profile = getProfile();
  if (!profile) return;
  const now = new Date();
  if (now.getDay() !== 0 || now.getHours() < 8) return;
  const weekKey = todayISO();
  if (localStorage.getItem('wft_measure_reminder_shown') === weekKey) return;
  localStorage.setItem('wft_measure_reminder_shown', weekKey);

  const message = 'Sunday check-in: update your body measurements today.';
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  playBeep();
  showAppReminder(message);
  if (window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
    notifyPermissionAsked = true;
    Notification.requestPermission().then(() => fireSystemNotification('Winfinity Tracker', message)).catch(() => {});
  } else {
    fireSystemNotification('Winfinity Tracker', message);
  }
}

/* Best-effort only, same caveat as the other periodic reminders — fires the
   first time the app is opened on a Saturday night (6pm-midnight local time),
   once per Saturday, showing a donation prompt after the splash screen. */
function isSaturdayNightNow() {
  const now = new Date();
  return now.getDay() === 6 && now.getHours() >= 18;
}

function checkDonationPrompt() {
  if (!isSaturdayNightNow()) return;
  const todayKey = todayISO();
  if (localStorage.getItem('wft_donation_shown') === todayKey) return;
  localStorage.setItem('wft_donation_shown', todayKey);
  document.getElementById('donationPromptView').hidden = false;
  document.getElementById('donationQrView').hidden = true;
  document.getElementById('donationOverlay').hidden = false;
}

function openDonationQr() {
  document.getElementById('donationPromptView').hidden = true;
  document.getElementById('donationQrView').hidden = false;
  document.getElementById('donationOverlay').hidden = false;
}

function initDonationPrompt() {
  const overlay = document.getElementById('donationOverlay');
  document.getElementById('btnDonationIgnore').addEventListener('click', () => { overlay.hidden = true; });
  document.getElementById('btnDonationSure').addEventListener('click', openDonationQr);
  document.getElementById('btnDonationQrClose').addEventListener('click', () => { overlay.hidden = true; });
  // Stop any tap inside the card (the QR image especially — reported
  // closing the popup on some mobile browsers when tapped, e.g. from a
  // long-press "save image" gesture leaking a click through afterward)
  // from ever reaching the backdrop listener below, instead of relying on
  // a target === overlay check that some browsers don't honor reliably.
  document.querySelector('.donation-card').addEventListener('click', e => e.stopPropagation());
  overlay.addEventListener('click', () => { overlay.hidden = true; });
}

function fireSystemNotification(title, body) {
  if (!window.Notification || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => { n.close(); window.focus(); };
  } catch (e) { /* ignore */ }
}

/* ---------------------------------------------------------------- */
/* Web Push (real background notifications)                            */
/* Unlike fireSystemNotification() above, this delivers even with the  */
/* app fully closed and the phone locked — the tradeoff is it needs a  */
/* server (the send-push Edge Function) to trigger it, so for now it's */
/* only wired to new DM messages (see notify_dm_push() in              */
/* supabase_push_notifications_migration.sql), not the scheduled       */
/* reminders, which still use the foreground-only path above.          */
/* ---------------------------------------------------------------- */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !sbConfigured()) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const json = sub.toJSON();
    const { error } = await sb.rpc('upsert_push_subscription', {
      p_share_key: getOrCreateShareKey(),
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
    });
    if (error) throw error;
    localStorage.setItem('wft_push_enabled', '1');
    // First-time subscribers may already have hydration reminders configured
    // locally from before this feature existed — push those up now instead
    // of waiting for them to re-open and re-save that settings screen.
    const profile = getProfile();
    if (profile && profile.hydrationReminders) syncReminderSettingsToServer(profile.hydrationReminders);
    return true;
  } catch (e) {
    return false;
  }
}

async function unsubscribeFromPush() {
  localStorage.setItem('wft_push_enabled', '0');
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      if (sbConfigured()) await sb.rpc('delete_push_subscription', { p_endpoint: endpoint });
    }
  } catch (e) { /* best effort */ }
}

// Native Android app: the browser Push API (PushManager) this whole file
// otherwise relies on doesn't exist in a bare Capacitor WebView at all —
// same root cause as Google Sign-In and Web Share being unavailable there.
// Firebase Cloud Messaging via @capacitor/push-notifications is the native
// equivalent; the token it produces is stored in fcm_tokens (parallel to
// push_subscriptions) and the send-push Edge Function delivers to both.
function initNativePushNotifications(toggle, hint) {
  const { PushNotifications } = window.Capacitor.Plugins;
  const wasEnabled = localStorage.getItem('wft_push_enabled') === '1';
  toggle.checked = wasEnabled;

  PushNotifications.addListener('registration', async (token) => {
    const value = token && token.value;
    if (!value) return;
    localStorage.setItem('wft_fcm_token', value);
    localStorage.setItem('wft_push_enabled', '1');
    toggle.checked = true;
    if (sbConfigured()) {
      try { await sb.rpc('upsert_fcm_token', { p_share_key: getOrCreateShareKey(), p_token: value }); }
      catch (e) { /* best effort */ }
    }
  });
  PushNotifications.addListener('registrationError', () => {
    toggle.checked = false;
    if (hint) hint.textContent = 'Could not enable on this device.';
  });

  toggle.addEventListener('change', async () => {
    if (toggle.checked) {
      try {
        const perm = await PushNotifications.requestPermissions();
        if (perm.receive !== 'granted') { toggle.checked = false; return; }
        await PushNotifications.register();
      } catch (e) {
        toggle.checked = false;
        if (hint) hint.textContent = 'Could not enable on this device.';
      }
    } else {
      localStorage.setItem('wft_push_enabled', '0');
      const token = localStorage.getItem('wft_fcm_token');
      if (token && sbConfigured()) {
        try { await sb.rpc('delete_fcm_token', { p_token: token }); } catch (e) { /* best effort */ }
      }
    }
  });

  // Re-register silently on load if previously opted in and permission is
  // still granted (mirrors the web path's silent re-subscribe).
  if (wasEnabled) {
    PushNotifications.checkPermissions().then(perm => {
      if (perm.receive === 'granted') PushNotifications.register();
    });
  }
}

function initPushNotifications() {
  const toggle = document.getElementById('pushNotifToggle');
  const hint = document.getElementById('pushNotifHint');
  if (!toggle) return;
  if (isNativeApp() && window.Capacitor.Plugins.PushNotifications) {
    initNativePushNotifications(toggle, hint);
    return;
  }
  // Some Android TWA/WebView environments support ServiceWorker + PushManager
  // while leaving window.Notification entirely undefined — check for all
  // three so unsupported devices get a clear disabled state instead of a
  // silent crash before the toggle's change listener ever attaches.
  const supported = ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
  if (!supported) {
    toggle.disabled = true;
    if (hint) hint.textContent = 'Not supported in this app’s browser engine.';
    return;
  }
  try {
    const wasEnabled = localStorage.getItem('wft_push_enabled') === '1';
    toggle.checked = wasEnabled && Notification.permission === 'granted';
    toggle.addEventListener('change', async () => {
      if (toggle.checked) {
        try {
          if (Notification.permission !== 'granted') {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { toggle.checked = false; return; }
          }
          const ok = await subscribeToPush();
          if (!ok) { toggle.checked = false; if (hint) hint.textContent = 'Could not enable — check your connection and try again.'; }
        } catch (e) {
          toggle.checked = false;
          if (hint) hint.textContent = 'Could not enable on this device.';
        }
      } else {
        await unsubscribeFromPush();
      }
    });
    // Re-subscribe silently on load if previously opted in (e.g. the browser
    // dropped the old subscription) and permission is still granted.
    if (toggle.checked) subscribeToPush();
  } catch (e) {
    toggle.disabled = true;
    if (hint) hint.textContent = 'Not supported in this app’s browser engine.';
  }
}

/* ---------------------------------------------------------------- */
/* Hydration reminders                                                 */
/* Best-effort only (same caveat as checkMeasurementReminder): a PWA   */
/* can't wake up in the background at an exact time, so a clock-based  */
/* schedule is checked every few minutes while the app is open, plus   */
/* real-time nudges tied to actual cardio start/stop events.           */
/* ---------------------------------------------------------------- */
function isHydrationRemindersEnabled() {
  const profile = getProfile();
  return !!(profile && profile.hydrationReminders && profile.hydrationReminders.enabled);
}

function timeStrToMin(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
}
function minToTimeStr(min) {
  min = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

// Builds today's reminder slots from the hydration-schedule guidance:
// wake-up, 30 min before each meal, hourly through waking hours (skipping
// slots too close to another one), and a wind-down slot 2h before bed.
function getHydrationSchedule(profile) {
  const hr = (profile && profile.hydrationReminders) || {};
  if (!hr.enabled) return [];
  const wakeMin = timeStrToMin(hr.wakeTime || '07:00');
  const bedMin = timeStrToMin(hr.bedTime || '22:00');
  const meals = (hr.mealTimes && hr.mealTimes.length === 3) ? hr.mealTimes : ['07:00', '12:00', '19:00'];
  const mealLabels = ['Breakfast', 'Lunch', 'Dinner'];

  const slots = [{
    id: 'wake', time: minToTimeStr(wakeMin),
    message: 'Morning! Drink 1-2 glasses of water (~250-500 mL) to rehydrate after sleep.',
  }];

  meals.forEach((mt, i) => {
    slots.push({
      id: 'meal' + i, time: minToTimeStr(timeStrToMin(mt) - 30),
      message: `Drink a glass of water (~250 mL) before ${mealLabels[i].toLowerCase()} to prep digestion.`,
    });
  });

  if (hr.hourlyEnabled !== false) {
    const cutoff = bedMin - 120;
    for (let m = wakeMin + 60; m < cutoff; m += 60) {
      const tooClose = slots.some(s => Math.abs(timeStrToMin(s.time) - m) < 20);
      if (!tooClose) slots.push({ id: 'hourly' + m, time: minToTimeStr(m), message: 'Time for a cup of water (~250 mL).' });
    }
  }

  slots.push({
    id: 'bed', time: minToTimeStr(bedMin - 120),
    message: "If you're thirsty, a small glass now — then taper off fluids before bed so you're not up at night.",
  });

  return slots;
}

function fireHydrationReminder(message) {
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  playBeep();
  showAppReminder('💧 ' + message);
  if (window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
    notifyPermissionAsked = true;
    Notification.requestPermission().then(() => fireSystemNotification('💧 Hydration reminder', message)).catch(() => {});
  } else {
    fireSystemNotification('💧 Hydration reminder', message);
  }
}

function checkHydrationReminders() {
  const profile = getProfile();
  if (!profile || !isHydrationRemindersEnabled()) return;
  const schedule = getHydrationSchedule(profile);
  if (!schedule.length) return;

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const firedKey = 'wft_hydration_fired_' + todayISO();
  let fired;
  try { fired = JSON.parse(localStorage.getItem(firedKey)) || []; } catch (e) { fired = []; }

  schedule.forEach(slot => {
    const slotMin = timeStrToMin(slot.time);
    if (nowMin >= slotMin && nowMin < slotMin + 10 && !fired.includes(slot.id)) {
      fired.push(slot.id);
      localStorage.setItem(firedKey, JSON.stringify(fired));
      fireHydrationReminder(slot.message);
    }
  });
}

function cleanupOldHydrationFiredKeys() {
  const todayKey = 'wft_hydration_fired_' + todayISO();
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith('wft_hydration_fired_') && k !== todayKey) localStorage.removeItem(k);
  });
}

let cardioHydrationIntervalId = null;

function startCardioHydrationReminders() {
  if (!isHydrationRemindersEnabled()) return;
  fireHydrationReminder('Sip some water before you start (~6-12 oz / 175-350 mL).');
  cardioHydrationIntervalId = setInterval(() => {
    fireHydrationReminder('Sip 6-12 oz (~175-350 mL) of water — stay ahead of sweat loss.');
  }, 12 * 60 * 1000);
}

function stopCardioHydrationReminders() {
  if (cardioHydrationIntervalId) { clearInterval(cardioHydrationIntervalId); cardioHydrationIntervalId = null; }
  if (!isHydrationRemindersEnabled()) return;
  fireHydrationReminder('Rehydrate! Drink 16-24 oz (~500-700 mL) to replenish sweat loss.');
}

function loadHydroReminderSettings() {
  const p = getProfile();
  const hr = (p && p.hydrationReminders) || {};
  document.getElementById('hydroRemindersEnabled').checked = !!hr.enabled;
  document.getElementById('hydroWakeTime').value = hr.wakeTime || '07:00';
  document.getElementById('hydroBedTime').value = hr.bedTime || '22:00';
  const meals = (hr.mealTimes && hr.mealTimes.length === 3) ? hr.mealTimes : ['07:00', '12:00', '19:00'];
  document.getElementById('hydroMeal0').value = meals[0];
  document.getElementById('hydroMeal1').value = meals[1];
  document.getElementById('hydroMeal2').value = meals[2];
  document.getElementById('hydroHourlyEnabled').checked = hr.hourlyEnabled !== false;
  document.getElementById('logRemindersEnabled').checked = !!hr.logRemindersEnabled;
  document.getElementById('progressPhotoReminderEnabled').checked = !!hr.progressPhotoReminderEnabled;
  document.getElementById('hydroReminderFields').style.display = hr.enabled ? '' : 'none';
}

// Pushes reminder schedule + timezone to Supabase so the check-reminders
// Edge Function can fire Start/End Day Log and hydration pushes on a
// schedule, even with the app closed — the local-only path above
// (checkHydrationReminders) only works while the app's own JS is running.
// Best-effort: if it fails (offline, Nexus not configured), the reminders
// still work locally, they just won't reach you in the background.
async function syncReminderSettingsToServer(hr) {
  if (!sbConfigured()) return;
  try {
    const shareKey = getOrCreateShareKey();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    await sb.rpc('upsert_reminder_settings', {
      p_share_key: shareKey,
      p_timezone: timezone,
      p_hydration_enabled: !!hr.enabled,
      p_wake_time: hr.wakeTime || '07:00',
      p_bed_time: hr.bedTime || '22:00',
      p_meal_times: hr.mealTimes || ['07:00', '12:00', '19:00'],
      p_hourly_enabled: hr.hourlyEnabled !== false,
      p_log_reminders_enabled: !!hr.logRemindersEnabled,
      p_progress_photo_enabled: !!hr.progressPhotoReminderEnabled,
    });
  } catch (e) { /* best effort — local reminders still work */ }
}

function initHydrationReminderSettings() {
  loadHydroReminderSettings();
  const enabledToggle = document.getElementById('hydroRemindersEnabled');
  enabledToggle.addEventListener('change', () => {
    document.getElementById('hydroReminderFields').style.display = enabledToggle.checked ? '' : 'none';
  });
  document.getElementById('btnSaveHydroReminders').addEventListener('click', () => {
    const profile = getProfile();
    if (!profile) { document.getElementById('hydroSaveNote').textContent = 'Finish your Bio profile setup first.'; return; }
    profile.hydrationReminders = {
      enabled: document.getElementById('hydroRemindersEnabled').checked,
      wakeTime: document.getElementById('hydroWakeTime').value || '07:00',
      bedTime: document.getElementById('hydroBedTime').value || '22:00',
      mealTimes: [
        document.getElementById('hydroMeal0').value || '07:00',
        document.getElementById('hydroMeal1').value || '12:00',
        document.getElementById('hydroMeal2').value || '19:00',
      ],
      hourlyEnabled: document.getElementById('hydroHourlyEnabled').checked,
      logRemindersEnabled: document.getElementById('logRemindersEnabled').checked,
      progressPhotoReminderEnabled: document.getElementById('progressPhotoReminderEnabled').checked,
    };
    saveProfile(profile);
    document.getElementById('hydroSaveNote').textContent = 'Reminder schedule saved.';
    setTimeout(() => { document.getElementById('hydroSaveNote').textContent = ''; }, 2500);
    if (profile.hydrationReminders.enabled && window.Notification && Notification.permission === 'default' && !notifyPermissionAsked) {
      notifyPermissionAsked = true;
      Notification.requestPermission().catch(() => {});
    }
    checkHydrationReminders();
    syncReminderSettingsToServer(profile.hydrationReminders);
  });
}

function fireRestComplete(exName) {
  if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  playBeep();
  showRestToast(`⏱ Rest complete — ${exName || 'back to it'}!`);
  fireSystemNotification('Rest complete', `${exName || 'Exercise'} — time to lift!`);
}

function renderExerciseTimerDisplays() {
  const date = document.getElementById('trainDate').value;
  const all = getExTimers();
  const day = all[date] || {};
  let anyActive = false;
  let changed = false;
  Object.keys(day).forEach(exIdx => {
    const t = day[exIdx];
    const remaining = Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
    const el = document.querySelector(`.ex-rest-timer[data-ex="${exIdx}"]`);
    if (remaining > 0) {
      anyActive = true;
      if (el) { el.textContent = formatTime(remaining); el.classList.add('is-active'); el.classList.remove('is-done'); }
    } else {
      if (el) { el.textContent = 'Done'; el.classList.remove('is-active'); el.classList.add('is-done'); }
      if (!t.done) {
        t.done = true;
        changed = true;
        fireRestComplete(t.exName);
      }
    }
  });
  if (changed) saveExTimers(all);
  syncTrainingWidget(day);
}

// Training has no single continuous "session timer" the way Cardio does —
// the closest equivalent to "something is actively happening right now" is
// a rest countdown ticking between sets (see startExerciseTimer/
// renderExerciseTimerDisplays above, which this piggybacks on — it already
// runs every second for as long as the app has ever started a rest timer
// this session). "cooldown" (icon-only, tap finishes) vs "idle" (icon-only,
// tap starts) both use the same layout on the native side — see
// TrainingWidgetProvider — differing only in which icon/action is shown.
function syncTrainingWidget(day) {
  if (!isNativeApp() || !window.Capacitor.Plugins.WidgetBridge) return;
  let active = null;
  Object.keys(day).forEach(exIdx => {
    const t = day[exIdx];
    const remaining = Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
    if (remaining > 0 && !active) active = { exName: t.exName, remaining };
  });
  let state = 'idle', exerciseName = '', timerText = '';
  if (active) {
    state = 'active';
    exerciseName = active.exName;
    timerText = formatTime(active.remaining);
  } else if (currentExercises.some(ex => ex.sets.some(s => s.completed))) {
    state = 'cooldown';
  }
  window.Capacitor.Plugins.WidgetBridge.updateTrainingWidget({ state, exerciseName, timerText }).catch(() => {});
}

const ALARM_TONE_PRESETS = {
  chime: [{ freq: 880, t: 0 }, { freq: 880, t: 0.3 }, { freq: 880, t: 0.6 }],
  beep: [{ freq: 1000, t: 0 }],
  digital: [{ freq: 660, t: 0 }, { freq: 660, t: 0.12 }, { freq: 660, t: 0.24 }],
  bell: [{ freq: 1200, t: 0 }, { freq: 900, t: 0.35 }],
};

function getAlarmTone() {
  return localStorage.getItem('wft_alarm_tone') || 'chime';
}

function playAlarmTone(toneId) {
  const notes = ALARM_TONE_PRESETS[toneId] || ALARM_TONE_PRESETS.chime;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    notes.forEach(({ freq, t }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.32);
    });
  } catch (e) { /* Web Audio unavailable; vibration still fires */ }
}

function playBeep() { playAlarmTone(getAlarmTone()); }

/* ---------------------------------------------------------------- */
/* Nutrition                                                            */
/* ---------------------------------------------------------------- */
/* ---------------------------------------------------------------- */
/* Food Diary (meal-categorized food logging)                          */
/* ---------------------------------------------------------------- */
const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snacks'];
const MEAL_LABELS = { breakfast: '🌅 Breakfast', lunch: '☀️ Lunch', dinner: '🌙 Dinner', snacks: '🍎 Snacks' };

function getMealsForDate(date) {
  const logs = getLogs();
  const stored = logs[date] && logs[date].meals;
  return {
    breakfast: (stored && stored.breakfast) || [],
    lunch: (stored && stored.lunch) || [],
    dinner: (stored && stored.dinner) || [],
    snacks: (stored && stored.snacks) || [],
  };
}

function computeMealsNutritionTotals(meals) {
  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sodium: 0 };
  MEAL_TYPES.forEach(mt => {
    (meals[mt] || []).forEach(item => {
      totals.calories += item.calories || 0;
      totals.protein += item.protein || 0;
      totals.carbs += item.carbs || 0;
      totals.fat += item.fat || 0;
      totals.fiber += item.fiber || 0;
      totals.sodium += item.sodium || 0;
    });
  });
  return totals;
}

// Once the Food Diary is used for a date, it owns that date's flat nutrition
// totals going forward (they're recomputed here) — the manual Today Intake
// Log Entry fields still work standalone for dates that never touch this.
function saveMealsForDate(date, meals) {
  const totals = computeMealsNutritionTotals(meals);
  updateLogFields(date, {
    meals,
    calories: round0(totals.calories),
    protein: round0(totals.protein),
    carbs: round0(totals.carbs),
    fat: round0(totals.fat),
    fiber: round0(totals.fiber),
    sodium: round0(totals.sodium),
  });
}

function refreshFuelViewsForDate(date) {
  loadNutritionForDate(date);
  renderNutritionTargets();
  renderNutritionAverages();
  updateTabDots();
}

let editingMealItem = null; // { meal, idx } while a meal-item row is in edit mode
// Per-100g rate captured once when edit mode opens (mirrors
// customFoodAiPer100g in the Add Food flow) — used to scale calories/macros
// as the serving qty/unit change, without needing a re-render on every
// keystroke. Calories skip this scaling while locked via the chain toggle.
let mealEditPer100g = null;
let mealEditCaloriesLocked = false;

function renderFoodDiary(date) {
  const meals = getMealsForDate(date);
  MEAL_TYPES.forEach(mt => {
    const container = document.getElementById(`mealItems_${mt}`);
    const totalEl = document.getElementById(`mealTotal_${mt}`);
    const items = meals[mt];
    container.innerHTML = items.length ? items.map((item, idx) => {
      if (editingMealItem && editingMealItem.meal === mt && editingMealItem.idx === idx) {
        const qty = item.qty != null ? item.qty : (item.grams != null ? item.grams : '');
        const unit = item.unit || 'g';
        return `
      <div class="meal-item-row meal-item-row--edit">
        <div class="meal-item-edit-form">
          <div>
            <span class="field-label">Food name</span>
            <input type="text" class="meal-edit-name" value="${escapeHtml(item.name)}">
          </div>
          <div class="field-row">
            <div><span class="field-label">Serving</span><input type="number" class="meal-edit-qty" value="${qty}"></div>
            <div><span class="field-label">Unit</span>
              <select class="meal-edit-unit">
                ${Object.keys(SERVING_UNITS).map(u => `<option value="${u}"${u === unit ? ' selected' : ''}>${SERVING_UNITS[u].label}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field-row">
            <div>
              <span class="field-label meal-edit-calories-label">
                Calories
                <button type="button" class="meal-edit-chain-btn" aria-label="Lock calories to this serving" aria-pressed="false" title="Lock calories so they don't change with serving size">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="12" r="3.5"/><circle cx="17" cy="12" r="3.5"/><line class="chain-link-line" x1="10.2" y1="12" x2="13.8" y2="12"/></svg>
                </button>
              </span>
              <input type="number" class="meal-edit-calories" value="${round0(item.calories)}">
            </div>
            <div><span class="field-label">Protein g</span><input type="number" class="meal-edit-protein" value="${round0(item.protein)}"></div>
          </div>
          <div class="field-row">
            <div><span class="field-label">Carbs g</span><input type="number" class="meal-edit-carbs" value="${round0(item.carbs)}"></div>
            <div><span class="field-label">Fat g</span><input type="number" class="meal-edit-fat" value="${round0(item.fat)}"></div>
          </div>
          <div class="btn-row">
            <button type="button" class="btn btn--primary btn--sm meal-item-save" data-meal="${mt}" data-idx="${idx}">Save</button>
            <button type="button" class="btn btn--sm meal-item-cancel-edit">Cancel</button>
          </div>
        </div>
      </div>
        `;
      }
      return `
      <div class="meal-item-row">
        <div class="meal-item-info">
          <div class="meal-item-name">${escapeHtml(item.name)}</div>
          <div class="meal-item-meta">${item.qty != null ? formatServingQty(item.qty, item.unit) + ' · ' : (item.grams ? round0(item.grams) + 'g · ' : '')}${round0(item.calories)} kcal</div>
        </div>
        <select class="meal-item-move" data-meal="${mt}" data-idx="${idx}">
          ${MEAL_TYPES.map(m2 => `<option value="${m2}" ${m2 === mt ? 'selected' : ''}>${m2.charAt(0).toUpperCase() + m2.slice(1)}</option>`).join('')}
        </select>
        <button type="button" class="meal-item-edit-btn" data-meal="${mt}" data-idx="${idx}" aria-label="Edit">✎</button>
        <button type="button" class="meal-item-remove" data-meal="${mt}" data-idx="${idx}" aria-label="Remove">✕</button>
      </div>
    `;
    }).join('') : '<p class="empty-note">No items yet.</p>';
    const mealTotalKcal = items.reduce((s, i) => s + (i.calories || 0), 0);
    totalEl.textContent = round0(mealTotalKcal) + ' kcal';
  });
  if (editingMealItem) wireMealItemEditForm(meals);
}

// Live-scales calories/protein/carbs/fat as the serving qty/unit change,
// same math as recomputeCustomFoodFromAi() in the Add Food flow — computed
// once per edit session (not re-run on every keystroke) so typing doesn't
// fight a re-render or lose cursor position.
function wireMealItemEditForm(meals) {
  const form = document.querySelector('.meal-item-edit-form');
  if (!form) return;
  const item = meals[editingMealItem.meal][editingMealItem.idx];

  const baseGrams = (item.grams != null ? item.grams : (item.qty != null ? servingUnitToGrams(item.qty, item.unit || 'g') : 100)) || 100;
  mealEditPer100g = {
    calories: (item.calories || 0) / baseGrams * 100,
    protein: (item.protein || 0) / baseGrams * 100,
    carbs: (item.carbs || 0) / baseGrams * 100,
    fat: (item.fat || 0) / baseGrams * 100,
  };
  mealEditCaloriesLocked = false;

  const qtyInput = form.querySelector('.meal-edit-qty');
  const unitSelect = form.querySelector('.meal-edit-unit');
  const caloriesInput = form.querySelector('.meal-edit-calories');
  const proteinInput = form.querySelector('.meal-edit-protein');
  const carbsInput = form.querySelector('.meal-edit-carbs');
  const fatInput = form.querySelector('.meal-edit-fat');
  const chainBtn = form.querySelector('.meal-edit-chain-btn');

  function applyServingScale() {
    const qty = parseFloat(qtyInput.value) || 0;
    const grams = servingUnitToGrams(qty, unitSelect.value);
    const scale = grams / 100;
    if (!mealEditCaloriesLocked) caloriesInput.value = round0(mealEditPer100g.calories * scale);
    proteinInput.value = round0(mealEditPer100g.protein * scale);
    carbsInput.value = round0(mealEditPer100g.carbs * scale);
    fatInput.value = round0(mealEditPer100g.fat * scale);
  }

  qtyInput.addEventListener('input', applyServingScale);
  unitSelect.addEventListener('change', applyServingScale);

  chainBtn.addEventListener('click', () => {
    mealEditCaloriesLocked = !mealEditCaloriesLocked;
    chainBtn.classList.toggle('is-locked', mealEditCaloriesLocked);
    chainBtn.setAttribute('aria-pressed', String(mealEditCaloriesLocked));
    chainBtn.title = mealEditCaloriesLocked
      ? 'Calories locked — won\'t change with serving size'
      : 'Lock calories so they don\'t change with serving size';
  });
}

function shiftFoodDiaryDate(deltaDays) {
  const dateInput = document.getElementById('foodDiaryDateInput');
  const current = dateInput.value || document.getElementById('nutDate').value || todayISO();
  const d = parseISO(current);
  d.setDate(d.getDate() + deltaDays);
  dateInput.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  dateInput.dispatchEvent(new Event('change'));
}

let currentAddFoodMeal = 'breakfast';
let selectedFoodData = null;
let foodSearchDebounceId = null;
// Per-100g baseline from the last AI estimate in the "Not finding it?"
// custom food form — lets serving size/unit changes auto-rescale the
// calorie/macro inputs instead of leaving them stuck at the 100g figures.
// Only set by the AI estimate; a from-scratch manual entry (no AI click)
// leaves this null, so grams/unit changes don't touch hand-typed values.
let customFoodAiPer100g = null;

// Directly overrides the day's flat nutrition totals (the same fields
// Daily Fuel Status reads), bypassing the Dietary Algorithm/meals entirely —
// for users transferring totals already computed by another app (e.g.
// MyFitnessPal) rather than logging individual food items here. Note the
// same caveat as any direct total-override: if the Dietary Algorithm is
// used for this date afterward, saving a meal there recomputes and
// overwrites these totals from the (possibly empty) meals list.
function loadManualIntakeFields(date) {
  const e = getLogs()[date] || {};
  document.getElementById('manualIntakeCalories').value = e.calories ?? '';
  document.getElementById('manualIntakeProtein').value = e.protein ?? '';
  document.getElementById('manualIntakeCarbs').value = e.carbs ?? '';
  document.getElementById('manualIntakeFat').value = e.fat ?? '';
  document.getElementById('manualIntakeFiber').value = e.fiber ?? '';
  document.getElementById('manualIntakeSodium').value = e.sodium ?? '';
  document.getElementById('manualIntakeNote').textContent = '';
}

function initManualIntake() {
  const overlay = document.getElementById('manualIntakeOverlay');

  document.getElementById('btnOpenManualIntake').addEventListener('click', () => {
    const date = document.getElementById('nutDate').value;
    document.getElementById('manualIntakeDate').value = date;
    loadManualIntakeFields(date);
    overlay.hidden = false;
  });
  document.getElementById('btnCloseManualIntake').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
  document.getElementById('manualIntakeDate').addEventListener('change', e => loadManualIntakeFields(e.target.value || todayISO()));

  document.getElementById('btnManualOverrideSubmit').addEventListener('click', () => {
    const date = document.getElementById('manualIntakeDate').value || todayISO();
    updateLogFields(date, {
      calories: parseFloat(document.getElementById('manualIntakeCalories').value) || 0,
      protein: parseFloat(document.getElementById('manualIntakeProtein').value) || 0,
      carbs: parseFloat(document.getElementById('manualIntakeCarbs').value) || 0,
      fat: parseFloat(document.getElementById('manualIntakeFat').value) || 0,
      fiber: parseFloat(document.getElementById('manualIntakeFiber').value) || 0,
      sodium: parseFloat(document.getElementById('manualIntakeSodium').value) || 0,
    });
    overlay.hidden = true;
    // Only re-point the Fuel tab's own date label if the override was for
    // the date it's already showing — otherwise just refresh the
    // date-agnostic parts (they read nutDate internally) so an edit to a
    // past day doesn't silently relabel the currently-viewed date.
    if (date === document.getElementById('nutDate').value) {
      refreshFuelViewsForDate(date);
    } else {
      renderNutritionTargets();
      renderNutritionAverages();
      updateTabDots();
    }
    showRestToast(`Manual override applied for ${fmtDate(parseISO(date))}.`);
  });
}

function initFoodDiary() {
  const overlay = document.getElementById('foodDiaryOverlay');
  const dateInput = document.getElementById('foodDiaryDateInput');

  document.getElementById('btnOpenFoodDiary').addEventListener('click', () => {
    const date = document.getElementById('nutDate').value;
    dateInput.value = date;
    editingMealItem = null;
    renderFoodDiary(date);
    overlay.hidden = false;
  });
  document.getElementById('btnCloseFoodDiary').addEventListener('click', () => { overlay.hidden = true; editingMealItem = null; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; editingMealItem = null; });

  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    const nutDateEl = document.getElementById('nutDate');
    nutDateEl.value = dateInput.value;
    nutDateEl.dispatchEvent(new Event('change'));
    editingMealItem = null;
    renderFoodDiary(dateInput.value);
  });
  document.getElementById('btnFoodDiaryPrevDay').addEventListener('click', () => shiftFoodDiaryDate(-1));
  document.getElementById('btnFoodDiaryNextDay').addEventListener('click', () => shiftFoodDiaryDate(1));
  document.getElementById('btnShareFoodDiary').addEventListener('click', shareFoodDiary);

  overlay.addEventListener('click', e => {
    const removeBtn = e.target.closest('.meal-item-remove');
    if (removeBtn) {
      if (!confirm('Delete this logged food item? This cannot be undone.')) return;
      const date = document.getElementById('nutDate').value;
      const meals = getMealsForDate(date);
      meals[removeBtn.dataset.meal].splice(parseInt(removeBtn.dataset.idx, 10), 1);
      saveMealsForDate(date, meals);
      renderFoodDiary(date);
      refreshFuelViewsForDate(date);
      return;
    }
    const editBtn = e.target.closest('.meal-item-edit-btn');
    if (editBtn) {
      editingMealItem = { meal: editBtn.dataset.meal, idx: parseInt(editBtn.dataset.idx, 10) };
      renderFoodDiary(document.getElementById('nutDate').value);
      return;
    }
    const cancelEditBtn = e.target.closest('.meal-item-cancel-edit');
    if (cancelEditBtn) {
      editingMealItem = null;
      mealEditPer100g = null;
      mealEditCaloriesLocked = false;
      renderFoodDiary(document.getElementById('nutDate').value);
      return;
    }
    const saveBtn = e.target.closest('.meal-item-save');
    if (saveBtn) {
      const date = document.getElementById('nutDate').value;
      const meals = getMealsForDate(date);
      const mt = saveBtn.dataset.meal;
      const idx = parseInt(saveBtn.dataset.idx, 10);
      const form = saveBtn.closest('.meal-item-edit-form');
      const item = meals[mt][idx];
      const newName = form.querySelector('.meal-edit-name').value.trim();
      item.name = newName || item.name;
      const qtyVal = form.querySelector('.meal-edit-qty').value;
      const unit = form.querySelector('.meal-edit-unit').value;
      item.qty = qtyVal === '' ? null : (parseFloat(qtyVal) || 0);
      item.unit = unit;
      item.grams = item.qty != null ? servingUnitToGrams(item.qty, unit) : null;
      item.calories = parseFloat(form.querySelector('.meal-edit-calories').value) || 0;
      item.protein = parseFloat(form.querySelector('.meal-edit-protein').value) || 0;
      item.carbs = parseFloat(form.querySelector('.meal-edit-carbs').value) || 0;
      item.fat = parseFloat(form.querySelector('.meal-edit-fat').value) || 0;
      editingMealItem = null;
      mealEditPer100g = null;
      mealEditCaloriesLocked = false;
      saveMealsForDate(date, meals);
      renderFoodDiary(date);
      refreshFuelViewsForDate(date);
      showRestToast('Saved changes.');
      return;
    }
    const addBtn = e.target.closest('.add-food-btn');
    if (addBtn) {
      currentAddFoodMeal = addBtn.dataset.meal;
      openAddFoodPanel();
      return;
    }

    const menuBtn = e.target.closest('.meal-menu-btn');
    if (menuBtn) {
      const mt = menuBtn.dataset.meal;
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = m.dataset.meal !== mt || !m.hidden; });
      return;
    }
    const shareMealBtn = e.target.closest('.meal-menu-share');
    if (shareMealBtn) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
      shareSingleMeal(shareMealBtn.dataset.meal);
      return;
    }
    const copyMealBtn = e.target.closest('.meal-menu-copy');
    if (copyMealBtn) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
      copyMealToClipboard(copyMealBtn.dataset.meal);
      return;
    }
    const pasteMealBtn = e.target.closest('.meal-menu-paste');
    if (pasteMealBtn) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
      pasteMealFromClipboard(pasteMealBtn.dataset.meal);
      return;
    }
    const clearMealBtn = e.target.closest('.meal-menu-clear');
    if (clearMealBtn) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
      clearMealData(clearMealBtn.dataset.meal);
      return;
    }
    if (!e.target.closest('.meal-menu-wrap')) {
      document.querySelectorAll('.meal-menu').forEach(m => { m.hidden = true; });
    }
  });

  overlay.addEventListener('change', e => {
    const moveSel = e.target.closest('.meal-item-move');
    if (!moveSel || moveSel.value === moveSel.dataset.meal) return;
    const date = document.getElementById('nutDate').value;
    const meals = getMealsForDate(date);
    const fromMeal = moveSel.dataset.meal;
    const idx = parseInt(moveSel.dataset.idx, 10);
    const item = meals[fromMeal][idx];
    meals[fromMeal].splice(idx, 1);
    meals[moveSel.value].push(item);
    saveMealsForDate(date, meals);
    renderFoodDiary(date);
    refreshFuelViewsForDate(date);
  });
}

let pendingBarcodeCode = null;

// g/oz/ml convert exactly for any food. cup/bowl/piece/stick/pack are rough,
// general-purpose estimates (a "piece" of chicken vs. a "piece" of candy weigh
// nothing alike) — flagged with a visible warning wherever they're picked.
const SERVING_UNITS = {
  g: { label: 'g', gramsPerUnit: 1, precise: true },
  oz: { label: 'oz', gramsPerUnit: 28.3495, precise: true },
  ml: { label: 'ml', gramsPerUnit: 1, precise: true },
  cup: { label: 'cup', gramsPerUnit: 240, precise: false },
  bowl: { label: 'bowl', gramsPerUnit: 350, precise: false },
  piece: { label: 'piece', gramsPerUnit: 50, precise: false },
  stick: { label: 'stick', gramsPerUnit: 20, precise: false },
  pack: { label: 'pack', gramsPerUnit: 30, precise: false },
};

function servingUnitToGrams(qty, unit) {
  const u = SERVING_UNITS[unit] || SERVING_UNITS.g;
  return (qty || 0) * u.gramsPerUnit;
}

function isServingUnitPrecise(unit) {
  return (SERVING_UNITS[unit] || SERVING_UNITS.g).precise;
}

function formatServingQty(qty, unit) {
  if (qty == null) return '';
  const u = unit || 'g';
  const wordUnit = !['g', 'oz', 'ml'].includes(u);
  return round0(qty) + (wordUnit ? ' ' + u : u);
}

function openAddFoodPanel() {
  document.getElementById('foodSearchInput').value = '';
  document.getElementById('foodSearchResults').innerHTML = '';
  document.getElementById('foodSearchStatus').textContent = '';
  document.getElementById('selectedFoodCard').hidden = true;
  selectedFoodData = null;
  document.getElementById('customFoodName').value = '';
  document.getElementById('customFoodGrams').value = '100';
  document.getElementById('customFoodUnit').value = 'g';
  document.getElementById('customFoodUnitWarning').hidden = true;
  document.getElementById('customFoodCalories').value = '';
  document.getElementById('customFoodProtein').value = '';
  document.getElementById('customFoodCarbs').value = '';
  document.getElementById('customFoodFat').value = '';
  document.getElementById('customFoodTeachNote').hidden = true;
  document.getElementById('aiEstimateStatus').textContent = '';
  document.getElementById('aiEstimateSpinner').hidden = true;
  document.getElementById('aiPhotoStatus').textContent = '';
  document.getElementById('aiPhotoSpinner').hidden = true;
  document.getElementById('aiPhotoPreview').hidden = true;
  document.getElementById('aiPhotoPreview').src = '';
  customFoodAiPer100g = null;
  pendingBarcodeCode = null;
  document.getElementById('addFoodOverlay').hidden = false;
}

// Deployed under the name "smooth-service" (Supabase's dashboard "Via
// Editor" quick-create flow auto-assigns a random slug and it's easy to
// miss renaming it before deploying — happened twice). The function's
// actual code/behavior is the food-nutrition estimator described in
// supabase/functions/estimate-food-nutrition/index.js; only the deployed
// name diverges from the source folder name.
async function estimateFoodNutritionWithAI(foodName) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/smooth-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ foodName }),
    });
  } catch (e) {
    throw new Error('AI estimate unavailable — check your connection.');
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('AI estimate unavailable — try again later.'); }
  if (!res.ok) throw new Error(data.error || 'AI estimate failed');
  return data;
}

// Same Edge Function as above, extended to also accept a photo — Gemini
// identifies the food and estimates nutrition from the image in one call.
// imageBase64 is RAW base64 (no "data:image/jpeg;base64," prefix — Gemini's
// inlineData.data field wants just the encoded bytes).
async function estimateFoodNutritionFromPhoto(imageBase64, mimeType) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/smooth-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ imageBase64, imageMimeType: mimeType }),
    });
  } catch (e) {
    throw new Error('AI photo estimate unavailable — check your connection.');
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('AI photo estimate unavailable — try again later.'); }
  if (!res.ok) throw new Error(data.error || 'AI photo estimate failed');
  return data;
}

// Fallback for barcodes the live camera scanner (BarcodeDetector) can't
// read at all — worn, curved, or damaged packaging trips it up often.
// Two still photos (barcode + nutrition facts label) give Gemini a much
// better shot than a continuous low-res video frame.
async function estimateFoodFromBarcodePhotos(barcodeImageBase64, barcodeImageMimeType, labelImageBase64, labelImageMimeType) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/smooth-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ barcodeImageBase64, barcodeImageMimeType, labelImageBase64, labelImageMimeType }),
    });
  } catch (e) {
    throw new Error('AI barcode reading unavailable — check your connection.');
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('AI barcode reading unavailable — try again later.'); }
  if (!res.ok) throw new Error(data.error || 'AI barcode reading failed');
  return data;
}

let barcodePhotoBase64 = null;

function initBarcodePhotoFallback() {
  const fallbackBtn = document.getElementById('btnBarcodePhotoFallback');
  const section = document.getElementById('barcodePhotoFallbackSection');
  const barcodeBtn = document.getElementById('btnTakeBarcodePhoto');
  const barcodeInput = document.getElementById('barcodePhotoInput');
  const barcodePreview = document.getElementById('barcodePhotoPreview');
  const barcodeSpinner = document.getElementById('barcodePhotoSpinner');
  const labelBtn = document.getElementById('btnTakeLabelPhoto');
  const labelInput = document.getElementById('labelPhotoInput');
  const labelPreview = document.getElementById('labelPhotoPreview');
  const labelSpinner = document.getElementById('labelPhotoSpinner');
  const statusEl = document.getElementById('barcodePhotoStatus');

  fallbackBtn.addEventListener('click', () => {
    stopBarcodeCamera();
    section.hidden = false;
    fallbackBtn.hidden = true;
    barcodePhotoBase64 = null;
    barcodePreview.hidden = true;
    labelPreview.hidden = true;
    labelBtn.disabled = true;
    statusEl.textContent = '';
  });

  barcodeBtn.addEventListener('click', () => barcodeInput.click());
  barcodeInput.addEventListener('change', async () => {
    const file = barcodeInput.files[0];
    barcodeInput.value = '';
    if (!file) return;
    barcodeSpinner.hidden = false;
    try {
      const { dataUrl } = await resizeAndCompressImage(file);
      barcodePreview.src = dataUrl;
      barcodePreview.hidden = false;
      barcodePhotoBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      labelBtn.disabled = false;
      statusEl.textContent = 'Barcode photo captured — now take a photo of the Nutrition Facts label.';
    } catch (e) {
      statusEl.textContent = 'Could not read that photo — try again.';
    } finally {
      barcodeSpinner.hidden = true;
    }
  });

  labelBtn.addEventListener('click', () => labelInput.click());
  labelInput.addEventListener('change', async () => {
    const file = labelInput.files[0];
    labelInput.value = '';
    if (!file || !barcodePhotoBase64) return;
    labelSpinner.hidden = false;
    statusEl.textContent = 'Reading barcode and nutrition facts with AI…';
    try {
      const { dataUrl } = await resizeAndCompressImage(file);
      labelPreview.src = dataUrl;
      labelPreview.hidden = false;
      const labelBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const est = await estimateFoodFromBarcodePhotos(barcodePhotoBase64, 'image/jpeg', labelBase64, 'image/jpeg');

      document.getElementById('barcodeScanOverlay').hidden = true;
      section.hidden = true;
      fallbackBtn.hidden = false;

      openAddFoodPanel();
      if (est.code) pendingBarcodeCode = est.code;
      if (est.name) document.getElementById('customFoodName').value = est.name;
      customFoodAiPer100g = { calories: est.calories || 0, protein: est.protein || 0, carbs: est.carbs || 0, fat: est.fat || 0 };
      document.getElementById('customFoodGrams').value = 100;
      document.getElementById('customFoodUnit').value = 'g';
      document.getElementById('customFoodUnitWarning').hidden = true;
      recomputeCustomFoodFromAi();
      // Reuses the existing "will be remembered for the next scan" note —
      // only relevant if a code was actually captured from the photo.
      document.getElementById('customFoodTeachNote').hidden = !est.code;
      document.getElementById('aiPhotoStatus').textContent = '⚠️ AI-read from your photos — review the values below before saving.';
    } catch (e) {
      statusEl.textContent = e.message || 'AI reading failed — check your connection or try again.';
    } finally {
      labelSpinner.hidden = true;
    }
  });
}

// Shown when a scanned barcode isn't in our Supabase cache or on Open Food
// Facts — lets the user fill it in once via the existing custom-food form,
// then contributes it to barcode_products so future scans (by anyone) hit
// the cache first. Mainly closes the PH-local/imported product gap in OFF.
function offerBarcodeTeach(code) {
  openAddFoodPanel();
  pendingBarcodeCode = code;
  document.getElementById('customFoodTeachNote').hidden = false;
  document.getElementById('foodSearchStatus').textContent = '';
  document.getElementById('customFoodName').focus();
}

async function contributeBarcodeProduct(code, name, per100g) {
  if (!sbConfigured() || !code) return;
  try {
    await sb.rpc('contribute_barcode_product', {
      p_code: code,
      p_name: name,
      p_brands: null,
      p_calories: round0(per100g.calories),
      p_protein: round0(per100g.protein),
      p_carbs: round0(per100g.carbs),
      p_fat: round0(per100g.fat),
      p_fiber: 0,
      p_sodium: 0,
      p_contributed_by_name: (getProfile().name || 'Anonymous'),
    });
  } catch (e) { /* best-effort — app still works fully offline without this */ }
}

// Open Food Facts' search endpoints block cross-origin browser fetch (no
// CORS) — confirmed by direct testing, not just docs. Its single-product
// barcode lookup DOES allow it, so that's used for the barcode scanner only.
// Search-as-you-type instead uses USDA FoodData Central, which supports CORS
// and returns full nutrition inline with search results (no second fetch).
const USDA_NUTRIENT_IDS = { calories: 1008, protein: 1003, fat: 1004, carbs: 1005, fiber: 1079, sodium: 1093 };

function usdaNutrientValue(food, nutrientId) {
  const n = (food.foodNutrients || []).find(fn => fn.nutrientId === nutrientId);
  return n ? (n.value || 0) : 0;
}

async function searchUsdaFoods(query) {
  const key = (typeof USDA_API_KEY === 'string' && USDA_API_KEY) ? USDA_API_KEY : 'DEMO_KEY';
  const url = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${encodeURIComponent(query)}&pageSize=15&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (res.status === 429 || res.status === 403) throw new Error('Rate limited — get your own free key at api.data.gov/signup and add it to config.js.');
  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  return data.foods || [];
}

// Nutritionix is optional (blank App ID/Key in config.js = silently skipped)
// and scoped to *branded* results only — restaurant/fast-food items USDA and
// Open Food Facts don't cover, since generic foods already overlap with USDA.
async function searchNutritionixFoods(query) {
  if (!NUTRITIONIX_APP_ID || !NUTRITIONIX_APP_KEY) return [];
  try {
    const res = await fetch(`https://trackapi.nutritionix.com/v2/search/instant?query=${encodeURIComponent(query)}&common=false&branded=true`, {
      headers: { 'x-app-id': NUTRITIONIX_APP_ID, 'x-app-key': NUTRITIONIX_APP_KEY },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.branded || []).slice(0, 8);
  } catch (e) { return []; }
}

async function fetchNutritionixNutrients(foodName) {
  const res = await fetch('https://trackapi.nutritionix.com/v2/natural/nutrients', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-app-id': NUTRITIONIX_APP_ID, 'x-app-key': NUTRITIONIX_APP_KEY },
    body: JSON.stringify({ query: foodName }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('Nutritionix key invalid — check config.js.');
  if (!res.ok) throw new Error('Nutritionix lookup failed');
  const data = await res.json();
  const f = (data.foods || [])[0];
  if (!f) throw new Error('No nutrition data found for that item.');
  return f;
}

function renderFoodSearchResults(usdaFoods, nixBranded, query) {
  const container = document.getElementById('foodSearchResults');
  const usdaRows = (usdaFoods || []).map(f => ({
    name: f.description,
    meta: f.brandName || f.brandOwner || (f.dataType === 'Branded' ? 'Branded' : 'Generic'),
    kcalLabel: round0(usdaNutrientValue(f, USDA_NUTRIENT_IDS.calories)) + ' kcal/100g',
    onSelect: () => selectFoodProduct({ source: 'usda', food: f }),
  }));
  const nixRows = (nixBranded || []).map(f => ({
    name: f.food_name,
    meta: f.brand_name || 'Restaurant',
    kcalLabel: round0(f.nf_calories || 0) + ' kcal/serving',
    onSelect: () => selectFoodProduct({ source: 'nutritionix', foodName: f.food_name }),
  }));
  const rows = usdaRows.concat(nixRows);
  // The AI row is always appended (not just when the database search comes up
  // empty) — visually distinct (--ai modifier) so it never reads as a real
  // matched product, but always reachable in one tap instead of requiring a
  // detour through the separate "Add custom food" section below.
  const aiRow = query ? [{
    name: `✨ Estimate "${query}" with AI`,
    meta: 'Not an exact match — AI estimates per-100g nutrition, review before saving',
    kcalLabel: '',
    isAi: true,
    onSelect: () => selectFoodProduct({ source: 'ai', foodName: query }),
  }] : [];
  const allRows = rows.concat(aiRow);
  if (!allRows.length) { container.innerHTML = ''; return; }
  container.innerHTML = allRows.map((r, i) => `
    <button type="button" class="food-search-result-row${r.isAi ? ' food-search-result-row--ai' : ''}" data-idx="${i}">
      <div>
        <div class="food-result-name">${escapeHtml(r.name)}</div>
        <div class="food-result-meta">${escapeHtml(r.meta)}</div>
      </div>
      <span class="food-result-kcal">${r.kcalLabel}</span>
    </button>
  `).join('');
  container.querySelectorAll('.food-search-result-row').forEach((btn, i) => {
    btn.addEventListener('click', allRows[i].onSelect);
  });
}

async function fetchOffProductNutrition(code) {
  const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_en,brands,nutriments`);
  if (!res.ok) throw new Error('Lookup failed');
  const data = await res.json();
  if (data.status !== 1 || !data.product) throw new Error('Product not found');
  return data.product;
}

function offBrandsText(brands) {
  if (!brands) return 'Generic';
  return Array.isArray(brands) ? brands.join(', ') : brands;
}

// Accepts { source: 'usda', food } from search results, { source: 'local', product }
// from our own Supabase barcode cache, or { source: 'off', product } from the
// barcode scanner (product already has full nutriments attached).
async function selectFoodProduct(selection) {
  const status = document.getElementById('foodSearchStatus');
  let name, per100g, defaultGrams = 100;

  if (selection.source === 'usda') {
    const f = selection.food;
    name = f.description;
    per100g = {
      calories: usdaNutrientValue(f, USDA_NUTRIENT_IDS.calories),
      protein: usdaNutrientValue(f, USDA_NUTRIENT_IDS.protein),
      carbs: usdaNutrientValue(f, USDA_NUTRIENT_IDS.carbs),
      fat: usdaNutrientValue(f, USDA_NUTRIENT_IDS.fat),
      fiber: usdaNutrientValue(f, USDA_NUTRIENT_IDS.fiber),
      sodium: usdaNutrientValue(f, USDA_NUTRIENT_IDS.sodium), // USDA already reports sodium in mg
    };
  } else if (selection.source === 'local') {
    const p = selection.product;
    name = p.name;
    per100g = {
      calories: p.calories || 0,
      protein: p.protein || 0,
      carbs: p.carbs || 0,
      fat: p.fat || 0,
      fiber: p.fiber || 0,
      sodium: p.sodium || 0,
    };
  } else if (selection.source === 'nutritionix') {
    status.textContent = 'Loading nutrition info…';
    let f;
    try {
      f = await fetchNutritionixNutrients(selection.foodName);
    } catch (e) {
      status.textContent = e.message || 'Could not load nutrition info for that item — try another or add custom.';
      return;
    }
    // Branded/restaurant items are reported per labeled serving, not per 100g —
    // rescale to 100g so the existing grams-based scaling UI works unchanged,
    // defaulting the grams input to that item's real serving weight.
    const gramsPerServing = f.serving_weight_grams || 100;
    const scale = 100 / gramsPerServing;
    name = f.food_name;
    per100g = {
      calories: (f.nf_calories || 0) * scale,
      protein: (f.nf_protein || 0) * scale,
      carbs: (f.nf_total_carbohydrate || 0) * scale,
      fat: (f.nf_total_fat || 0) * scale,
      fiber: (f.nf_dietary_fiber || 0) * scale,
      sodium: (f.nf_sodium || 0) * scale,
    };
    defaultGrams = round0(gramsPerServing);
  } else if (selection.source === 'ai') {
    status.textContent = 'Estimating with AI…';
    let est;
    try {
      est = await estimateFoodNutritionWithAI(selection.foodName);
    } catch (e) {
      status.textContent = e.message || 'AI estimate unavailable — try again or add custom.';
      return;
    }
    name = selection.foodName;
    per100g = {
      calories: est.calories || 0,
      protein: est.protein || 0,
      carbs: est.carbs || 0,
      fat: est.fat || 0,
      fiber: est.fiber || 0,
      sodium: est.sodium || 0,
    };
  } else {
    let product = selection.product;
    if (!product.nutriments) {
      status.textContent = 'Loading nutrition info…';
      try {
        product = await fetchOffProductNutrition(product.code);
      } catch (e) {
        status.textContent = 'Could not load nutrition info for that item — try another or add custom.';
        return;
      }
    }
    const n = product.nutriments || {};
    name = product.product_name || product.product_name_en || 'Unknown item';
    per100g = {
      calories: n['energy-kcal_100g'] || 0,
      protein: n['proteins_100g'] || 0,
      carbs: n['carbohydrates_100g'] || 0,
      fat: n['fat_100g'] || 0,
      fiber: n['fiber_100g'] || 0,
      sodium: (n['sodium_100g'] || 0) * 1000, // OFF gives grams — this app tracks sodium in mg
    };
  }

  status.textContent = '';
  selectedFoodData = { name, per100g };
  document.getElementById('selectedFoodName').textContent = name;
  document.getElementById('selectedFoodGrams').value = defaultGrams;
  document.getElementById('selectedFoodUnit').value = 'g';
  document.getElementById('selectedFoodUnitWarning').hidden = true;
  document.getElementById('selectedFoodAiWarning').hidden = selection.source !== 'ai';
  updateSelectedFoodPreview();
  document.getElementById('selectedFoodCard').hidden = false;
  document.getElementById('selectedFoodCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateSelectedFoodPreview() {
  if (!selectedFoodData) return;
  const qty = parseFloat(document.getElementById('selectedFoodGrams').value) || 0;
  const unit = document.getElementById('selectedFoodUnit').value;
  document.getElementById('selectedFoodUnitWarning').hidden = isServingUnitPrecise(unit);
  const grams = servingUnitToGrams(qty, unit);
  const scale = grams / 100;
  const kcal = round0(selectedFoodData.per100g.calories * scale);
  const protein = round0(selectedFoodData.per100g.protein * scale);
  const carbs = round0(selectedFoodData.per100g.carbs * scale);
  const fat = round0(selectedFoodData.per100g.fat * scale);
  document.getElementById('selectedFoodPreview').textContent = `${kcal} kcal · ${protein}g protein · ${carbs}g carbs · ${fat}g fat`;
}

function addFoodItemToDiary(item) {
  const date = document.getElementById('nutDate').value;
  const meals = getMealsForDate(date);
  meals[currentAddFoodMeal].push(item);
  saveMealsForDate(date, meals);
  document.getElementById('addFoodOverlay').hidden = true;
  renderFoodDiary(date);
  refreshFuelViewsForDate(date);
  showRestToast(`Added "${item.name}" to ${currentAddFoodMeal}.`);
}

// Rescales the custom-food calorie/macro inputs from the last AI estimate's
// per-100g baseline whenever serving size or unit changes — only active
// after an AI estimate has actually been fetched (customFoodAiPer100g set);
// a fully manual entry (no AI click) is left alone. Only applies here, in
// the pre-add form — editing an already-logged diary entry is unaffected.
function recomputeCustomFoodFromAi() {
  if (!customFoodAiPer100g) return;
  const qty = parseFloat(document.getElementById('customFoodGrams').value) || 0;
  const unit = document.getElementById('customFoodUnit').value;
  const grams = servingUnitToGrams(qty, unit);
  const scale = grams / 100;
  document.getElementById('customFoodCalories').value = round0(customFoodAiPer100g.calories * scale);
  document.getElementById('customFoodProtein').value = round0(customFoodAiPer100g.protein * scale);
  document.getElementById('customFoodCarbs').value = round0(customFoodAiPer100g.carbs * scale);
  document.getElementById('customFoodFat').value = round0(customFoodAiPer100g.fat * scale);
}

function initAddFoodPanel() {
  const overlay = document.getElementById('addFoodOverlay');
  document.getElementById('btnCloseAddFood').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });

  const searchInput = document.getElementById('foodSearchInput');
  searchInput.addEventListener('input', () => {
    clearTimeout(foodSearchDebounceId);
    const q = searchInput.value.trim();
    document.getElementById('selectedFoodCard').hidden = true;
    if (q.length < 2) {
      document.getElementById('foodSearchResults').innerHTML = '';
      document.getElementById('foodSearchStatus').textContent = '';
      return;
    }
    document.getElementById('foodSearchStatus').textContent = 'Searching…';
    foodSearchDebounceId = setTimeout(async () => {
      const nixPromise = searchNutritionixFoods(q);
      try {
        const results = await searchUsdaFoods(q);
        const nixResults = await nixPromise;
        renderFoodSearchResults(results, nixResults, q);
        document.getElementById('foodSearchStatus').textContent = '';
      } catch (e) {
        // Even if USDA/Nutritionix search itself fails (rate limit, offline),
        // the AI fallback row still works — it's a separate request.
        renderFoodSearchResults([], [], q);
        document.getElementById('foodSearchStatus').textContent = e.message || 'Search unavailable — check your connection.';
      }
    }, 450);
  });

  document.getElementById('selectedFoodGrams').addEventListener('input', updateSelectedFoodPreview);
  document.getElementById('selectedFoodUnit').addEventListener('change', updateSelectedFoodPreview);

  const aiBtn = document.getElementById('btnEstimateAiNutrition');
  const aiSpinner = document.getElementById('aiEstimateSpinner');
  aiBtn.addEventListener('click', async () => {
    const name = document.getElementById('customFoodName').value.trim();
    const statusEl = document.getElementById('aiEstimateStatus');
    if (!name) { statusEl.textContent = 'Enter a food name first.'; return; }
    statusEl.textContent = 'Estimating with AI…';
    aiBtn.disabled = true;
    aiSpinner.hidden = false;
    try {
      const est = await estimateFoodNutritionWithAI(name);
      customFoodAiPer100g = { calories: est.calories || 0, protein: est.protein || 0, carbs: est.carbs || 0, fat: est.fat || 0 };
      document.getElementById('customFoodGrams').value = 100;
      document.getElementById('customFoodUnit').value = 'g';
      document.getElementById('customFoodUnitWarning').hidden = true;
      recomputeCustomFoodFromAi();
      statusEl.textContent = '⚠️ AI estimate for 100g — low accuracy, review before saving. Change serving size/unit below and the values will rescale automatically.';
    } catch (e) {
      statusEl.textContent = e.message || 'AI estimate unavailable — check your connection or add manually.';
    } finally {
      aiBtn.disabled = false;
      aiSpinner.hidden = true;
    }
  });

  const photoBtn = document.getElementById('btnEstimateAiPhoto');
  const photoSpinner = document.getElementById('aiPhotoSpinner');
  const photoInput = document.getElementById('aiPhotoInput');
  const photoPreview = document.getElementById('aiPhotoPreview');
  photoBtn.addEventListener('click', () => photoInput.click());
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    photoInput.value = '';
    if (!file) return;
    const statusEl = document.getElementById('aiPhotoStatus');
    statusEl.textContent = 'Reading photo…';
    photoBtn.disabled = true;
    photoSpinner.hidden = false;
    try {
      const { dataUrl } = await resizeAndCompressImage(file);
      photoPreview.src = dataUrl;
      photoPreview.hidden = false;
      statusEl.textContent = 'Estimating from photo…';
      // dataUrl looks like "data:image/jpeg;base64,<bytes>" — Gemini's
      // inlineData.data wants just the bytes after the comma.
      const rawBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const est = await estimateFoodNutritionFromPhoto(rawBase64, 'image/jpeg');
      if (est.name) document.getElementById('customFoodName').value = est.name;
      customFoodAiPer100g = { calories: est.calories || 0, protein: est.protein || 0, carbs: est.carbs || 0, fat: est.fat || 0 };
      document.getElementById('customFoodGrams').value = 100;
      document.getElementById('customFoodUnit').value = 'g';
      document.getElementById('customFoodUnitWarning').hidden = true;
      recomputeCustomFoodFromAi();
      statusEl.textContent = '⚠️ AI photo estimate for 100g — low accuracy, review before saving. Weigh the actual food and adjust the serving size below for a real result.';
    } catch (e) {
      statusEl.textContent = e.message || 'AI photo estimate unavailable — check your connection or add manually.';
    } finally {
      photoBtn.disabled = false;
      photoSpinner.hidden = true;
    }
  });

  document.getElementById('btnAddSelectedFood').addEventListener('click', () => {
    if (!selectedFoodData) return;
    const qty = parseFloat(document.getElementById('selectedFoodGrams').value) || 0;
    const unit = document.getElementById('selectedFoodUnit').value;
    const grams = servingUnitToGrams(qty, unit);
    const scale = grams / 100;
    addFoodItemToDiary({
      name: selectedFoodData.name,
      grams,
      qty,
      unit,
      calories: round0(selectedFoodData.per100g.calories * scale),
      protein: round0(selectedFoodData.per100g.protein * scale),
      carbs: round0(selectedFoodData.per100g.carbs * scale),
      fat: round0(selectedFoodData.per100g.fat * scale),
      fiber: round0(selectedFoodData.per100g.fiber * scale),
      sodium: round0(selectedFoodData.per100g.sodium * scale),
      source: 'off',
    });
  });

  document.getElementById('customFoodUnit').addEventListener('change', e => {
    document.getElementById('customFoodUnitWarning').hidden = isServingUnitPrecise(e.target.value);
    recomputeCustomFoodFromAi();
  });
  document.getElementById('customFoodGrams').addEventListener('input', recomputeCustomFoodFromAi);

  document.getElementById('btnAddCustomFood').addEventListener('click', () => {
    const name = document.getElementById('customFoodName').value.trim();
    if (!name) { alert('Enter a food name.'); return; }
    const qty = parseFloat(document.getElementById('customFoodGrams').value) || null;
    const unit = document.getElementById('customFoodUnit').value;
    const grams = qty != null ? servingUnitToGrams(qty, unit) : null;
    const calories = parseFloat(document.getElementById('customFoodCalories').value) || 0;
    const protein = parseFloat(document.getElementById('customFoodProtein').value) || 0;
    const carbs = parseFloat(document.getElementById('customFoodCarbs').value) || 0;
    const fat = parseFloat(document.getElementById('customFoodFat').value) || 0;
    if (pendingBarcodeCode && grams) {
      const scale = 100 / grams;
      contributeBarcodeProduct(pendingBarcodeCode, name, {
        calories: calories * scale, protein: protein * scale, carbs: carbs * scale, fat: fat * scale,
      });
    }
    pendingBarcodeCode = null;
    document.getElementById('customFoodTeachNote').hidden = true;
    addFoodItemToDiary({ name, grams, qty, unit, calories, protein, carbs, fat, fiber: 0, sodium: 0, source: 'custom' });
  });
}

let barcodeStream = null;
let barcodeDetectInterval = null;

function initBarcodeScanner() {
  document.getElementById('btnScanBarcode').addEventListener('click', startBarcodeScan);
  document.getElementById('btnCloseBarcodeScan').addEventListener('click', stopBarcodeScan);
  document.getElementById('barcodeScanOverlay').addEventListener('click', e => {
    if (e.target === document.getElementById('barcodeScanOverlay')) stopBarcodeScan();
  });
}

async function startBarcodeScan() {
  if (!('BarcodeDetector' in window)) {
    document.getElementById('foodSearchStatus').textContent = 'Barcode scanning needs Chrome/Edge on Android — not supported in this browser.';
    return;
  }
  const overlay = document.getElementById('barcodeScanOverlay');
  const video = document.getElementById('barcodeVideo');
  const status = document.getElementById('barcodeScanStatus');
  status.textContent = 'Point your camera at a product barcode.';
  overlay.hidden = false;
  try {
    barcodeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = barcodeStream;
    await video.play();
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
    barcodeDetectInterval = setInterval(async () => {
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const code = codes[0].rawValue;
          stopBarcodeScan();
          await lookupBarcodeProduct(code);
        }
      } catch (e) { /* detection frame failed — try next tick */ }
    }, 400);
  } catch (e) {
    status.textContent = 'Camera access denied or unavailable.';
  }
}

// Split from stopBarcodeScan() so the photo-fallback flow can stop the
// live camera without also hiding the overlay it needs to keep showing.
function stopBarcodeCamera() {
  if (barcodeDetectInterval) { clearInterval(barcodeDetectInterval); barcodeDetectInterval = null; }
  if (barcodeStream) { barcodeStream.getTracks().forEach(t => t.stop()); barcodeStream = null; }
}

function stopBarcodeScan() {
  document.getElementById('barcodeScanOverlay').hidden = true;
  stopBarcodeCamera();
  // Reset the photo-fallback UI so reopening the scanner starts fresh
  // instead of resuming mid-flow from a previous abandoned attempt.
  const fallbackSection = document.getElementById('barcodePhotoFallbackSection');
  if (fallbackSection) fallbackSection.hidden = true;
  const fallbackBtn = document.getElementById('btnBarcodePhotoFallback');
  if (fallbackBtn) fallbackBtn.hidden = false;
  barcodePhotoBase64 = null;
}

// Checks our own Supabase-backed cache first (fed by contributeBarcodeProduct
// whenever a user teaches a barcode OFF doesn't have — mainly PH-local/imported
// goods), then falls back to Open Food Facts, then offers the teach form.
async function lookupLocalBarcodeProduct(code) {
  if (!sbConfigured()) return null;
  try {
    const { data, error } = await sb.from('barcode_products').select('*').eq('code', code).maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) { return null; }
}

async function lookupBarcodeProduct(code) {
  document.getElementById('foodSearchStatus').textContent = 'Looking up barcode…';
  const local = await lookupLocalBarcodeProduct(code);
  if (local) {
    selectFoodProduct({ source: 'local', product: local });
    document.getElementById('foodSearchStatus').textContent = '';
    return;
  }
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,nutriments,code`);
    const data = await res.json();
    if (data.status !== 1 || !data.product || !data.product.nutriments) {
      offerBarcodeTeach(code);
      return;
    }
    selectFoodProduct({ source: 'off', product: data.product });
    document.getElementById('foodSearchStatus').textContent = '';
  } catch (e) {
    document.getElementById('foodSearchStatus').textContent = 'Barcode lookup failed — check your connection.';
  }
}

function loadNutritionForDate(date) {
  document.getElementById('fuelDateLabel').textContent = fmtDate(parseISO(date));
}

const WATER_GLASS_ML = 250;

function renderFuelWaterOrb(date) {
  const profile = getProfile();
  const target = effectiveWaterTargetML(date);
  const now = (getLogs()[date] || {}).water || 0;
  const pct = Math.max(0, Math.min(100, (now / target) * 100));
  document.getElementById('fuelWaterOrbFill').style.height = pct + '%';
  document.getElementById('fuelWaterOrbAmount').textContent = now;
  document.getElementById('fuelWaterOrbTarget').textContent = target;
  document.getElementById('fuelWaterOrbAutoTag').hidden = !(profile && profile.autoWaterGoal);
  document.getElementById('btnWaterOrbDown').disabled = now <= 0;
}

function adjustFuelWaterOrb(deltaMl) {
  const date = document.getElementById('nutDate').value || todayISO();
  const current = (getLogs()[date] || {}).water || 0;
  const next = Math.max(0, current + deltaMl);
  updateLogFields(date, { water: next });
  renderFuelWaterOrb(date);
  renderNutritionTargets();
  renderNutritionAverages();
  updateTabDots();
}

function refreshFuelWaterViews(date) {
  renderFuelWaterOrb(date);
}

function initFuelWaterOrb() {
  document.getElementById('btnWaterOrbUp').addEventListener('click', () => adjustFuelWaterOrb(WATER_GLASS_ML));
  document.getElementById('btnWaterOrbDown').addEventListener('click', () => adjustFuelWaterOrb(-WATER_GLASS_ML));
  refreshFuelWaterViews(document.getElementById('nutDate').value || todayISO());
}

// Draws a ring/arc identical in spirit to renderRing() (gradient stroke,
// rounded cap) directly onto a canvas 2D context, for the share-card export.
// Every share card reads this once per draw call to stay in sync with
// whichever theme (light/dark) the app is currently in — canvas can't
// resolve CSS custom properties directly, so this is a small hand-picked
// palette mirroring style.css's --surface/--text/--cyan tokens, tuned so
// light mode keeps real contrast instead of just inverting hex codes.
function getShareTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return isLight ? {
    bgFrom: '#f4f6f7', bgTo: '#e3e8ea',
    border: 'rgba(10,140,145,0.45)',
    textPrimary: '#14191c',
    textSecondary: '#3f4d52',
    textMuted: '#66757a',
    accent: '#0a8c91',
    accentViolet: '#6b4fc7',
    accentBlue: '#2f6fd0',
    warning: '#a5730a',
    critical: '#c23a3a',
    good: '#1f8f5a',
    gridLine: 'rgba(0,0,0,0.12)',
    trackLine: 'rgba(0,0,0,0.1)',
    rowAlt: 'rgba(0,0,0,0.04)',
    emptySlice: '#d7dcde',
  } : {
    bgFrom: '#171f24', bgTo: '#0a0e12',
    border: 'rgba(51,200,204,0.4)',
    textPrimary: '#dde3e5',
    textSecondary: '#b7c1c4',
    textMuted: '#7e8e95',
    accent: '#33c8cc',
    accentViolet: '#8069d6',
    accentBlue: '#3f8ff0',
    warning: '#dba52c',
    critical: '#ff6b6b',
    good: '#2de26c',
    gridLine: 'rgba(255,255,255,0.08)',
    trackLine: 'rgba(255,255,255,0.08)',
    rowAlt: 'rgba(255,255,255,0.03)',
    emptySlice: '#2a3238',
  };
}

function drawShareRing(ctx, cx, cy, r, stroke, pct, gradientColors) {
  const theme = getShareTheme();
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = stroke;
  ctx.strokeStyle = theme.trackLine;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  gradientColors.forEach((c, i) => grad.addColorStop(i / (gradientColors.length - 1), c));
  ctx.strokeStyle = grad;
  ctx.shadowColor = gradientColors[gradientColors.length - 1];
  ctx.shadowBlur = 14;
  const clamped = Math.max(0, Math.min(100, pct));
  const start = -Math.PI / 2;
  const end = start + (clamped / 100) * Math.PI * 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.stroke();
  ctx.restore();
}

// Draws the multi-slice macro pie matching the in-app conic-gradient pie.
function drawSharePie(ctx, cx, cy, r, slices) {
  const theme = getShareTheme();
  ctx.save();
  const total = slices.reduce((s, m) => s + m.value, 0);
  if (total <= 0) {
    ctx.fillStyle = theme.emptySlice;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  let angle = -Math.PI / 2;
  slices.forEach(m => {
    const slice = (m.value / total) * Math.PI * 2;
    if (slice <= 0) return;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fill();
    angle += slice;
  });
  ctx.restore();
}

// Draws the vertical water-fill pill from the in-app Daily Fuel Status
// widget (see .water-pill in style.css) directly onto a canvas 2D context.
function drawShareWaterPill(ctx, x, y, w, h, pct) {
  const theme = getShareTheme();
  ctx.save();
  ctx.strokeStyle = theme.border; ctx.lineWidth = 2;
  roundRectPath(ctx, x, y, w, h, w / 2);
  ctx.fillStyle = theme.rowAlt; ctx.fill();
  ctx.stroke();

  const clamped = Math.max(0, Math.min(100, pct));
  const fillH = (clamped / 100) * (h - 4);
  ctx.save();
  roundRectPath(ctx, x, y, w, h, w / 2);
  ctx.clip();
  const grad = ctx.createLinearGradient(0, y + h - fillH, 0, y + h);
  grad.addColorStop(0, '#2de2e6'); grad.addColorStop(1, '#1f6fd6');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y + h - fillH, w, fillH);
  ctx.restore();
  ctx.restore();
}

async function generateFuelStatusShareCard({ name, digitalId, date, caloriesNow, calorieTarget, macros, waterNow, waterTarget }) {
  const theme = getShareTheme();
  const canvas = document.createElement('canvas');
  canvas.width = 600; canvas.height = 760;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, 600, 760);
  bg.addColorStop(0, theme.bgFrom);
  bg.addColorStop(1, theme.bgTo);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 600, 760);
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, 584, 744);

  // Header: name upper-left, Digital ID upper-right.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.textPrimary;
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText(name || 'Operator', 40, 58);
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.accent;
  ctx.font = 'bold 16px monospace';
  ctx.fillText(digitalId || '', 560, 56);

  // Date, centered.
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.textMuted;
  ctx.font = '15px monospace';
  ctx.fillText(date, 300, 92);

  // Title.
  ctx.fillStyle = theme.accent;
  ctx.font = 'bold 30px sans-serif';
  ctx.fillText('Daily Fuel Status', 300, 138);

  // Calorie ring (left) + water pill (right), matching the in-app row that
  // pairs the calorie ring with the water-fill pill side by side.
  const caloriePct = calorieTarget > 0 ? (caloriesNow / calorieTarget) * 100 : 0;
  const ringCx = 220, ringCy = 290, ringR = 95;
  drawShareRing(ctx, ringCx, ringCy, ringR, 18, caloriePct, ['#8b6bf2', '#3f8ff0', '#2de2e6']);
  ctx.textAlign = 'center';
  ctx.fillStyle = theme.textPrimary;
  ctx.font = 'bold 46px monospace';
  ctx.fillText(Math.round(Math.min(100, caloriePct)) + '%', ringCx, ringCy + 10);
  ctx.fillStyle = theme.textMuted;
  ctx.font = '14px monospace';
  ctx.fillText('CALORIES', ringCx, ringCy + ringR + 34);
  ctx.fillStyle = theme.textPrimary;
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(`${caloriesNow} / ${calorieTarget} kcal`, ringCx, ringCy + ringR + 62);

  if (waterTarget != null) {
    const pillX = 462, pillW = 40, pillY = ringCy - ringR + 5, pillH = ringR * 2 - 10;
    const waterPct = waterTarget > 0 ? (waterNow / waterTarget) * 100 : 0;
    drawShareWaterPill(ctx, pillX, pillY, pillW, pillH, waterPct);
    const pillCx = pillX + pillW / 2;
    ctx.fillStyle = theme.textMuted; ctx.font = '14px monospace';
    ctx.fillText('WATER', pillCx, ringCy + ringR + 34);
    ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`${waterNow} / ${waterTarget} mL`, pillCx, ringCy + ringR + 62);
  }

  // Macro pie (left) + legend (right of the pie), matching the in-app row.
  const pieCx = 210, pieCy = 590, pieR = 58;
  drawSharePie(ctx, pieCx, pieCy, pieR, macros.map(m => ({ value: m.kcal, color: m.color })));
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(pieCx, pieCy, pieR, 0, Math.PI * 2);
  ctx.stroke();

  const legendX = 300;
  let legendY = pieCy - 34;
  ctx.textAlign = 'left';
  macros.forEach(m => {
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(legendX, legendY - 6, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = theme.textPrimary;
    ctx.font = '17px sans-serif';
    ctx.fillText(`${m.label}  ${m.pct}% of intake`, legendX + 16, legendY);
    legendY += 34;
  });

  // Footer.
  ctx.textAlign = 'center';
  await drawShareWatermark(ctx, 600, 760);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

// Shared by the standalone share button and the Request Assessment bundle —
// gathers exactly what the Fuel Snapshot ring row + Computed Targets card
// show in-app (renderNutritionAverages / renderComputedTargets), so the
// share card always matches what's on screen.
function computeFuelSnapshotShareData() {
  const profile = getProfile();
  const today = todayISO();
  const todayEntry = getLogs()[today] || {};
  const logsArr = sortedLogsArray();

  const avgCalories = avgOfLastNDays(logsArr, 'calories', 7);
  const calorieTarget = profile ? getEffectiveCalorieTarget(profile, today) : null;

  const kg = profile ? currentWeightKg(profile) : null;
  const targets = (profile && kg) ? computeTargets(profile, kg) : null;
  const proteinTarget = targets ? round0((targets.protein[0] + targets.protein[1]) / 2) : null;
  const waterTarget = effectiveWaterTargetML(today);

  const bmi = (profile && kg) ? computeBMI(kg, profile.heightCm) : null;
  const computedRows = [];
  if (bmi) computedRows.push(['BMI', bmi.toFixed(1)]);
  if (targets) {
    computedRows.push(['Suggested calories (cutting)', `${round0(targets.cutting[0])}–${round0(targets.cutting[1])} kcal/day`]);
    computedRows.push(['Suggested calories (bulking)', `${round0(targets.bulking[0])}–${round0(targets.bulking[1])} kcal/day`]);
    computedRows.push(['Suggested protein', `${round0(targets.protein[0])}–${round0(targets.protein[1])} g/day`]);
  }

  return {
    avgCalories: avgCalories != null ? round0(avgCalories) : null,
    calorieTarget,
    proteinToday: round0(todayEntry.protein ?? 0),
    proteinTarget,
    waterToday: round0(todayEntry.water ?? 0),
    waterTarget,
    computedRows,
  };
}

async function generateFuelSnapshotShareCard({ name, digitalId, date, avgCalories, calorieTarget, proteinToday, proteinTarget, waterToday, waterTarget, computedRows }) {
  const theme = getShareTheme();
  const width = 600;
  const rowH = 30;
  const height = 170 + 260 + 60 + computedRows.length * rowH + 70;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, theme.bgFrom); bg.addColorStop(1, theme.bgTo);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.border; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 22px sans-serif';
  ctx.fillText(name || 'Operator', 40, 58);
  ctx.textAlign = 'right'; ctx.fillStyle = theme.accent; ctx.font = 'bold 16px monospace';
  ctx.fillText(digitalId || '', width - 40, 56);

  ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '15px monospace';
  ctx.fillText(date, width / 2, 92);

  ctx.fillStyle = theme.accent; ctx.font = 'bold 28px sans-serif';
  ctx.fillText('Fuel Snapshot', width / 2, 138);

  // Three rings matching the in-app Fuel Snapshot row: Calories (7-day
  // avg, since day-to-day intake is noisy), Protein and Water (today's
  // values — things you act on today, not a trailing average).
  const ringY = 250, ringR = 62, ringStroke = 9;
  const ringXs = [width * 0.2, width * 0.5, width * 0.8];
  const ringDefs = [
    { label: 'CALORIES', sub: '7-day avg', now: avgCalories, target: calorieTarget, unit: '', colors: ['#8b6bf2', '#3f8ff0', '#2de2e6'] },
    { label: 'PROTEIN', sub: 'Today', now: proteinToday, target: proteinTarget, unit: 'g', colors: ['#33c8cc', '#2de2e6'] },
    { label: 'WATER', sub: 'Today', now: waterToday, target: waterTarget, unit: 'mL', colors: ['#3f8ff0', '#2de2e6'] },
  ];
  ringDefs.forEach((r, i) => {
    const cx = ringXs[i];
    const pct = r.target ? Math.min(100, (r.now / r.target) * 100) : 0;
    drawShareRing(ctx, cx, ringY, ringR, ringStroke, r.now != null ? pct : 0, r.colors);
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 20px monospace';
    ctx.fillText(r.now != null ? round0(r.now) + r.unit : '–', cx, ringY + 6);
    ctx.fillStyle = theme.textMuted; ctx.font = '11px monospace';
    ctx.fillText(r.target != null ? '/ ' + round0(r.target) + r.unit : '', cx, ringY + 22);
    ctx.fillStyle = theme.textMuted; ctx.font = '13px monospace';
    ctx.fillText(r.label, cx, ringY + ringR + 28);
    ctx.fillStyle = theme.textPrimary; ctx.font = '12px sans-serif';
    ctx.fillText(r.sub, cx, ringY + ringR + 46);
  });

  let y = ringY + ringR + 90;
  ctx.textAlign = 'left'; ctx.fillStyle = theme.accent; ctx.font = 'bold 18px sans-serif';
  ctx.fillText('Computed Targets', 40, y);
  y += 30;
  if (!computedRows.length) {
    ctx.fillStyle = theme.textMuted; ctx.font = '14px sans-serif';
    ctx.fillText('Set your weights in Bio to see computed targets.', 40, y);
  } else {
    computedRows.forEach(([label, value]) => {
      ctx.textAlign = 'left'; ctx.fillStyle = theme.textMuted; ctx.font = '14px sans-serif';
      ctx.fillText(label, 40, y);
      ctx.textAlign = 'right'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 14px monospace';
      ctx.fillText(value, width - 40, y);
      y += rowH;
    });
  }

  ctx.textAlign = 'center';
  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareFuelSnapshot() {
  const profile = getProfile();
  const data = computeFuelSnapshotShareData();
  const text = '📊 My Fuel Snapshot & Computed Targets, tracked with Winfinity Tracker!';
  const blob = await generateFuelSnapshotShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(new Date()),
    ...data,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Fuel Snapshot', text }, blob);
}

async function shareDailyFuelStatus() {
  const profile = getProfile();
  const date = document.getElementById('nutDate').value || todayISO();
  const entry = getLogs()[date] || {};
  const calorieTarget = getEffectiveCalorieTarget(profile, date) || 0;
  const caloriesNow = entry.calories ?? 0;
  const proteinNow = entry.protein ?? 0;
  const carbsNow = entry.carbs ?? 0;
  const fatNow = entry.fat ?? 0;

  const proteinKcal = proteinNow * 4;
  const carbKcal = carbsNow * 4;
  const fatKcal = fatNow * 9;
  const macros = [
    { label: 'Protein', kcal: proteinKcal, color: '#33c8cc', pct: caloriesNow > 0 ? Math.round((proteinKcal / caloriesNow) * 100) : 0 },
    { label: 'Carbs', kcal: carbKcal, color: '#8069d6', pct: caloriesNow > 0 ? Math.round((carbKcal / caloriesNow) * 100) : 0 },
    { label: 'Fat', kcal: fatKcal, color: '#dba52c', pct: caloriesNow > 0 ? Math.round((fatKcal / caloriesNow) * 100) : 0 },
  ];

  const text = `🔥 Daily Fuel Status — ${caloriesNow}/${calorieTarget} kcal logged with Winfinity Tracker!`;
  const blob = await generateFuelStatusShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(parseISO(date)),
    caloriesNow,
    calorieTarget,
    macros,
    waterNow: entry.water || 0,
    waterTarget: effectiveWaterTargetML(date),
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Daily Fuel', text }, blob);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function generateWorkoutSummaryShareCard({ name, digitalId, dateTime, summary, volumeTrend }) {
  const theme = getShareTheme();
  const wu = summary.wu;
  const prCount = summary.exercises.filter(e => e.isPR).length;
  const width = 600;
  const rowH = 106;
  const headerH = 158;
  const statsH = 92 + 26;
  const trendH = (volumeTrend && volumeTrend.volumes.length) ? 190 : 0;
  const prBannerH = prCount > 0 ? 44 : 0;
  const exercisesH = summary.exercises.length
    ? summary.exercises.length * rowH
    : 50;
  const footerH = 46;
  const height = headerH + statsH + trendH + prBannerH + exercisesH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, theme.bgFrom); bg.addColorStop(1, theme.bgTo);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.border; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = theme.accent; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);

  ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '14px monospace';
  ctx.fillText(dateTime, width / 2, 74);

  ctx.textAlign = 'left'; ctx.fillStyle = theme.accent; ctx.font = 'bold 26px sans-serif';
  ctx.fillText('WORKOUT SUMMARY', 32, 116);

  let y = headerH;

  const tileGap = 14;
  const tileW = (width - 64 - tileGap * 2) / 3;
  const tiles = [
    { value: String(summary.exercises.length), label: 'EXERCISES' },
    { value: String(summary.totalSets), label: 'SETS' },
    { value: String(round0(fromKg(summary.totalVolumeKg, wu))), label: `VOLUME (${wu.toUpperCase()})` },
  ];
  tiles.forEach((t, i) => {
    const x = 32 + i * (tileW + tileGap);
    ctx.strokeStyle = theme.border; ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, tileW, 92, 10);
    ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 32px sans-serif';
    ctx.fillText(t.value, x + tileW / 2, y + 48);
    ctx.fillStyle = theme.textMuted; ctx.font = '11px monospace';
    ctx.fillText(t.label, x + tileW / 2, y + 74);
  });
  y += 92 + 26;

  if (trendH) {
    ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 15px sans-serif';
    ctx.fillText('Total Lift Volume (Last 8 Gym Days)', 32, y + 4);
    ctx.textAlign = 'right'; ctx.fillStyle = theme.textMuted; ctx.font = '13px monospace';
    ctx.fillText(`${volumeTrend.total.toLocaleString()} ${volumeTrend.wu} total`, width - 32, y + 4);

    const plotX = 32, plotW = width - 64, plotH = 100, plotY = y + 20;
    const { volumes, labels } = volumeTrend;
    const max = Math.max(...volumes, 1);
    const stepX = volumes.length > 1 ? plotW / (volumes.length - 1) : 0;
    const points = volumes.map((v, i) => ({
      x: plotX + (volumes.length > 1 ? i * stepX : plotW / 2),
      y: plotY + plotH - (v / max) * plotH,
    }));

    ctx.beginPath();
    ctx.moveTo(points[0].x, plotY + plotH);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(points[points.length - 1].x, plotY + plotH);
    ctx.closePath();
    ctx.fillStyle = theme.trackLine;
    ctx.fill();

    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();

    ctx.fillStyle = theme.accent;
    points.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); });

    ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '10px monospace';
    points.forEach((p, i) => ctx.fillText(labels[i], p.x, plotY + plotH + 18));

    y += trendH;
  }

  if (prCount > 0) {
    ctx.textAlign = 'center'; ctx.fillStyle = theme.warning; ctx.font = 'bold 18px monospace';
    ctx.fillText(`🏆 ${prCount} new personal record${prCount > 1 ? 's' : ''}!`, width / 2, y + 10);
    y += prBannerH;
  }

  if (!summary.exercises.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '15px sans-serif';
    ctx.fillText('No exercises logged for this date.', width / 2, y + 28);
    y += exercisesH;
  }
  summary.exercises.forEach(ex => {
    const rh = rowH - 14;
    ctx.fillStyle = theme.rowAlt;
    ctx.strokeStyle = theme.gridLine; ctx.lineWidth = 1;
    roundRectPath(ctx, 32, y, width - 64, rh, 10);
    ctx.fill(); ctx.stroke();

    ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 20px sans-serif';
    ctx.fillText(ex.name, 52, y + 28);
    ctx.fillStyle = theme.textSecondary; ctx.font = '15px monospace';
    ctx.fillText(`${ex.completedSets} sets · ${round0(fromKg(ex.volumeKg, wu))} ${wu} volume`, 52, y + 50);
    if (ex.topWeightKg != null) {
      ctx.fillStyle = theme.textMuted; ctx.font = '14px monospace';
      ctx.fillText(`Top set: ${round0(fromKg(ex.topWeightKg, wu))} ${wu} × ${ex.topReps} reps`, 52, y + 72);
    }

    if (ex.isPR) {
      const badgeText = '🏆 PR';
      ctx.font = 'bold 15px sans-serif';
      const textW = ctx.measureText(badgeText).width;
      const badgeW = textW + 26;
      const badgeX = width - 52 - badgeW;
      const badgeY = y + rh / 2 - 16;
      ctx.strokeStyle = theme.warning; ctx.lineWidth = 1.5;
      roundRectPath(ctx, badgeX, badgeY, badgeW, 32, 8);
      ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillStyle = theme.warning; ctx.font = 'bold 15px sans-serif';
      ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + 21);
    }
    y += rowH;
  });

  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

const FOOD_DIARY_MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };

// Redraws the same glyphs used by the in-app meal-section headers (see the
// inline SVGs in index.html) so the share card's icons match exactly instead
// of substituting emoji.
function drawMealIcon(ctx, mealType, cx, cy, size) {
  const s = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = getShareTheme().accent;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (mealType === 'breakfast') {
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(12, 15, 6, 0, Math.PI, true);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(2, 15); ctx.lineTo(22, 15);
    ctx.moveTo(12, 4); ctx.lineTo(12, 7);
    ctx.moveTo(5.5, 7.5); ctx.lineTo(7.3, 9);
    ctx.moveTo(18.5, 7.5); ctx.lineTo(16.7, 9);
    ctx.stroke();
  } else if (mealType === 'lunch') {
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(12, 12, 4.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(12, 2); ctx.lineTo(12, 4.3);
    ctx.moveTo(12, 19.7); ctx.lineTo(12, 22);
    ctx.moveTo(2, 12); ctx.lineTo(4.3, 12);
    ctx.moveTo(19.7, 12); ctx.lineTo(22, 12);
    ctx.moveTo(4.9, 4.9); ctx.lineTo(6.4, 6.4);
    ctx.moveTo(17.6, 17.6); ctx.lineTo(19.1, 19.1);
    ctx.moveTo(4.9, 19.1); ctx.lineTo(6.4, 17.6);
    ctx.moveTo(17.6, 6.4); ctx.lineTo(19.1, 4.9);
    ctx.stroke();
  } else if (mealType === 'dinner') {
    ctx.lineWidth = 1.6;
    ctx.stroke(new Path2D('M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z'));
  } else if (mealType === 'snacks') {
    ctx.lineWidth = 1.5;
    ctx.stroke(new Path2D('M12 9c-3.5 0-6 2.6-6 6.2C6 19 8.4 21.5 11 21.5c.7 0 1-.3 1.5-.3.5 0 .8.3 1.5.3 2.6 0 5-2.5 5-6.3 0-3.6-2.5-6.2-6-6.2z'));
    ctx.stroke(new Path2D('M12 9c0-1.8.9-3 2.2-3.6'));
  }
  ctx.restore();
}

async function generateFoodDiaryShareCard({ name, digitalId, date, meals }) {
  const theme = getShareTheme();
  const activeMeals = MEAL_TYPES.filter(mt => meals[mt] && meals[mt].length);
  const width = 600;
  const headerH = 116;
  const mealHeaderH = 40;
  const itemRowH = 64;
  const mealGap = 18;
  const footerH = 46;

  let contentH = activeMeals.length ? 0 : 60;
  activeMeals.forEach(mt => { contentH += mealHeaderH + meals[mt].length * itemRowH + mealGap; });
  const height = headerH + contentH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, theme.bgFrom); bg.addColorStop(1, theme.bgTo);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.border; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = theme.accent; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);

  ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '14px monospace';
  ctx.fillText(date, width / 2, 74);

  ctx.textAlign = 'left'; ctx.fillStyle = theme.accent; ctx.font = 'bold 24px sans-serif';
  ctx.fillText('DIETARY LOG', 32, 106);

  let y = headerH;

  if (!activeMeals.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '15px sans-serif';
    ctx.fillText('No food logged for this date.', width / 2, y + 30);
    y += contentH;
  }

  activeMeals.forEach(mt => {
    const items = meals[mt];
    const mealKcal = items.reduce((s, i) => s + (i.calories || 0), 0);

    drawMealIcon(ctx, mt, 42, y + 16, 22);
    ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 19px sans-serif';
    ctx.fillText(FOOD_DIARY_MEAL_LABELS[mt], 60, y + 22);
    ctx.textAlign = 'right'; ctx.fillStyle = theme.accent; ctx.font = 'bold 17px monospace';
    ctx.fillText(`${round0(mealKcal)} kcal`, width - 32, y + 22);
    y += mealHeaderH;

    items.forEach(item => {
      const rh = itemRowH - 12;
      ctx.fillStyle = theme.rowAlt;
      ctx.strokeStyle = theme.gridLine; ctx.lineWidth = 1;
      roundRectPath(ctx, 32, y, width - 64, rh, 8);
      ctx.fill(); ctx.stroke();

      ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 17px sans-serif';
      ctx.fillText(item.name, 48, y + 24);
      const qtyStr = item.qty != null ? formatServingQty(item.qty, item.unit) : (item.grams ? round0(item.grams) + 'g' : '');
      const metaStr = `${qtyStr ? qtyStr + ' · ' : ''}${round0(item.calories)} kcal · P${round0(item.protein)}g C${round0(item.carbs)}g F${round0(item.fat)}g`;
      ctx.fillStyle = theme.textSecondary; ctx.font = '13px monospace';
      ctx.fillText(metaStr, 48, y + 44);
      y += itemRowH;
    });
    y += mealGap;
  });

  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareFoodDiary() {
  const profile = getProfile();
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  const totals = computeMealsNutritionTotals(meals);
  const text = `🍽️ Dietary log — ${round0(totals.calories)} kcal logged with Winfinity Tracker!`;
  const blob = await generateFoodDiaryShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(parseISO(date)),
    meals,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Dietary Log', text }, blob);
}

async function shareSingleMeal(mealType) {
  const profile = getProfile();
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  const items = meals[mealType] || [];
  if (!items.length) { showRestToast(`No items logged in ${FOOD_DIARY_MEAL_LABELS[mealType]} for this date.`); return; }
  const kcal = items.reduce((s, i) => s + (i.calories || 0), 0);
  const text = `🍽️ ${FOOD_DIARY_MEAL_LABELS[mealType]} — ${round0(kcal)} kcal logged with Winfinity Tracker!`;
  const singleMeal = { breakfast: [], lunch: [], dinner: [], snacks: [] };
  singleMeal[mealType] = items;
  const blob = await generateFoodDiaryShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(parseISO(date)),
    meals: singleMeal,
  });
  shareViaWebShare({ title: `Winfinity Tracker — ${FOOD_DIARY_MEAL_LABELS[mealType]}`, text }, blob);
}

function copyMealToClipboard(mealType) {
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  const items = meals[mealType] || [];
  if (!items.length) { showRestToast(`No items in ${FOOD_DIARY_MEAL_LABELS[mealType]} to copy.`); return; }
  localStorage.setItem('wft_meal_clipboard', JSON.stringify(items));
  localStorage.setItem('wft_meal_clipboard_source', `${FOOD_DIARY_MEAL_LABELS[mealType]} (${fmtDate(parseISO(date))})`);
  showRestToast(`Copied ${items.length} item${items.length > 1 ? 's' : ''} from ${FOOD_DIARY_MEAL_LABELS[mealType]}.`);
}

function pasteMealFromClipboard(mealType) {
  let clipboard = [];
  try { clipboard = JSON.parse(localStorage.getItem('wft_meal_clipboard')) || []; } catch (e) { clipboard = []; }
  if (!clipboard.length) { showRestToast('Nothing copied yet — copy a meal first.'); return; }
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  meals[mealType] = (meals[mealType] || []).concat(JSON.parse(JSON.stringify(clipboard)));
  saveMealsForDate(date, meals);
  renderFoodDiary(date);
  refreshFuelViewsForDate(date);
  const source = localStorage.getItem('wft_meal_clipboard_source');
  showRestToast(`Pasted ${clipboard.length} item${clipboard.length > 1 ? 's' : ''} into ${FOOD_DIARY_MEAL_LABELS[mealType]}${source ? ` from ${source}` : ''}.`);
}

function clearMealData(mealType) {
  const date = document.getElementById('foodDiaryDateInput').value || todayISO();
  const meals = getMealsForDate(date);
  const items = meals[mealType] || [];
  if (!items.length) { showRestToast(`${FOOD_DIARY_MEAL_LABELS[mealType]} is already empty.`); return; }
  if (!confirm(`Clear all ${items.length} item${items.length > 1 ? 's' : ''} logged in ${FOOD_DIARY_MEAL_LABELS[mealType]} for this date? This cannot be undone.`)) return;
  meals[mealType] = [];
  saveMealsForDate(date, meals);
  renderFoodDiary(date);
  refreshFuelViewsForDate(date);
  showRestToast(`Cleared ${FOOD_DIARY_MEAL_LABELS[mealType]}.`);
}

async function generateLeaderboardShareCard({ name, digitalId, dateTime, title, rows, formatValue }) {
  const theme = getShareTheme();
  const width = 600;
  const headerH = 158;
  const rowH = 52;
  const footerH = 46;
  const listRows = rows.slice(0, 10);
  const contentH = listRows.length ? listRows.length * rowH : 60;
  const height = headerH + contentH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, theme.bgFrom); bg.addColorStop(1, theme.bgTo);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.border; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = theme.accent; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);

  ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '14px monospace';
  ctx.fillText(dateTime, width / 2, 74);

  ctx.textAlign = 'left'; ctx.fillStyle = theme.accent; ctx.font = 'bold 24px sans-serif';
  ctx.fillText(title.toUpperCase(), 32, 116);

  let y = headerH;

  if (!listRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '15px sans-serif';
    ctx.fillText('No data yet.', width / 2, y + 30);
    y += contentH;
  }

  listRows.forEach((r, i) => {
    const rh = rowH - 10;
    ctx.fillStyle = i === 0 ? 'rgba(219,165,44,0.08)' : theme.rowAlt;
    ctx.strokeStyle = i === 0 ? 'rgba(219,165,44,0.4)' : theme.gridLine;
    ctx.lineWidth = 1;
    roundRectPath(ctx, 32, y, width - 64, rh, 8);
    ctx.fill(); ctx.stroke();

    const midY = y + rh / 2 + 5;
    ctx.textAlign = 'left'; ctx.fillStyle = i === 0 ? theme.warning : theme.textMuted; ctx.font = 'bold 14px monospace';
    ctx.fillText(String(i + 1).padStart(2, '0'), 48, midY);

    ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 16px sans-serif';
    ctx.fillText(r.code_name, 88, midY);
    if (r.public_id) {
      const nameW = ctx.measureText(r.code_name).width;
      ctx.fillStyle = theme.textMuted; ctx.font = '11px monospace';
      ctx.fillText(r.public_id, 88 + nameW + 8, midY);
    }

    ctx.textAlign = 'right'; ctx.fillStyle = theme.accent; ctx.font = 'bold 16px monospace';
    ctx.fillText(formatValue(r), width - 48, midY);
    y += rowH;
  });

  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareLeaderboardCard(containerId, title) {
  const cached = rankListDataCache[containerId];
  if (!cached || !cached.rows.length) { showRestToast('No ranking data to share yet.'); return; }
  const profile = getProfile();
  const now = new Date();
  const dateTime = `${fmtDate(now)} · ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const text = `🏆 ${title} — top ${Math.min(10, cached.rows.length)} on the Winfinity Nexus!`;
  const blob = await generateLeaderboardShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    dateTime,
    title,
    rows: cached.rows,
    formatValue: cached.opts.formatValue,
  });
  shareViaWebShare({ title: `Winfinity Tracker — ${title}`, text }, blob);
}

function drawShareWeightChart(ctx, x, y, w, h, series, wu) {
  const theme = getShareTheme();
  const padL = 34, padR = 8, padT = 6, padB = 18;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const displayVals = series.map(p => fromKg(p.actualKg, wu));
  const trendVals = series.map(p => fromKg(p.trendKg, wu));
  const allVals = displayVals.concat(trendVals);
  let min = Math.min(...allVals), max = Math.max(...allVals);
  if (min === max) { min -= 1; max += 1; }
  const rangePad = (max - min) * 0.1;
  min -= rangePad; max += rangePad;

  const xFor = i => x + padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const yFor = v => y + padT + plotH - ((v - min) / (max - min)) * plotH;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const v = min + (g / gridCount) * (max - min);
    const gy = yFor(v);
    ctx.strokeStyle = theme.gridLine; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + padL, gy); ctx.lineTo(x + w - padR, gy); ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = theme.textMuted; ctx.font = '9px monospace';
    ctx.fillText(String(round2(v)), x, gy + 3);
  }

  [0, Math.floor((series.length - 1) / 2), series.length - 1].forEach(i => {
    ctx.textAlign = i === 0 ? 'left' : i === series.length - 1 ? 'right' : 'center';
    ctx.fillStyle = theme.textMuted; ctx.font = '9px monospace';
    ctx.fillText(fmtDate(series[i].dateObj), xFor(i), y + h - 4);
  });

  if (series.length > 1) {
    ctx.beginPath();
    trendVals.forEach((v, i) => { const px = xFor(i), py = yFor(v); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.strokeStyle = theme.accentViolet; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (series.length > 1) {
    ctx.beginPath();
    displayVals.forEach((v, i) => { const px = xFor(i), py = yFor(v); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = theme.accent; ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  const lowestIdx = displayVals.indexOf(Math.min(...displayVals));
  displayVals.forEach((v, i) => {
    const isLowest = i === lowestIdx;
    ctx.beginPath();
    ctx.arc(xFor(i), yFor(v), (isLowest ? 1.4 : 1) * (series.length > 40 ? 2 : 3.5), 0, Math.PI * 2);
    ctx.fillStyle = isLowest ? theme.warning : theme.accent;
    if (isLowest) { ctx.shadowColor = theme.warning; ctx.shadowBlur = 6; }
    ctx.fill();
    ctx.shadowBlur = 0;
  });
  ctx.restore();
}

function drawShareGoalTrack(ctx, x, y, w, profile, kgNow, wu, lowestKg7d) {
  const theme = getShareTheme();
  const points = [
    { label: 'Start', kg: profile.startWeightKg },
    { label: 'Min goal', kg: profile.goalMinKg },
    { label: 'Target', kg: profile.goalTargetKg },
    { label: 'Dream', kg: profile.goalDreamKg },
  ].filter(p => p.kg != null);
  const allKg = points.map(p => p.kg).concat([kgNow]);
  if (lowestKg7d != null) allKg.push(lowestKg7d);
  let min = Math.min(...allKg), max = Math.max(...allKg);
  if (min === max) { min -= 1; max += 1; }
  const range = max - min;
  const pctFor = kg => (kg - min) / range;

  const trackY = y + 26;
  const trackH = 6;
  const startPct = points.length ? pctFor(points[0].kg) : 0;
  const nowPct = pctFor(kgNow);

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  points.forEach(p => {
    const px = x + pctFor(p.kg) * w;
    ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '11px monospace';
    ctx.fillText(`${p.label}: ${round2(fromKg(p.kg, wu))}${wu}`, Math.min(Math.max(px, x + 40), x + w - 40), trackY - 12);
    ctx.strokeStyle = theme.gridLine; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, trackY + trackH + 2); ctx.lineTo(px, trackY + trackH + 10); ctx.stroke();
  });

  roundRectPath(ctx, x, trackY, w, trackH, trackH / 2);
  ctx.fillStyle = theme.trackLine;
  ctx.fill();

  const fillX = x + Math.min(startPct, nowPct) * w;
  const fillW = Math.abs(nowPct - startPct) * w;
  const grad = ctx.createLinearGradient(fillX, 0, fillX + fillW, 0);
  grad.addColorStop(0, '#8b6bf2'); grad.addColorStop(0.55, '#3f8ff0'); grad.addColorStop(1, '#2de2e6');
  ctx.save();
  roundRectPath(ctx, fillX, trackY, Math.max(fillW, 2), trackH, trackH / 2);
  ctx.clip();
  ctx.fillStyle = grad;
  ctx.fillRect(fillX, trackY, Math.max(fillW, 2), trackH);
  ctx.restore();

  if (lowestKg7d != null) {
    const lowestX = x + pctFor(lowestKg7d) * w;
    ctx.textAlign = 'center'; ctx.fillStyle = theme.warning; ctx.font = 'bold 13px monospace';
    ctx.fillText(`Lowest (7d): ${round2(fromKg(lowestKg7d, wu))}${wu}`, Math.min(Math.max(lowestX, x + 55), x + w - 55), trackY + 34);
  }

  const nowX = x + nowPct * w;
  ctx.textAlign = 'center'; ctx.fillStyle = theme.accent; ctx.font = 'bold 13px monospace';
  ctx.fillText(`Now: ${round2(fromKg(kgNow, wu))}${wu}`, Math.min(Math.max(nowX, x + 40), x + w - 40), trackY + 52);
  ctx.restore();
}

function drawShareWeightChartCard(ctx, y, width, chartCardH, title, series, wu) {
  const theme = getShareTheme();
  roundRectPath(ctx, 24, y, width - 48, chartCardH, 12);
  ctx.strokeStyle = theme.gridLine; ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 14px sans-serif';
  ctx.fillText(title, 44, y + 24);
  ctx.textAlign = 'right'; ctx.fillStyle = theme.textMuted; ctx.font = '12px monospace';
  ctx.fillText(`${series.length} entries`, width - 44, y + 24);

  if (series.length) {
    drawShareWeightChart(ctx, 44, y + 34, width - 88, chartCardH - 60, series, wu);
    ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = '11px sans-serif';
    ctx.fillText('— Actual weight', 44, y + chartCardH - 14);
    ctx.fillStyle = theme.textMuted;
    ctx.fillText('- - Trend (7-day avg)', 190, y + chartCardH - 14);
  } else {
    ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '14px sans-serif';
    ctx.fillText('No weight entries logged yet.', width / 2, y + chartCardH / 2 + 5);
  }
}

async function generateWeightJourneyShareCard({ name, digitalId, date, recentSeries, fullSeries, wu, profile, kgNow, lowestKg7d }) {
  const theme = getShareTheme();
  const width = 600;
  const headerH = 116;
  const chartCardH = 250;
  const gap = 16;
  const goalCardH = 148;
  const footerH = 46;
  const height = headerH + chartCardH + gap + chartCardH + gap + goalCardH + footerH;

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, theme.bgFrom); bg.addColorStop(1, theme.bgTo);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.border; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.textBaseline = 'alphabetic';

  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = theme.accent; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);

  ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '14px monospace';
  ctx.fillText(date, width / 2, 74);

  ctx.textAlign = 'left'; ctx.fillStyle = theme.accent; ctx.font = 'bold 22px sans-serif';
  ctx.fillText('ENTITY WEIGHT JOURNEY', 32, 106);

  let y = headerH;

  // Two weight journey cards — recent 7 days on top, full journey since
  // day one below it — instead of just whichever view the in-app widget
  // happened to be toggled to when Share was tapped.
  drawShareWeightChartCard(ctx, y, width, chartCardH, 'Recent (7 days)', recentSeries, wu);
  y += chartCardH + gap;
  drawShareWeightChartCard(ctx, y, width, chartCardH, 'Full journey', fullSeries, wu);
  y += chartCardH + gap;

  // Goal progress card
  roundRectPath(ctx, 24, y, width - 48, goalCardH, 12);
  ctx.strokeStyle = theme.gridLine;
  ctx.stroke();
  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 16px sans-serif';
  ctx.fillText('Goal progress', 44, y + 30);

  if (profile && kgNow != null && profile.goalTargetKg != null) {
    drawShareGoalTrack(ctx, 64, y + 44, width - 176, profile, kgNow, wu, lowestKg7d);
  } else {
    ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '13px sans-serif';
    ctx.fillText('Set your weights in Bio to see progress.', width / 2, y + goalCardH / 2 + 10);
  }

  await drawShareWatermark(ctx, width, height);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareWeightJourney() {
  const profile = getProfile();
  const logsArr = sortedLogsArray();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const fullSeries = computeTrendSeries(logsArr);
  const recentSeries = fullSeries.slice(-7);
  const kgNow = currentWeightKg(profile);
  const lowestKg7d = minOfLastNDays(logsArr, 'weightKg', 7);
  const blob = await generateWeightJourneyShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(new Date()),
    recentSeries, fullSeries, wu, profile, kgNow, lowestKg7d,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Weight Journey', text: '📈 My weight journey & goal progress, tracked with Winfinity Tracker!' }, blob);
}

function drawShareVolumeChart(ctx, x, y, w, h, gymDays, volumes, wu) {
  const theme = getShareTheme();
  const padL = 34, padR = 8, padT = 6, padB = 18;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const max = Math.max(...volumes, 1);

  const xFor = i => x + padL + (gymDays.length === 1 ? plotW / 2 : (i / (gymDays.length - 1)) * plotW);
  const yFor = v => y + padT + plotH - (v / max) * plotH;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const gridCount = 3;
  for (let g = 0; g <= gridCount; g++) {
    const v = (g / gridCount) * max;
    const gy = yFor(v);
    ctx.strokeStyle = theme.gridLine; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + padL, gy); ctx.lineTo(x + w - padR, gy); ctx.stroke();
    ctx.textAlign = 'left'; ctx.fillStyle = theme.textMuted; ctx.font = '9px monospace';
    ctx.fillText(String(round0(v)), x, gy + 3);
  }

  [0, Math.floor((gymDays.length - 1) / 2), gymDays.length - 1].forEach(i => {
    ctx.textAlign = i === 0 ? 'left' : i === gymDays.length - 1 ? 'right' : 'center';
    ctx.fillStyle = theme.textMuted; ctx.font = '9px monospace';
    ctx.fillText(fmtDate(parseISO(gymDays[i].date)), xFor(i), y + h - 4);
  });

  if (gymDays.length > 1) {
    ctx.beginPath();
    volumes.forEach((v, i) => { const px = xFor(i), py = yFor(v); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.strokeStyle = theme.accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.shadowColor = theme.accent; ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  volumes.forEach((v, i) => {
    ctx.beginPath();
    ctx.arc(xFor(i), yFor(v), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = theme.accent;
    ctx.fill();
  });
  ctx.restore();
}

function drawShareVolumeChartCard(ctx, y, width, chartCardH, title, gymDays, wu) {
  const theme = getShareTheme();
  roundRectPath(ctx, 24, y, width - 48, chartCardH, 12);
  ctx.strokeStyle = theme.gridLine; ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 14px sans-serif';
  ctx.fillText(title, 44, y + 24);

  const volumes = gymDays.map(l => fromKg(computeDayVolumeKg(l), wu));
  ctx.textAlign = 'right'; ctx.fillStyle = theme.textMuted; ctx.font = '12px monospace';
  ctx.fillText(`${round0(volumes.reduce((s, v) => s + v, 0)).toLocaleString()} ${wu} total`, width - 44, y + 24);

  if (gymDays.length) {
    drawShareVolumeChart(ctx, 44, y + 34, width - 88, chartCardH - 60, gymDays, volumes, wu);
  } else {
    ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '14px sans-serif';
    ctx.fillText('No gym days logged yet.', width / 2, y + chartCardH / 2 + 5);
  }
}

// Same "two stacked cards" pattern as generateWeightJourneyShareCard —
// recent 7 gym days on top, every gym day ever logged below it — instead
// of whichever view the in-app widget happened to be toggled to.
async function generateVolumeJourneyShareCard({ name, digitalId, date, recentGymDays, fullGymDays, wu }) {
  const width = 600;
  const headerH = 116;
  const chartCardH = 220;
  const gap = 16;
  const footerH = 46;
  const height = headerH + 10 + chartCardH + gap + chartCardH + footerH;

  const { canvas, ctx } = shareCardShell(width, height);
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'TOTAL LIFT VOLUME' });

  let y = headerH + 10;
  drawShareVolumeChartCard(ctx, y, width, chartCardH, 'Recent (7 days)', recentGymDays, wu);
  y += chartCardH + gap;
  drawShareVolumeChartCard(ctx, y, width, chartCardH, 'Full journey', fullGymDays, wu);

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareVolumeJourney() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray();
  const full = allGymDays(logsArr);
  const recentGymDays = full.slice(-7);
  const blob = await generateVolumeJourneyShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(new Date()),
    recentGymDays, fullGymDays: full, wu,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Total Lift Volume', text: '🏋️ My lift volume trend, tracked with Winfinity Tracker!' }, blob);
}

function shareCardShell(width, height) {
  const theme = getShareTheme();
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, theme.bgFrom); bg.addColorStop(1, theme.bgTo);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.border; ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  return { canvas, ctx };
}

function drawShareCardHeader(ctx, width, { name, digitalId, date, title }) {
  const theme = getShareTheme();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left'; ctx.fillStyle = theme.textPrimary; ctx.font = 'bold 20px sans-serif';
  ctx.fillText(name || 'Operator', 32, 46);
  ctx.textAlign = 'right'; ctx.fillStyle = theme.accent; ctx.font = 'bold 15px monospace';
  ctx.fillText(digitalId || '', width - 32, 44);
  ctx.textAlign = 'center'; ctx.fillStyle = theme.textMuted; ctx.font = '14px monospace';
  ctx.fillText(date, width / 2, 74);
  ctx.textAlign = 'left'; ctx.fillStyle = theme.accent; ctx.font = 'bold 22px sans-serif';
  ctx.fillText(title, 32, 106);
}

// Cached across calls within the session so only the first share pays the
// image-load cost — every card after that draws from the already-loaded img.
let cachedShareLogoImage = null;
function loadShareLogoImage() {
  if (cachedShareLogoImage) return Promise.resolve(cachedShareLogoImage);
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => { cachedShareLogoImage = img; resolve(img); };
    img.onerror = () => resolve(null);
    img.src = 'icons/icon-192.png';
  });
}

// Small brand mark in the lower-right corner of every share card: the app
// icon + "WINFINITY", each sized to 70% of how they appear in the app's own
// header (28px logo / 1.1rem≈17.6px text there).
async function drawShareWatermark(ctx, width, height) {
  const theme = getShareTheme();
  const logoSize = Math.round(28 * 0.7);
  const fontSize = Math.round(17.6 * 0.7);
  const pad = 18;
  const img = await loadShareLogoImage();
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.accent;
  ctx.font = `800 ${fontSize}px "Courier New", monospace`;
  const centerY = height - pad - logoSize / 2;
  ctx.fillText('WINFINITY', width - pad, centerY);
  if (img) {
    const textW = ctx.measureText('WINFINITY').width;
    const iconX = width - pad - textW - 8 - logoSize;
    const iconY = height - pad - logoSize;
    ctx.shadowColor = theme.accent;
    ctx.shadowBlur = 4;
    ctx.drawImage(img, iconX, iconY, logoSize, logoSize);
  }
  ctx.restore();
}

async function drawShareCardFooter(ctx, width, height) {
  await drawShareWatermark(ctx, width, height);
}

function drawShareTable(ctx, x, y, w, columns, rows) {
  const theme = getShareTheme();
  const headerH = 22;
  const rowH = 22;
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 10px monospace'; ctx.fillStyle = theme.accent; ctx.textAlign = 'left';
  let cx = x;
  columns.forEach(col => { ctx.fillText(col.label, cx + 4, y + 15); cx += col.width; });
  ctx.strokeStyle = theme.gridLine; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + headerH); ctx.lineTo(x + w, y + headerH); ctx.stroke();
  ctx.font = '10px monospace';
  rows.forEach((row, ri) => {
    const ry = y + headerH + ri * rowH;
    if (ri % 2 === 1) { ctx.fillStyle = theme.rowAlt; ctx.fillRect(x, ry, w, rowH); }
    ctx.fillStyle = theme.textPrimary;
    let ccx = x;
    row.forEach((cell, ci) => {
      ctx.fillText(String(cell), ccx + 4, ry + 15);
      ccx += columns[ci].width;
    });
  });
  return headerH + Math.max(1, rows.length) * rowH;
}

async function generateHistoryLogShareCard({ name, digitalId, date, wu, rows }) {
  const width = 600;
  const headerH = 116;
  const columns = [
    { label: 'DATE', width: 78 }, { label: 'WT', width: 66 }, { label: 'STEPS', width: 76 },
    { label: 'CAL', width: 66 }, { label: 'PROT', width: 66 }, { label: 'SLEEP', width: 64 }, { label: 'EX', width: 56 },
  ];
  const tableRows = rows.map(l => [
    l.date.slice(5),
    l.weightKg != null ? round2(fromKg(l.weightKg, wu)) : '–',
    l.steps ?? '–',
    l.calories ?? '–',
    l.protein ?? '–',
    l.sleep ?? '–',
    (l.exercises && l.exercises.length) ? l.exercises.length : '–',
  ]);
  const tableH = 22 + Math.max(1, tableRows.length) * 22;
  const footerH = 46;
  const height = headerH + 20 + tableH + 24 + footerH;

  const { canvas, ctx } = shareCardShell(width, height);
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'ACCOMPLISHMENT LOG' });

  const y = headerH + 20;
  if (!tableRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = getShareTheme().textMuted; ctx.font = '14px sans-serif';
    ctx.fillText('No logs yet.', width / 2, y + 20);
  } else {
    drawShareTable(ctx, 32, y, width - 64, columns, tableRows);
  }

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function generateMeasurementHistoryShareCard({ name, digitalId, date, rows }) {
  const width = 600;
  const headerH = 116;
  // Transposed: one row per measurement, one column per logged date (most
  // recent first, matching the incoming row order) — makes it easy to read
  // straight across and compare recent vs. previous for the same spot,
  // instead of having to scan down a column across separate date-rows.
  const measureDefs = [
    { key: 'chest', label: 'Chest' },
    { key: 'shoulder', label: 'Shoulder' },
    { key: 'lBicep', label: 'L. Bicep' },
    { key: 'rBicep', label: 'R. Bicep' },
    { key: 'abdSupra', label: 'Abd. Supra' },
    { key: 'stomach', label: 'Stomach' },
    { key: 'abdInfra', label: 'Abd. Infra' },
    { key: 'hips', label: 'Hips' },
    { key: 'lThigh', label: 'L. Thigh' },
    { key: 'rThigh', label: 'R. Thigh' },
    { key: 'lCalf', label: 'L. Calf' },
    { key: 'rCalf', label: 'R. Calf' },
  ];
  const labelColW = 92;
  const dateColW = rows.length ? Math.min(90, (width - 64 - labelColW) / rows.length) : 90;
  const columns = [{ label: 'MEASURE', width: labelColW }, ...rows.map(l => ({ label: l.date.slice(5), width: dateColW }))];
  const tableRows = measureDefs
    .map(def => [def.label, ...rows.map(l => (l.measurements || {})[def.key] ?? '–')])
    .filter(row => row.slice(1).some(v => v !== '–'));
  const tableH = 22 + Math.max(1, tableRows.length) * 22;
  const footerH = 46;
  const height = headerH + 20 + tableH + 24 + footerH;

  const { canvas, ctx } = shareCardShell(width, height);
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'MEASUREMENT HISTORY' });

  const y = headerH + 20;
  const measureTheme = getShareTheme();
  if (!rows.length || !tableRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = measureTheme.textMuted; ctx.font = '14px sans-serif';
    ctx.fillText('No measurements logged yet.', width / 2, y + 20);
  } else {
    drawShareTable(ctx, 32, y, width - 64, columns, tableRows);
    ctx.textAlign = 'left'; ctx.fillStyle = measureTheme.textMuted; ctx.font = '10px monospace';
    ctx.fillText('Values in cm · left = most recent', 32, y + tableH + 16);
  }

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function generateBodyFatHistoryShareCard({ name, digitalId, date, rows }) {
  const width = 600;
  const headerH = 116;
  const orbR = 70, orbStroke = 14;
  const orbH = orbR * 2 + 56;
  const columns = [{ label: 'DATE', width: 200 }, { label: 'BODY FAT %', width: 200 }];
  const tableRows = rows.map(r => [r.date.slice(5), r.pct != null ? round2(r.pct) + '%' : '–']);
  const tableH = 22 + Math.max(1, tableRows.length) * 22;
  const footerH = 46;
  const height = headerH + orbH + 20 + tableH + 24 + footerH;

  const { canvas, ctx } = shareCardShell(width, height);
  const bodyFatTheme = getShareTheme();
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'BODY FAT % LOG' });

  // Orb matches the in-app Body Fat ring: latest reading, cyan stroke,
  // percentage centered inside — same shape used across the app's tabs.
  const latestPct = rows.length ? rows[0].pct : null;
  const orbCx = width / 2, orbCy = headerH + orbR + 8;
  drawShareRing(ctx, orbCx, orbCy, orbR, orbStroke, latestPct != null ? Math.min(100, Math.max(0, latestPct)) : 0, [bodyFatTheme.accent, bodyFatTheme.accent]);
  ctx.textAlign = 'center';
  ctx.fillStyle = bodyFatTheme.textPrimary; ctx.font = 'bold 30px monospace';
  ctx.fillText(latestPct != null ? round2(latestPct) + '%' : '–', orbCx, orbCy + 11);
  ctx.fillStyle = bodyFatTheme.textMuted; ctx.font = '13px monospace';
  ctx.fillText('BODY FAT', orbCx, orbCy + orbR + 34);

  const y = headerH + orbH + 20;
  if (!tableRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = bodyFatTheme.textMuted; ctx.font = '14px sans-serif';
    ctx.fillText('No body fat measurements logged yet.', width / 2, y + 20);
  } else {
    drawShareTable(ctx, 32, y, width - 64, columns, tableRows);
  }

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

function computeOutdoorActivitySummary(logsArr) {
  const sessions = [];
  logsArr.forEach(l => (l.cardioSessions || []).forEach(s => sessions.push({ date: l.date, ...s })));
  sessions.sort((a, b) => b.date.localeCompare(a.date));
  const totalDistanceKm = sessions.reduce((s, x) => s + (x.distanceKm || 0), 0);
  const totalDurationSec = sessions.reduce((s, x) => s + (x.durationSec || 0), 0);
  return { sessions, totalDistanceKm, totalDurationSec, count: sessions.length };
}

async function generateOutdoorActivityShareCard({ name, digitalId, date, summary, unit }) {
  const width = 600;
  const headerH = 116;
  const recent = summary.sessions.slice(0, 7);
  const columns = [
    { label: 'DATE', width: 90 }, { label: 'TYPE', width: 90 },
    { label: 'DIST', width: 120 }, { label: 'DURATION', width: 130 },
  ];
  const tableRows = recent.map(s => {
    const dist = unit === 'mi' ? kmToMi(s.distanceKm) : s.distanceKm;
    return [s.date.slice(5), s.type, dist.toFixed(2) + ' ' + unit, formatCardioDuration(s.durationSec)];
  });
  const tableH = tableRows.length ? 22 + tableRows.length * 22 : 30;
  const footerH = 46;
  const height = headerH + 92 + 26 + 20 + tableH + 24 + footerH;

  const { canvas, ctx } = shareCardShell(width, height);
  const outdoorTheme = getShareTheme();
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'OUTDOOR ACTIVITY SUMMARY' });

  let y = headerH;
  const tileGap = 14;
  const tileW = (width - 64 - tileGap * 2) / 3;
  const totalDist = unit === 'mi' ? kmToMi(summary.totalDistanceKm) : summary.totalDistanceKm;
  const tiles = [
    { value: String(summary.count), label: 'SESSIONS' },
    { value: totalDist.toFixed(1), label: `DISTANCE (${unit.toUpperCase()})` },
    { value: formatCardioDuration(summary.totalDurationSec), label: 'DURATION' },
  ];
  tiles.forEach((t, i) => {
    const x = 32 + i * (tileW + tileGap);
    ctx.strokeStyle = outdoorTheme.border; ctx.lineWidth = 1;
    roundRectPath(ctx, x, y, tileW, 92, 10);
    ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillStyle = outdoorTheme.textPrimary; ctx.font = 'bold 26px sans-serif';
    ctx.fillText(t.value, x + tileW / 2, y + 50);
    ctx.fillStyle = outdoorTheme.textMuted; ctx.font = '11px monospace';
    ctx.fillText(t.label, x + tileW / 2, y + 74);
  });
  y += 92 + 26 + 20;

  if (!tableRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = outdoorTheme.textMuted; ctx.font = '14px sans-serif';
    ctx.fillText('No outdoor activity logged yet.', width / 2, y + 15);
  } else {
    drawShareTable(ctx, 32, y, width - 64, columns, tableRows);
  }

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function generateRecentPerformanceShareCard({ name, digitalId, date, perfItems, days }) {
  const width = 600;
  const height = 560;
  const { canvas, ctx } = shareCardShell(width, height);
  const perfTheme = getShareTheme();
  drawShareCardHeader(ctx, width, { name, digitalId, date, title: 'RECENT PERFORMANCE (7D AVG)' });

  const STATUS_COLORS = { good: '#34bd7c', warning: '#dba52c', serious: '#e6824b', critical: '#e6516a', muted: perfTheme.textMuted };

  const tileRowH = 84;
  const tileGap = 12;
  const tileW = (width - 64 - tileGap) / 2;
  const tilesTop = 116;
  perfItems.forEach((p, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const x = 32 + col * (tileW + tileGap);
    const ty = tilesTop + row * (tileRowH + tileGap);
    roundRectPath(ctx, x, ty, tileW, tileRowH, 10);
    ctx.strokeStyle = perfTheme.gridLine; ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left'; ctx.fillStyle = perfTheme.textPrimary; ctx.font = 'bold 14px sans-serif';
    ctx.fillText(p.label, x + 14, ty + 24);

    const dotColor = STATUS_COLORS[p.status] || STATUS_COLORS.muted;
    ctx.fillStyle = dotColor; ctx.beginPath(); ctx.arc(x + tileW - 66, ty + 20, 4, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'right'; ctx.fillStyle = dotColor; ctx.font = 'bold 13px monospace';
    ctx.fillText(p.statusLabel, x + tileW - 14, ty + 24);

    const barCount = p.sparkline.length;
    const barGap = 4;
    const barAreaW = tileW - 28;
    const barW = (barAreaW - barGap * (barCount - 1)) / barCount;
    const barBaseY = ty + tileRowH - 12;
    const barMaxH = 34;
    p.sparkline.forEach((v, bi) => {
      const h = v != null ? Math.max(4, (v / 5) * barMaxH) : 3;
      const bx = x + 14 + bi * (barW + barGap);
      const isToday = bi === barCount - 1;
      ctx.fillStyle = isToday ? dotColor : perfTheme.trackLine;
      ctx.fillRect(bx, barBaseY - h, barW, h);
    });
  });

  const chartTop = tilesTop + tileRowH * 2 + tileGap + 24;
  ctx.textAlign = 'left'; ctx.fillStyle = perfTheme.textPrimary; ctx.font = 'bold 15px sans-serif';
  ctx.fillText('Steps vs Calories (7D)', 32, chartTop);

  const plotY = chartTop + 16;
  const chartX = 32, chartW = width - 64, chartPlotH = 110;
  const dayW = chartW / days.length;
  const barPairW = Math.min(20, dayW * 0.28);
  // Anything past 100% of goal draws as a second, warning-colored segment
  // stacked on top of the base bar — matches the overflow highlight on the
  // live in-app Steps vs Calories chart.
  const drawGoalBar = (x, pct, color) => {
    const baseY = plotY + chartPlotH;
    const baseH = Math.max(2, (Math.min(100, pct) / 130) * chartPlotH);
    ctx.fillStyle = color;
    ctx.fillRect(x, baseY - baseH, barPairW, baseH);
    if (pct > 100) {
      const overH = (Math.min(130, pct) - 100) / 130 * chartPlotH;
      ctx.fillStyle = perfTheme.warning;
      ctx.fillRect(x, baseY - baseH - overH, barPairW, overH);
    }
  };
  days.forEach((d, i) => {
    const cx = chartX + i * dayW + dayW / 2;
    drawGoalBar(cx - barPairW - 2, d.stepsPct, perfTheme.accent);
    drawGoalBar(cx + 2, d.calPct, perfTheme.accentViolet);
    ctx.textAlign = 'center'; ctx.fillStyle = perfTheme.textMuted; ctx.font = '10px monospace';
    ctx.fillText(d.weekday, cx, plotY + chartPlotH + 16);
  });
  ctx.strokeStyle = perfTheme.gridLine; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(chartX, plotY + chartPlotH); ctx.lineTo(chartX + chartW, plotY + chartPlotH); ctx.stroke();

  const legendY = plotY + chartPlotH + 36;
  ctx.textAlign = 'left'; ctx.font = '11px sans-serif';
  ctx.fillStyle = perfTheme.accent; ctx.fillRect(32, legendY - 9, 10, 10);
  ctx.fillStyle = perfTheme.textPrimary; ctx.fillText('Steps', 48, legendY);
  ctx.fillStyle = perfTheme.accentViolet; ctx.fillRect(120, legendY - 9, 10, 10);
  ctx.fillStyle = perfTheme.textPrimary; ctx.fillText('Calories', 136, legendY);

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

async function shareRecentPerformance() {
  const profile = getProfile();
  const logsArr = sortedLogsArray();
  const perfDefs = [
    ['Sleep quality', 'sleep'], ['Stress', 'stress'], ['Fatigue', 'fatigue'], ['Hunger', 'hunger'],
  ];
  const perfItems = perfDefs.map(([label, field]) => {
    const val = avgOfLastNDays(logsArr, field, 7);
    return {
      label, field,
      status: statusForLevel(field, val),
      statusLabel: labelForLevel(field, val),
      sparkline: last7DailyValues(field),
    };
  });

  const stepGoal = getEffectiveStepGoal(profile);
  const calorieTarget = getEffectiveCalorieTarget(profile) || 2000;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const entry = logsArr.find(l => l.date === iso);
    days.push({
      weekday: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
      stepsPct: entry && entry.steps != null ? (entry.steps / stepGoal) * 100 : 0,
      calPct: entry && entry.calories != null ? (entry.calories / calorieTarget) * 100 : 0,
    });
  }

  const blob = await generateRecentPerformanceShareCard({
    name: (profile && profile.name) || 'Operator',
    digitalId: getOrCreatePublicId(),
    date: fmtDate(new Date()),
    perfItems, days,
  });
  shareViaWebShare({ title: 'Winfinity Tracker — Recent Performance', text: '📊 My 7-day performance, tracked with Winfinity Tracker!' }, blob);
}

function initNutrition() {
  document.getElementById('nutDate').value = todayISO();
  updateFuelLogBtnLabel();
  document.getElementById('nutDate').addEventListener('change', e => {
    loadNutritionForDate(e.target.value);
    renderNutritionTargets();
    refreshFuelWaterViews(e.target.value);
    updateFuelLogBtnLabel();
  });
  document.getElementById('btnGoToBioFromFuel').addEventListener('click', () => {
    document.querySelector('.tab-btn[data-target="bio"]').click();
  });
  document.getElementById('btnShareFuelStatus').addEventListener('click', shareDailyFuelStatus);
  document.getElementById('btnShareFuelSnapshot').addEventListener('click', shareFuelSnapshot);
  const carryoverMenuBtn = document.getElementById('btnCarryoverMenu');
  const carryoverMenu = document.getElementById('carryoverMenu');
  carryoverMenuBtn.addEventListener('click', () => {
    if (carryoverMenu.hidden) document.getElementById('btnReturnOverflow').disabled = !hasCancelledOverflow();
    carryoverMenu.hidden = !carryoverMenu.hidden;
  });
  document.addEventListener('click', e => {
    if (!carryoverMenu.hidden && !e.target.closest('#carryoverMenu') && e.target !== carryoverMenuBtn && !carryoverMenuBtn.contains(e.target)) {
      carryoverMenu.hidden = true;
    }
  });
  document.getElementById('btnCancelOverflow').addEventListener('click', () => {
    carryoverMenu.hidden = true;
    resetCalorieCarryover();
  });
  document.getElementById('btnReturnOverflow').addEventListener('click', () => {
    carryoverMenu.hidden = true;
    returnCalorieOverflow();
  });

  initFuelWaterOrb();
  loadNutritionForDate(todayISO());
  renderNutritionTargets();
  renderNutritionAverages();
  initCoachAssignment();
  initRequestAssessment();
}

function loadCoachAssignment() {
  const profile = getProfile();
  document.getElementById('coachCalorieInput').value = (profile && profile.coachCalorieTarget) || '';
  document.getElementById('coachStepsInput').value = (profile && profile.coachStepGoal) || '';
  document.getElementById('coachWorkoutsInput').value = (profile && profile.coachWorkoutsPerWeek) || '';
  document.getElementById('coachRefeedCalories').value = (profile && profile.refeedCalories) || '';
  document.getElementById('coachRefeedStart').value = (profile && profile.refeedStart) || '';
  document.getElementById('coachRefeedEnd').value = (profile && profile.refeedEnd) || '';
}

async function refreshCoachAssignmentFromServer() {
  const note = document.getElementById('coachRefreshNote');
  const btn = document.getElementById('btnRefreshCoachAssignment');
  if (!sbConfigured()) { note.textContent = 'Not available offline.'; return; }
  const profile = getProfile();
  if (!profile) { note.textContent = 'Set up your profile in BIO first.'; return; }
  btn.disabled = true;
  note.textContent = 'Checking for a new assignment…';
  try {
    const shareKey = getOrCreateShareKey();
    const { data, error } = await sb.from('assigned_targets').select('*').eq('share_key', shareKey).maybeSingle();
    if (error) throw error;
    if (!data) {
      note.textContent = 'No assignment from your coach yet.';
      return;
    }
    profile.coachCalorieTarget = data.calorie_target;
    profile.coachStepGoal = data.step_goal;
    profile.coachWorkoutsPerWeek = data.workouts_per_week;
    profile.refeedCalories = data.refeed_calories;
    profile.refeedStart = data.refeed_start;
    profile.refeedEnd = data.refeed_end;
    // Applied immediately on refresh, independent of whether the visible
    // targets below get saved — same pull the coach assignment itself
    // uses, just a second field riding along on it.
    if (data.show_social_links !== null && data.show_social_links !== undefined) {
      profile.footerSocialLinksVisible = data.show_social_links;
      applyFooterSocialLinksVisibility(profile.footerSocialLinksVisible);
    }
    saveProfile(profile);
    loadCoachAssignment();
    renderNutritionTargets();
    renderDashboard();
    renderTrainingStats();
    note.textContent = 'Refreshed — assignment updated ' + fmtDate(parseISO(data.updated_at.slice(0, 10))) + '.';
  } catch (e) {
    note.textContent = e.message || 'Could not check for an assignment — try again.';
  } finally {
    btn.disabled = false;
  }
}

function initCoachAssignment() {
  loadCoachAssignment();
  document.getElementById('btnRefreshCoachAssignment').addEventListener('click', refreshCoachAssignmentFromServer);
  document.getElementById('btnSaveCoachAssignment').addEventListener('click', () => {
    const profile = getProfile();
    const note = document.getElementById('coachAssignmentNote');
    if (!profile) {
      alert('Set up your profile in BIO first, then assign coach targets here.');
      return;
    }
    const refeedStart = document.getElementById('coachRefeedStart').value || null;
    const refeedEnd = document.getElementById('coachRefeedEnd').value || null;
    if (refeedStart && refeedEnd && refeedStart > refeedEnd) {
      note.textContent = 'Refeed start date must be on or before the end date.';
      return;
    }
    profile.coachCalorieTarget = parseIntOrNull(document.getElementById('coachCalorieInput').value);
    profile.coachStepGoal = parseIntOrNull(document.getElementById('coachStepsInput').value);
    profile.coachWorkoutsPerWeek = parseIntOrNull(document.getElementById('coachWorkoutsInput').value);
    profile.refeedCalories = parseIntOrNull(document.getElementById('coachRefeedCalories').value);
    profile.refeedStart = refeedStart;
    profile.refeedEnd = refeedEnd;
    saveProfile(profile);
    note.textContent = 'Assignment saved.';
    setTimeout(() => { note.textContent = ''; }, 2500);
    renderNutritionTargets();
    renderDashboard();
    renderTrainingStats();
  });
}

async function buildAssessmentBlobs() {
  const profile = getProfile();
  const name = (profile && profile.name) || 'Operator';
  const digitalId = getOrCreatePublicId();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray();
  const nowDate = fmtDate(new Date());
  // Kicked off together (not one-by-one with sequential awaits) to keep the
  // total wait as short as possible — a long delay here before the eventual
  // navigator.share() call risks the browser no longer treating it as
  // tied to the tap that started it, which some browsers silently reject.
  const jobs = [];

  if (document.getElementById('assessChkHistory').checked) {
    jobs.push(generateHistoryLogShareCard({
      name, digitalId, date: nowDate, wu, rows: logsArr.slice(-7).reverse(),
    }).then(blob => ({ name: 'accomplishment-log.png', blob })));
  }

  if (document.getElementById('assessChkMeasurements').checked) {
    jobs.push(generateMeasurementHistoryShareCard({
      name, digitalId, date: nowDate, rows: logsArr.filter(l => l.measurements).slice(-5).reverse(),
    }).then(blob => ({ name: 'measurement-history.png', blob })));
  }

  if (document.getElementById('assessChkBodyFat').checked) {
    const age = profile ? profile.age : null;
    const gender = profile ? profile.gender : 'male';
    const bodyFatRows = logsArr.filter(hasLoggedSkinfolds).slice(-7).reverse().map(l => ({
      date: l.date,
      pct: l.bodyFatPct ?? computeBodyFatJP7(l.skinfolds || {}, age, gender),
    }));
    jobs.push(generateBodyFatHistoryShareCard({
      name, digitalId, date: nowDate, rows: bodyFatRows,
    }).then(blob => ({ name: 'bodyfat-log.png', blob })));
  }

  if (document.getElementById('assessChkWeight').checked) {
    const fullSeries = computeTrendSeries(logsArr);
    const recentSeries = fullSeries.slice(-7);
    const kgNow = currentWeightKg(profile);
    const lowestKg7d = minOfLastNDays(logsArr, 'weightKg', 7);
    jobs.push(generateWeightJourneyShareCard({
      name, digitalId, date: nowDate, recentSeries, fullSeries, wu, profile, kgNow, lowestKg7d,
    }).then(blob => ({ name: 'weight-journey.png', blob })));
  }

  if (document.getElementById('assessChkPerformance').checked) {
    const perfDefs = [['Sleep quality', 'sleep'], ['Stress', 'stress'], ['Fatigue', 'fatigue'], ['Hunger', 'hunger']];
    const perfItems = perfDefs.map(([label, field]) => {
      const val = avgOfLastNDays(logsArr, field, 7);
      return { label, field, status: statusForLevel(field, val), statusLabel: labelForLevel(field, val), sparkline: last7DailyValues(field) };
    });
    const stepGoal = getEffectiveStepGoal(profile);
    const calorieTargetForChart = getEffectiveCalorieTarget(profile) || 2000;
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const entry = logsArr.find(l => l.date === iso);
      days.push({
        weekday: d.toLocaleDateString(undefined, { weekday: 'narrow' }),
        stepsPct: entry && entry.steps != null ? (entry.steps / stepGoal) * 100 : 0,
        calPct: entry && entry.calories != null ? (entry.calories / calorieTargetForChart) * 100 : 0,
      });
    }
    jobs.push(generateRecentPerformanceShareCard({ name, digitalId, date: nowDate, perfItems, days })
      .then(blob => ({ name: 'recent-performance.png', blob })));
  }

  if (document.getElementById('assessChkWorkout').checked) {
    const trainDate = getActiveTrainingDate();
    const exercisesForDate = (getLogs()[trainDate] && getLogs()[trainDate].exercises) || [];
    const summary = computeWorkoutSummaryFromExercises(exercisesForDate, trainDate);
    jobs.push(generateWorkoutSummaryShareCard({
      name, digitalId, dateTime: fmtDate(parseISO(trainDate)), summary,
      volumeTrend: computeVolumeTrendData(),
    }).then(blob => ({ name: 'workout-summary.png', blob })));
  }

  if (document.getElementById('assessChkOutdoor').checked) {
    const summary = computeOutdoorActivitySummary(logsArr);
    jobs.push(generateOutdoorActivityShareCard({
      name, digitalId, date: nowDate, summary, unit: distUnitForProfile(profile),
    }).then(blob => ({ name: 'outdoor-activity.png', blob })));
  }

  if (document.getElementById('assessChkFuel').checked) {
    const date = todayISO();
    const entry = getLogs()[date] || {};
    const calorieTarget = getEffectiveCalorieTarget(profile, date) || 0;
    const caloriesNow = entry.calories ?? 0;
    const proteinNow = entry.protein ?? 0;
    const carbsNow = entry.carbs ?? 0;
    const fatNow = entry.fat ?? 0;
    const macros = [
      { label: 'Protein', kcal: proteinNow * 4, color: '#33c8cc', pct: caloriesNow > 0 ? Math.round((proteinNow * 4 / caloriesNow) * 100) : 0 },
      { label: 'Carbs', kcal: carbsNow * 4, color: '#8069d6', pct: caloriesNow > 0 ? Math.round((carbsNow * 4 / caloriesNow) * 100) : 0 },
      { label: 'Fat', kcal: fatNow * 9, color: '#dba52c', pct: caloriesNow > 0 ? Math.round((fatNow * 9 / caloriesNow) * 100) : 0 },
    ];
    jobs.push(generateFuelStatusShareCard({
      name, digitalId, date: fmtDate(parseISO(date)), caloriesNow, calorieTarget, macros,
      waterNow: entry.water || 0,
      waterTarget: effectiveWaterTargetML(date),
    }).then(blob => ({ name: 'daily-fuel-status.png', blob })));
  }

  if (document.getElementById('assessChkFuelSnapshot').checked) {
    jobs.push(generateFuelSnapshotShareCard({
      name, digitalId, date: nowDate, ...computeFuelSnapshotShareData(),
    }).then(blob => ({ name: 'fuel-snapshot.png', blob })));
  }

  return Promise.all(jobs);
}

function openAssessmentOverlay() {
  document.getElementById('assessmentShareNote').textContent = '';
  document.getElementById('assessmentShareOverlay').hidden = false;
}

function initRequestAssessment() {
  const overlay = document.getElementById('assessmentShareOverlay');
  document.getElementById('btnRequestAssessment').addEventListener('click', openAssessmentOverlay);
  document.getElementById('btnCloseAssessmentShare').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });

  document.getElementById('btnAssessmentShareSubmit').addEventListener('click', async () => {
    const note = document.getElementById('assessmentShareNote');
    const btn = document.getElementById('btnAssessmentShareSubmit');
    btn.disabled = true;
    note.textContent = 'Preparing…';
    try {
      const blobs = await buildAssessmentBlobs();
      if (!blobs.length) {
        note.textContent = 'Check at least one item to share.';
        btn.disabled = false;
        return;
      }
      const result = await shareMultipleViaWebShare({
        title: 'Winfinity Tracker — Assessment',
        text: '📋 My fitness assessment, tracked with Winfinity Tracker!',
      }, blobs);
      if (result === 'shared') {
        overlay.hidden = true;
      } else if (result === 'cancelled') {
        note.textContent = 'Share cancelled — images were still saved to your device.';
      } else {
        note.textContent = "Direct sharing isn't available on this browser — images were saved to your device instead.";
      }
    } catch (e) {
      note.textContent = 'Could not prepare assessment: ' + (e.message || 'try again');
    }
    btn.disabled = false;
  });
}

// Pure — protein/carb/fat/fiber/sodium targets for a given day. Shared by
// the mobile Nutrition tab (renderNutritionTargets) and the desktop
// dashboard (renderWdsNutrition) so the two formulas can't drift apart.
function computeMacroTargets(profile, date) {
  const kg = profile ? currentWeightKg(profile) : null;
  const targets = (profile && kg) ? computeTargets(profile, kg) : null;
  if (!targets) return null;
  const calorieTarget = getEffectiveCalorieTarget(profile, date);
  const proteinTarget = round0((targets.protein[0] + targets.protein[1]) / 2);
  const fatTarget = round0((calorieTarget * 0.3) / 9);
  const carbTarget = Math.max(0, round0((calorieTarget - proteinTarget * 4 - fatTarget * 9) / 4));
  const fiberTarget = round0((calorieTarget / 1000) * 14);
  const sodiumTarget = 2300;
  return { calorieTarget, proteinTarget, carbTarget, fatTarget, fiberTarget, sodiumTarget };
}

function renderNutritionTargets() {
  const profile = getProfile();
  const emptyBox = document.getElementById('nutTargetsEmpty');
  const statRows = document.querySelectorAll('#fuelStatusCard .fuel-cal-row, #fuelStatusCard .gradient-stat-row');
  const kg = profile ? currentWeightKg(profile) : null;
  const targets = (profile && kg) ? computeTargets(profile, kg) : null;

  if (!targets) {
    emptyBox.hidden = false;
    statRows.forEach(el => el.style.display = 'none');
    return;
  }
  emptyBox.hidden = true;
  statRows.forEach(el => el.style.display = '');

  const date = document.getElementById('nutDate').value;
  const { calorieTarget, proteinTarget, carbTarget, fatTarget, fiberTarget, sodiumTarget } = computeMacroTargets(profile, date);

  const entry = getLogs()[date] || {};
  const caloriesNow = entry.calories ?? 0;
  const proteinNow = entry.protein ?? 0;
  const carbsNow = entry.carbs ?? 0;
  const fatNow = entry.fat ?? 0;
  const fiberNow = entry.fiber ?? 0;
  const sodiumNow = entry.sodium ?? 0;

  const carryover = getCalorieCarryover(date, profile);
  const effectiveCalorieTarget = Math.max(1, calorieTarget + carryover);
  const caloriePctRaw = (caloriesNow / effectiveCalorieTarget) * 100;
  const caloriePct = Math.min(100, caloriePctRaw);
  const calorieOverflowPct = Math.max(0, caloriePctRaw - 100);
  const isOverCalories = caloriePctRaw > 100;
  renderRing(document.getElementById('fuelCalorieRing'), caloriePct, {
    size: 120, stroke: 10, gradient: true, overflowPct: calorieOverflowPct,
    centerHtml: isOverCalories
      ? `<span style="font-size:${Math.round(120 * 0.22)}px;font-weight:800;font-family:var(--font-mono);color:var(--critical);">${Math.round(caloriePctRaw)}%</span>`
      : undefined,
    centerText: Math.round(caloriePctRaw) + '%',
    label: 'Calories',
    sub: `${caloriesNow} / ${effectiveCalorieTarget} kcal${carryover !== 0 ? ` (${carryover > 0 ? '+' : '−'}${round0(Math.abs(carryover))} carried over)` : ''}`,
  });

  const proteinKcal = proteinNow * 4;
  const carbKcal = carbsNow * 4;
  const fatKcal = fatNow * 9;
  const macroLegend = document.getElementById('fuelMacroLegend');
  const macros = [
    { label: 'Protein', kcal: proteinKcal, dot: 'macro-protein' },
    { label: 'Carbs', kcal: carbKcal, dot: 'macro-carbs' },
    { label: 'Fat', kcal: fatKcal, dot: 'macro-fat' },
  ];
  macroLegend.innerHTML = macros.map(m => {
    const pctOfIntake = caloriesNow > 0 ? Math.round((m.kcal / caloriesNow) * 100) : 0;
    return `<li><span class="macro-dot ${m.dot}"></span>${m.label} <strong>${pctOfIntake}%</strong> of intake</li>`;
  }).join('');

  document.getElementById('fuelProteinNow').textContent = proteinNow + 'g';
  document.getElementById('fuelProteinTarget').textContent = proteinTarget + 'g';
  document.getElementById('fuelProteinBar').style.width = Math.min(100, (proteinNow / proteinTarget) * 100) + '%';

  document.getElementById('fuelCarbsNow').textContent = carbsNow + 'g';
  document.getElementById('fuelCarbsTarget').textContent = carbTarget + 'g';
  document.getElementById('fuelCarbsBar').style.width = Math.min(100, (carbsNow / carbTarget) * 100) + '%';

  document.getElementById('fuelFatNow').textContent = fatNow + 'g';
  document.getElementById('fuelFatTarget').textContent = fatTarget + 'g';
  document.getElementById('fuelFatBar').style.width = Math.min(100, (fatNow / fatTarget) * 100) + '%';

  document.getElementById('fuelFiberNow').textContent = fiberNow + 'g';
  document.getElementById('fuelFiberTarget').textContent = fiberTarget + 'g';
  document.getElementById('fuelFiberBar').style.width = Math.min(100, (fiberNow / fiberTarget) * 100) + '%';

  document.getElementById('fuelSodiumNow').textContent = sodiumNow + 'mg';
  document.getElementById('fuelSodiumTarget').textContent = sodiumTarget + 'mg';
  document.getElementById('fuelSodiumBar').style.width = Math.min(100, (sodiumNow / sodiumTarget) * 100) + '%';
}

// Fuel Snapshot ring row: Calories stays a 7-day average (day-to-day intake
// is noisy, the trend is what matters); Protein and Water are today's
// values (they're things you act on today, not a trailing average).
function ringCurrentVsTarget(current, target, unitSuffix) {
  const pct = target ? Math.min(100, (current / target) * 100) : 0;
  const centerHtml = target != null
    ? `<div style="line-height:1.15;text-align:center;">
        <div style="font-size:15px;font-weight:800;font-family:var(--font-mono);color:var(--text-primary);">${round0(current)}${unitSuffix || ''}</div>
        <div style="font-size:9px;font-family:var(--font-mono);color:var(--text-muted);">/${round0(target)}${unitSuffix || ''}</div>
      </div>`
    : undefined;
  return { pct, centerHtml };
}

function renderNutritionAverages() {
  const profile = getProfile();
  const today = todayISO();
  const todayEntry = getLogs()[today] || {};
  const logsArr = sortedLogsArray();

  const avgCalories = avgOfLastNDays(logsArr, 'calories', 7);
  const calorieTarget = profile ? getEffectiveCalorieTarget(profile, today) : null;
  const calRing = ringCurrentVsTarget(avgCalories ?? 0, calorieTarget, '');
  renderRing(document.getElementById('avgCaloriesRing'), avgCalories != null ? calRing.pct : 0, {
    size: 96, stroke: 7, gradient: true,
    centerHtml: avgCalories != null ? calRing.centerHtml : undefined,
    label: 'Calories', sub: '7-day avg',
  });

  const kg = profile ? currentWeightKg(profile) : null;
  const targets = (profile && kg) ? computeTargets(profile, kg) : null;
  const proteinTarget = targets ? round0((targets.protein[0] + targets.protein[1]) / 2) : null;
  const protRing = ringCurrentVsTarget(todayEntry.protein ?? 0, proteinTarget, 'g');
  renderRing(document.getElementById('avgProteinRing'), protRing.pct, {
    size: 96, stroke: 7, gradient: true,
    centerHtml: protRing.centerHtml,
    label: 'Protein', sub: 'Today',
  });

  const waterTarget = effectiveWaterTargetML(today);
  const waterRing = ringCurrentVsTarget(todayEntry.water ?? 0, waterTarget, '');
  renderRing(document.getElementById('avgWaterRing'), waterRing.pct, {
    size: 96, stroke: 7, gradient: true,
    centerHtml: waterRing.centerHtml,
    label: 'Water', sub: 'Today',
  });
}

/* ---------------------------------------------------------------- */
/* Daily review                                                         */
/* ---------------------------------------------------------------- */
function computeDailyReviewChecklist(date) {
  const entry = getLogs()[date] || {};
  return {
    weight: entry.weightKg != null,
    sleep: entry.sleep != null,
    steps: entry.steps != null,
    levels: entry.stress != null && entry.fatigue != null && entry.hunger != null,
    water: !!entry.water,
    training: !!(entry.exercises && entry.exercises.length > 0),
    calories: entry.calories != null,
    protein: entry.protein != null,
    cardio: !!(entry.cardioSessions && entry.cardioSessions.length > 0),
  };
}

// prefix lets the same checklist render into either the standalone Daily
// Review panel (Settings, ids drCheck*) or the copy embedded under End Day
// Log (ids edlCheck*) — both read the same computeDailyReviewChecklist().
function renderDailyReviewChecklist(date, prefix) {
  prefix = prefix || 'dr';
  const c = computeDailyReviewChecklist(date);
  const el = suffix => document.getElementById(prefix + 'Check' + suffix);
  if (!el('Weight')) return;
  el('Weight').checked = c.weight;
  el('Sleep').checked = c.sleep;
  el('Steps').checked = c.steps;
  el('Levels').checked = c.levels;
  el('Water').checked = c.water;
  el('Training').checked = c.training;
  el('Calories').checked = c.calories;
  el('Protein').checked = c.protein;
  el('Cardio').checked = c.cardio;
}

function loadDailyReviewForDate(date) {
  const reviews = getDailyReviews();
  const r = reviews[date] || {};
  document.getElementById('dailyReviewStruggle').value = r.struggle || '';
  document.getElementById('dailyReviewFix').value = r.fix || '';
  renderDailyReviewChecklist(date);
}

function initDailyReviewForm() {
  const form = document.getElementById('dailyReviewForm');
  const dateInput = document.getElementById('dailyReviewDate');
  dateInput.value = todayISO();

  dateInput.addEventListener('change', () => loadDailyReviewForDate(dateInput.value));

  form.addEventListener('submit', e => {
    e.preventDefault();
    const date = dateInput.value;
    const reviews = getDailyReviews();
    reviews[date] = {
      date,
      struggle: document.getElementById('dailyReviewStruggle').value,
      fix: document.getElementById('dailyReviewFix').value,
    };
    saveDailyReviews(reviews);
    document.getElementById('dailyReviewSaveNote').textContent = 'Saved daily review for ' + date;
    setTimeout(() => { document.getElementById('dailyReviewSaveNote').textContent = ''; }, 2000);
  });

  loadDailyReviewForDate(todayISO());
}

/* ---------------------------------------------------------------- */
/* Weekly review                                                        */
/* ---------------------------------------------------------------- */
function initReviewForm() {
  const form = document.getElementById('reviewForm');
  document.getElementById('reviewDate').value = todayISO();

  form.addEventListener('submit', e => {
    e.preventDefault();
    const date = document.getElementById('reviewDate').value;
    const reviews = getReviews();
    const focus = Array.from(document.querySelectorAll('.reviewFocus')).filter(c => c.checked).map(c => c.value);
    reviews[date] = {
      date,
      adjustments: document.getElementById('reviewAdjustments').value,
      wins: document.getElementById('reviewWins').value,
      improvements: document.getElementById('reviewImprovements').value,
      focus,
      other: document.getElementById('reviewOther').value,
    };
    saveReviews(reviews);
    document.getElementById('reviewSaveNote').textContent = 'Saved review for week ending ' + date;
    setTimeout(() => { document.getElementById('reviewSaveNote').textContent = ''; }, 2000);
    form.reset();
    document.getElementById('reviewDate').value = todayISO();
  });
}

/* ---------------------------------------------------------------- */
/* History                                                             */
/* ---------------------------------------------------------------- */
function renderHistory() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray().slice().reverse();
  const body = document.getElementById('historyBody');
  const emptyNote = document.getElementById('historyEmptyNote');
  body.innerHTML = '';
  if (!logsArr.length) { emptyNote.hidden = false; return; }
  emptyNote.hidden = true;
  logsArr.forEach(l => {
    const exCount = l.exercises ? l.exercises.length : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.date}</td>
      <td>${l.weightKg != null ? round2(fromKg(l.weightKg, wu)) : '–'}</td>
      <td>${l.steps ?? '–'}</td>
      <td>${l.calories ?? '–'}</td>
      <td>${l.protein ?? '–'}</td>
      <td>${l.sleep ?? '–'}</td>
      <td>${exCount > 0 ? exCount + ' ex' : '–'}</td>`;
    body.appendChild(tr);
  });
}

function renderMeasureHistory() {
  const logsArr = sortedLogsArray().slice().reverse().filter(l => l.measurements);
  const body = document.getElementById('measureHistoryBody');
  const emptyNote = document.getElementById('measureHistoryEmptyNote');
  body.innerHTML = '';
  if (!logsArr.length) { emptyNote.hidden = false; return; }
  emptyNote.hidden = true;
  logsArr.forEach(l => {
    const m = l.measurements || {};
    const c = v => v ?? '–';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.date}</td>
      <td>${c(m.chest)}</td>
      <td>${c(m.shoulder)}</td>
      <td>${c(m.lBicep)}</td>
      <td>${c(m.rBicep)}</td>
      <td>${c(m.abdSupra)}</td>
      <td>${c(m.stomach)}</td>
      <td>${c(m.abdInfra)}</td>
      <td>${c(m.hips)}</td>
      <td>${c(m.lThigh)}</td>
      <td>${c(m.rThigh)}</td>
      <td>${c(m.lCalf)}</td>
      <td>${c(m.rCalf)}</td>`;
    body.appendChild(tr);
  });
}

function renderBodyFatHistory() {
  const logsArr = sortedLogsArray().slice().reverse().filter(hasLoggedSkinfolds);
  const body = document.getElementById('bodyFatHistoryBody');
  const emptyNote = document.getElementById('bodyFatHistoryEmptyNote');
  body.innerHTML = '';
  if (!logsArr.length) { emptyNote.hidden = false; return; }
  emptyNote.hidden = true;
  const profile = getProfile();
  const age = profile ? profile.age : null;
  const gender = profile ? profile.gender : 'male';
  logsArr.forEach(l => {
    const sf = l.skinfolds || {};
    const c = v => v ?? '–';
    const pct = l.bodyFatPct ?? computeBodyFatJP7(sf, age, gender);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${l.date}</td>
      <td>${c(sf.chest)}</td>
      <td>${c(sf.abdomen)}</td>
      <td>${c(sf.thigh)}</td>
      <td>${c(sf.triceps)}</td>
      <td>${c(sf.suprailiac)}</td>
      <td>${c(sf.subscapular)}</td>
      <td>${c(sf.midaxillary)}</td>
      <td>${pct != null ? round2(pct) + '%' : '–'}</td>`;
    body.appendChild(tr);
  });
}

/* ---------------------------------------------------------------- */
/* CSV export + share                                                  */
/* ---------------------------------------------------------------- */
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function formatExercises(exercises, wu) {
  if (!exercises || !exercises.length) return '';
  return exercises.map(ex => {
    const setsText = (ex.sets || [])
      .filter(s => s.completed)
      .map(s => `${s.reps ?? '?'}x${s.weightKg != null ? round2(fromKg(s.weightKg, wu)) : '?'}${wu}`)
      .join('/');
    return `${ex.name} (${setsText || 'no completed sets'})`;
  }).join('; ');
}

function buildCSV(logsArr, profile) {
  const wu = profile ? profile.weightUnit || 'kg' : 'kg';
  const habitLabels = (profile ? profile.extraHabits || [] : []).map((l, i) => ({ label: l, idx: i })).filter(h => h.label);
  const headers = ['Date', `Weight (${wu})`, 'Sleep Quality (1-5)', 'Stress (1-5)', 'Fatigue (1-5)', 'Hunger (1-5)',
    'Steps', 'Calories', 'Protein (g)', 'Water (mL)', 'Workout Done', 'Exercises', 'Menstruating',
    ...habitLabels.map(h => h.label)];
  const rows = [headers];
  logsArr.forEach(l => {
    const row = [
      l.date,
      l.weightKg != null ? round2(fromKg(l.weightKg, wu)) : '',
      l.sleep ?? '', l.stress ?? '', l.fatigue ?? '', l.hunger ?? '',
      l.steps ?? '', l.calories ?? '', l.protein ?? '', l.water ?? '',
      l.workout ? 'Yes' : 'No',
      formatExercises(l.exercises, wu),
      l.menstruating ? 'Yes' : 'No',
      ...habitLabels.map(h => (l.extra && l.extra[h.idx]) ? 'Yes' : 'No'),
    ];
    rows.push(row);
  });
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
}

async function exportCSV(logsArr, filenamePrefix) {
  const profile = getProfile();
  if (!logsArr.length) {
    alert('No log entries found for this range yet.');
    return;
  }
  const BOM = '﻿';
  const csv = BOM + buildCSV(logsArr, profile);
  const filename = `${filenamePrefix}-${todayISO()}.csv`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const file = new File([blob], filename, { type: 'text/csv' });

  if (isNativeApp()) {
    await nativeShareFile(blob, filename, 'text/csv', { title: filename, text: 'Weekly fitness log' });
    return;
  }
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename, text: 'Weekly fitness log' });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  alert('CSV downloaded: ' + filename + '\nOpen your email app, start a new message, and attach the file from Downloads.');
}

// Digital ID (public_id) + the private share_key it's tied to ride along in
// every backup so restoring on a wiped/new device reclaims the SAME Nexus
// identity automatically instead of minting a fresh one — that split is what
// caused the leaderboard to show two rows for one person after a data wipe.
function getBackupPayload(extra) {
  return Object.assign({
    profile: getProfile(), logs: getLogs(), reviews: getReviews(),
    digitalId: getOrCreatePublicId(), shareKey: getOrCreateShareKey(),
  }, extra || {});
}

function downloadBackupJSON() {
  const data = getBackupPayload();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `fitness-backup-${todayISO()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  localStorage.setItem('wft_drive_last_backup', todayISO());
  renderDashboard();
  autoSyncDriveBackupToNexus();
  maybeAutoApplyUpdate();
}

function getBackupMode() {
  return localStorage.getItem('wft_backup_mode') || 'manual';
}
function setBackupMode(mode) {
  localStorage.setItem('wft_backup_mode', mode);
}
let autoBackupTimerId = null;
function startAutoBackupTimer() {
  if (autoBackupTimerId) clearInterval(autoBackupTimerId);
  autoBackupTimerId = setInterval(() => {
    if (getBackupMode() === 'auto') downloadBackupJSON();
  }, 6 * 60 * 60 * 1000);
}

function initExport() {
  document.getElementById('btnExportWeek').addEventListener('click', () => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0,0,0,0);
    const arr = sortedLogsArray().filter(l => parseISO(l.date) >= cutoff);
    exportCSV(arr, 'fitness-log-week');
  });
  document.getElementById('btnExportAll').addEventListener('click', () => {
    exportCSV(sortedLogsArray(), 'fitness-log-all');
  });

  document.getElementById('btnBackup').addEventListener('click', downloadBackupJSON);

  const backupModeButtons = document.querySelectorAll('#backupModeSwitch .unit-switch-btn');
  const backupModeHint = document.getElementById('backupModeHint');
  const refreshBackupModeUI = () => {
    const mode = getBackupMode();
    backupModeButtons.forEach(btn => btn.classList.toggle('is-active', btn.dataset.mode === mode));
    backupModeHint.textContent = mode === 'auto'
      ? 'Auto — backs up automatically every 6 hours while the app is open.'
      : 'Manual — tap "Back Up Now" whenever you want to save a JSON backup.';
  };
  backupModeButtons.forEach(btn => btn.addEventListener('click', () => {
    setBackupMode(btn.dataset.mode);
    refreshBackupModeUI();
  }));
  refreshBackupModeUI();
  startAutoBackupTimer();

  document.getElementById('fileRestore').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.profile) saveProfile(data.profile);
      if (data.logs) saveLogs(data.logs);
      if (data.reviews) saveReviews(data.reviews);
      // Reclaim the same Nexus identity this backup was saved under, so the
      // device doesn't mint a fresh share_key/Digital ID and end up split
      // across two leaderboard rows.
      if (data.shareKey) localStorage.setItem('wft_lb_share_key', data.shareKey);
      if (data.digitalId) localStorage.setItem('wft_public_id', data.digitalId);
      localStorage.removeItem('wft_demo_seeded_at');
      alert('Backup restored.' + (data.digitalId ? ` Digital ID ${data.digitalId} reclaimed.` : ''));
      loadSetupForm();
      loadCheckinForm();
      renderDashboard();
      renderHistory();
      renderMeasureHistory();
      renderBodyFatHistory();
    } catch (err) {
      alert('Could not read that backup file.');
    }
    e.target.value = '';
  });
}

/* ---------------------------------------------------------------- */
/* Google Drive backup                                                  */
/* ---------------------------------------------------------------- */
let driveTokenClient = null;
let driveAccessToken = null;

function setDriveStatus(text) {
  const el = document.getElementById('driveStatus');
  if (el) el.textContent = text;
}

function driveConfigured() {
  return typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith('YOUR_CLIENT_ID');
}

function initDrive() {
  const connectBtn = document.getElementById('btnDriveConnect');
  const syncBtn = document.getElementById('btnDriveSyncNow');

  if (!driveConfigured()) {
    setDriveStatus('Not set up yet — add your Google Client ID in config.js to enable Drive backup.');
    connectBtn.disabled = true;
    return;
  }

  connectBtn.addEventListener('click', () => connectDrive());
  syncBtn.addEventListener('click', () => {
    saveToDrive(true);
    if (localStorage.getItem('wft_lb_optin') === '1' && sbConfigured()) updateLeaderboard();
  });

  // Native Android app: Google Identity Services (the web flow below)
  // deliberately refuses to run inside any embedded WebView as an
  // anti-phishing measure — that's what "Google sign-in isn't available
  // right now" actually means here, not a real connectivity problem. The
  // real Android Google Sign-In SDK isn't subject to that restriction, so
  // it's wired in via the GoogleAuth Capacitor plugin instead.
  if (isNativeApp() && window.Capacitor.Plugins.GoogleAuth) {
    window.Capacitor.Plugins.GoogleAuth.initialize().catch(() => {});
    if (localStorage.getItem('wft_drive_connected')) {
      connectBtn.hidden = true;
      syncBtn.hidden = false;
      setDriveStatus('Connected. Tap Backup now to sync.');
    } else {
      setDriveStatus('Not connected.');
    }
    return;
  }

  const tryInit = () => {
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      setDriveStatus('Waiting for Google sign-in to load (requires internet)…');
      return false;
    }
    driveTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
      callback: (resp) => {
        if (resp.error) { setDriveStatus('Sign-in failed: ' + resp.error); return; }
        driveAccessToken = resp.access_token;
        localStorage.setItem('wft_drive_connected', '1');
        connectBtn.hidden = true;
        syncBtn.hidden = false;
        setDriveStatus('Connected. Syncing…');
        saveToDrive();
        syncAccountLogFromGoogle(driveAccessToken);
      },
    });
    if (localStorage.getItem('wft_drive_connected')) {
      connectBtn.hidden = true;
      syncBtn.hidden = false;
      setDriveStatus('Connected. Tap Backup now to sync.');
    } else {
      setDriveStatus('Not connected.');
    }
    return true;
  };

  if (!tryInit()) {
    window.addEventListener('load', () => setTimeout(tryInit, 800));
  }
}

function connectDrive() {
  if (isNativeApp() && window.Capacitor.Plugins.GoogleAuth) {
    window.Capacitor.Plugins.GoogleAuth.signIn().then(user => {
      driveAccessToken = user.authentication.accessToken;
      localStorage.setItem('wft_drive_connected', '1');
      document.getElementById('btnDriveConnect').hidden = true;
      document.getElementById('btnDriveSyncNow').hidden = false;
      setDriveStatus('Connected. Syncing…');
      saveToDrive();
      syncAccountLogFromGoogle(driveAccessToken);
    }).catch(err => {
      setDriveStatus('Sign-in failed: ' + ((err && err.message) || 'try again.'));
    });
    return;
  }
  if (!driveTokenClient) {
    alert('Google sign-in isn\'t available right now. Check your internet connection and try again.');
    return;
  }
  driveTokenClient.requestAccessToken({ prompt: 'consent' });
}

async function saveToDrive(manual) {
  if (!driveAccessToken) {
    const wasConnected = localStorage.getItem('wft_drive_connected');
    if (!wasConnected) {
      if (manual) alert('Not connected to Google Drive yet.');
      return;
    }
    if (isNativeApp() && window.Capacitor.Plugins.GoogleAuth) {
      setDriveStatus('Reconnecting…');
      try {
        const user = await window.Capacitor.Plugins.GoogleAuth.signIn();
        driveAccessToken = user.authentication.accessToken;
        saveToDrive(manual);
      } catch (e) {
        setDriveStatus('Reconnect failed — tap Connect to sign in again.');
      }
      return;
    }
    if (!driveTokenClient) {
      if (manual) alert('Google sign-in isn\'t available right now. Check your internet connection.');
      return;
    }
    // Only reached from an explicit backup action (button tap or finishing a workout),
    // never automatically on page load — so a sign-in prompt here is expected.
    setDriveStatus('Reconnecting…');
    driveTokenClient.requestAccessToken({ prompt: '' });
    return;
  }
  setDriveStatus('Syncing…');
  const data = getBackupPayload({ savedAt: new Date().toISOString() });
  const body = JSON.stringify(data, null, 2);
  const fileId = localStorage.getItem('wft_drive_file_id');
  try {
    if (fileId) {
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${driveAccessToken}`, 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) throw new Error('upload failed: ' + res.status);
    } else {
      const boundary = 'wft_boundary_' + Date.now();
      const metadata = { name: 'winfinity-fitness-backup.json', mimeType: 'application/json' };
      const multipartBody =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: { Authorization: `Bearer ${driveAccessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipartBody,
      });
      if (!res.ok) throw new Error('create failed: ' + res.status);
      const json = await res.json();
      if (json.id) localStorage.setItem('wft_drive_file_id', json.id);
    }
    localStorage.setItem('wft_drive_last_backup', todayISO());
    setDriveStatus('Last synced ' + new Date().toLocaleTimeString());
    renderDashboard();
    activateNexusFastChat();
    autoSyncDriveBackupToNexus();
    maybeAutoApplyUpdate();
  } catch (e) {
    setDriveStatus('Sync failed — will retry on next save.');
  }
}

/* ---------------------------------------------------------------- */
/* Leaderboard (anonymous opt-in, Supabase-backed)                      */
/* ---------------------------------------------------------------- */
let sb = null;
function sbConfigured() {
  const hasCreds = typeof SUPABASE_URL === 'string' && SUPABASE_URL && !SUPABASE_URL.startsWith('YOUR_') &&
    typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.startsWith('YOUR_');
  if (!hasCreds) return false;
  if (!sb && window.supabase) sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return !!sb;
}

// Global (all-users, not per-device) counter of how many times the app has
// been opened — shown on the Nexus tab. Fires once per app load; the write
// itself happens server-side via increment_app_opens() (see
// supabase_app_opens_migration.sql) so a client can never set the count to
// an arbitrary value, only bump it by one.
async function incrementAppOpens() {
  if (!sbConfigured()) return;
  try {
    const { data, error } = await sb.rpc('increment_app_opens');
    if (!error && typeof data === 'number') {
      const el = document.getElementById('nexusAppOpens');
      if (el) el.textContent = data.toLocaleString();
    }
  } catch (e) { /* best effort, opportunistic */ }
}

// Re-reads the current total (not just the value from our own increment)
// so it stays accurate against everyone else's opens too, each time the
// Nexus tab is actually viewed.
async function refreshAppOpensStat() {
  if (!sbConfigured()) return;
  try {
    const { data, error } = await sb.from('app_stats').select('open_count').eq('id', 1).single();
    if (!error && data) {
      const el = document.getElementById('nexusAppOpens');
      if (el) el.textContent = Number(data.open_count).toLocaleString();
    }
  } catch (e) { /* best effort, opportunistic */ }
}

const LB_ADJECTIVES = ['Swift', 'Neon', 'Silent', 'Blazing', 'Iron', 'Crimson', 'Frost', 'Turbo', 'Cosmic', 'Rapid'];
const LB_NOUNS = ['Falcon', 'Tiger', 'Comet', 'Wolf', 'Phoenix', 'Panther', 'Rocket', 'Viper', 'Eagle', 'Storm'];

function generateCodeName() {
  const a = LB_ADJECTIVES[Math.floor(Math.random() * LB_ADJECTIVES.length)];
  const n = LB_NOUNS[Math.floor(Math.random() * LB_NOUNS.length)];
  const num = Math.floor(Math.random() * 90 + 10);
  return `${a} ${n} ${num}`;
}
function generateShareKey() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function computeLeaderboardStats() {
  const profile = getProfile();
  const wu = profile ? (profile.weightUnit || 'kg') : 'kg';
  const logsArr = sortedLogsArray();
  const kgNow = currentWeightKg(profile);
  const startKg = profile ? profile.startWeightKg : null;
  const progressKg = (kgNow != null && startKg != null) ? (kgNow - startKg) : null;
  const progressPct = (progressKg != null && startKg) ? round2((progressKg / startKg) * 100) : null;
  const steps = avgOfLastNDays(logsArr, 'steps', 7);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 6); cutoff.setHours(0,0,0,0);
  const volumeKg = logsArr.filter(l => parseISO(l.date) >= cutoff).reduce((sum, l) =>
    sum + (l.exercises || []).reduce((s, ex) =>
      s + ex.sets.filter(st => st.completed && st.weightKg != null && st.reps != null).reduce((ss, st) => ss + st.weightKg * st.reps, 0), 0), 0);

  const allRuns = logsArr.reduce((acc, l) => acc.concat((l.cardioSessions || []).filter(s => s.type === 'run')), []);
  const furthestRunKm = allRuns.length ? Math.max(...allRuns.map(s => s.distanceKm)) : null;
  const pacedRuns = allRuns.filter(s => s.distanceKm >= 1 && s.durationSec > 0);
  const fastestRunPaceSec = pacedRuns.length ? Math.min(...pacedRuns.map(s => s.durationSec / s.distanceKm)) : null;

  return {
    weight: kgNow != null ? round2(fromKg(kgNow, wu)) : null,
    weightUnit: wu,
    progress: progressKg != null ? round2(fromKg(progressKg, wu)) : null,
    progressPct,
    steps: steps != null ? round0(steps) : null,
    volume: round0(fromKg(volumeKg, wu)),
    volumeUnit: wu,
    furthestRunKm: furthestRunKm != null ? round2(furthestRunKm) : null,
    fastestRunPaceSec: fastestRunPaceSec != null ? Math.round(fastestRunPaceSec) : null,
  };
}

function effectiveLeaderboardName() {
  const profile = getProfile();
  const bioName = profile && profile.name && profile.name.trim();
  if (bioName) return bioName;
  if (!localStorage.getItem('wft_lb_fallback_name')) localStorage.setItem('wft_lb_fallback_name', generateCodeName());
  return localStorage.getItem('wft_lb_fallback_name');
}

function updateCodeNameHint() {
  const hint = document.getElementById('lbCodeNameHint');
  const optedIn = localStorage.getItem('wft_lb_optin') === '1';
  hint.textContent = optedIn ? `Sharing as "${effectiveLeaderboardName()}"` : 'Not sharing. Turn on to join the Nexus.';
}

// Current consecutive-day streak of fully-complete daily logs — the same
// completeness check the Fitness Journey Mode system uses to gate
// features, reused here as the "Conscientious" leaderboard metric. Counts
// backward from today (if today is already complete) or yesterday,
// stopping at the first incomplete/missing day.
function computeConscientiousScore() {
  const profile = getProfile();
  const today = todayISO();
  const todayEntry = getLogs()[today];

  const habit = computeHabitCompletion(profile, todayEntry);

  const waterGoal = (profile && profile.waterGoal) || 3000;
  const waterToday = (todayEntry && todayEntry.water != null) ? todayEntry.water : 0;
  const waterPct = waterGoal > 0 ? (waterToday / waterGoal) * 100 : 0;

  const calorieTarget = getEffectiveCalorieTarget(profile) || 2000;
  const caloriesToday = (todayEntry && todayEntry.calories != null) ? todayEntry.calories : 0;
  const caloriePct = calorieTarget > 0 ? (caloriesToday / calorieTarget) * 100 : 0;

  const kgForFuel = currentWeightKg(profile);
  const targetsForFuel = (profile && kgForFuel) ? computeTargets(profile, kgForFuel) : null;
  const proteinTarget = targetsForFuel ? round0((targetsForFuel.protein[0] + targetsForFuel.protein[1]) / 2) : null;
  const proteinToday = (todayEntry && todayEntry.protein != null) ? todayEntry.protein : 0;
  const proteinPct = proteinTarget ? (proteinToday / proteinTarget) * 100 : 0;

  const lifeFuelPct = Math.round((Math.min(100, waterPct) + Math.min(100, caloriePct) + Math.min(100, proteinPct)) / 3);

  return Math.round((habit.pct + lifeFuelPct) / 2);
}

async function pushLeaderboardEntry() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  const stats = computeLeaderboardStats();
  const { error } = await sb.rpc('upsert_leaderboard_entry', {
    p_share_key: shareKey,
    p_code_name: effectiveLeaderboardName(),
    p_weight: stats.weight,
    p_weight_unit: stats.weightUnit,
    p_weight_progress: stats.progress,
    p_weight_progress_pct: stats.progressPct,
    p_steps: stats.steps,
    p_volume_lifted: stats.volume,
    p_volume_unit: stats.volumeUnit,
  });
  if (error) throw error;
  try { await sb.rpc('set_public_id', { p_share_key: shareKey, p_public_id: getOrCreatePublicId() }); }
  catch (e) { /* best effort — group-chat invites just won't resolve until this succeeds */ }
  try {
    await sb.rpc('set_run_records', {
      p_share_key: shareKey,
      p_furthest_run_km: stats.furthestRunKm,
      p_fastest_run_pace_sec: stats.fastestRunPaceSec,
    });
  } catch (e) { /* best effort — Furthest/Fastest Run rankings just won't update until this succeeds */ }
  try {
    await sb.rpc('set_conscientious_score', { p_share_key: shareKey, p_score: computeConscientiousScore() });
  } catch (e) { /* best effort — Conscientious ranking just won't update until this succeeds */ }
  try {
    await sb.rpc('set_fitness_mode', { p_share_key: shareKey, p_mode: getFitnessMode() });
  } catch (e) { /* best effort — rank badge just won't update on other people's screens until this succeeds */ }
}

async function autoSyncLeaderboardIfOptedIn() {
  if (!sbConfigured() || localStorage.getItem('wft_lb_optin') !== '1') return;
  try {
    await pushLeaderboardEntry();
    document.getElementById('nexusTotalUsers') && pullLeaderboard().then(renderNexusRankings).catch(() => {});
  } catch (e) { /* best effort — don't block the training flow on Nexus sync failure */ }
}

async function autoSyncDriveBackupToNexus() {
  if (!sbConfigured()) return;
  getOrCreateShareKey();
  try {
    await pushLeaderboardEntry();
    document.getElementById('nexusTotalUsers') && pullLeaderboard().then(renderNexusRankings).catch(() => {});
  } catch (e) { /* best effort — don't block the backup flow on Nexus sync failure */ }
}

// Reads the signed-in Google account's email via the userinfo endpoint
// (requires the userinfo.email scope requested alongside drive.file when
// connecting Drive backup — see initDrive()) and syncs it, together with
// this device's profile gender and manually-set weather location, to the
// admin-only Sync Logs table. Best-effort and silent on failure, same as
// every other Nexus sync — a missed sync just means this row stays stale
// until the next successful Drive backup connection/refresh.
async function syncAccountLogFromGoogle(accessToken) {
  if (!sbConfigured() || !accessToken) return;
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return;
    const info = await res.json();
    if (!info.email) return;
    const profile = getProfile();
    const manualLoc = getManualWeatherLocation();
    await sb.rpc('set_account_sync_log', {
      p_share_key: getOrCreateShareKey(),
      p_public_id: getOrCreatePublicId(),
      p_email: info.email,
      p_gender: profile ? profile.gender : null,
      p_location: manualLoc ? manualLoc.label : null,
    });
  } catch (e) { /* best effort — Sync Logs row just won't update until next successful sign-in */ }
}

// Rows untouched for 7+ days quietly drop out of rankings/counts here —
// the row itself is never deleted server-side, so the moment that person
// syncs again (updated_at refreshes) they reappear automatically. Nothing
// on their own device is touched by this at all.
const LEADERBOARD_INACTIVE_MS = 7 * 24 * 60 * 60 * 1000;

async function pullLeaderboard() {
  const { data, error } = await sb.from('leaderboard')
    .select('code_name, public_id, weight, weight_unit, weight_progress, weight_progress_pct, steps, volume_lifted, volume_unit, furthest_run_km, fastest_run_pace_sec, conscientious_score, fitness_mode, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  const cutoff = Date.now() - LEADERBOARD_INACTIVE_MS;
  return (data || []).filter(r => r.updated_at && new Date(r.updated_at).getTime() >= cutoff);
}

async function removeFromLeaderboard() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  if (!shareKey || !sbConfigured()) return;
  try { await sb.rpc('delete_leaderboard_entry', { p_share_key: shareKey }); }
  catch (e) { /* best effort */ }
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}

const rankListExpanded = {};

// Keeps only each person's best-scoring row — a name that shows up more than
// once (re-installs, case differences, etc.) shouldn't crowd out other people
// with duplicate entries of the same person's other records.
function dedupeRankRows(rows, isBetter) {
  const bestByName = new Map();
  rows.forEach(r => {
    const key = (r.code_name || '').trim().toLowerCase();
    const existing = bestByName.get(key);
    if (!existing || isBetter(r, existing)) bestByName.set(key, r);
  });
  return Array.from(bestByName.values());
}

const rankListDataCache = {};

function renderRankList(containerId, rows, opts) {
  const container = document.getElementById(containerId);
  const expandBtn = document.querySelector(`.rank-expand-btn[data-target="${containerId}"]`);
  rankListDataCache[containerId] = { rows, opts };
  container.innerHTML = '';
  if (!rows.length) {
    container.innerHTML = '<p class="empty-note">No data yet.</p>';
    if (expandBtn) expandBtn.hidden = true;
    return;
  }
  const top10 = rows.slice(0, 10);
  const expanded = !!rankListExpanded[containerId];
  const visible = expanded ? top10 : top10.slice(0, 3);
  visible.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'rank-row' + (i === 0 ? ' is-top' : '');
    const modeIcon = MODE_ICON[r.fitness_mode];
    row.innerHTML = `<span class="rank-num">${String(i + 1).padStart(2, '0')}</span>
      ${modeIcon ? `<img class="rank-mode-icon" src="${modeIcon}" alt="${escapeHtml(MODE_LABEL[r.fitness_mode] || '')}" title="${escapeHtml(MODE_LABEL[r.fitness_mode] || '')}">` : ''}
      <span class="rank-name">${escapeHtml(r.code_name)}${r.public_id ? `<span class="rank-digital-id">${escapeHtml(r.public_id)}</span>` : ''}</span>
      <span class="rank-value">${opts.formatValue(r)}</span>`;
    container.appendChild(row);
  });
  if (expandBtn) {
    expandBtn.hidden = top10.length <= 3;
    expandBtn.textContent = expanded ? '⤡' : '⤢';
    expandBtn.title = expanded ? 'Show top 3' : `Show top ${top10.length}`;
    expandBtn.onclick = () => {
      rankListExpanded[containerId] = !expanded;
      renderRankList(containerId, rows, opts);
    };
  }
}

function renderNexusRankings(rows) {
  document.getElementById('lbEmptyNote').hidden = rows.length > 0;

  const ONLINE_WINDOW_MS = 5 * 60 * 1000;
  const onlineNow = rows.filter(r => r.updated_at && (Date.now() - new Date(r.updated_at).getTime()) < ONLINE_WINDOW_MS).length;
  document.getElementById('nexusTotalUsers').textContent = rows.length;
  document.getElementById('nexusOnlineUsers').textContent = onlineNow;

  const bySteps = dedupeRankRows(rows.filter(r => r.steps != null), (a, b) => a.steps > b.steps).sort((a, b) => b.steps - a.steps);
  renderRankList('lbStepsRanking', bySteps, { formatValue: r => r.steps >= 1000 ? (r.steps / 1000).toFixed(1) + 'k' : String(r.steps) });

  const byVolume = dedupeRankRows(rows.filter(r => r.volume_lifted != null), (a, b) => a.volume_lifted > b.volume_lifted).sort((a, b) => b.volume_lifted - a.volume_lifted);
  renderRankList('lbVolumeRanking', byVolume, { formatValue: r => round0(r.volume_lifted) + ' ' + (r.volume_unit || 'kg') });

  const byProgress = dedupeRankRows(rows.filter(r => r.weight_progress_pct != null), (a, b) => a.weight_progress_pct < b.weight_progress_pct).sort((a, b) => a.weight_progress_pct - b.weight_progress_pct);
  renderRankList('lbBioRanking', byProgress, { formatValue: r => (r.weight_progress_pct > 0 ? '+' : '') + r.weight_progress_pct + '%' });

  const byFurthestRun = dedupeRankRows(rows.filter(r => r.furthest_run_km != null), (a, b) => a.furthest_run_km > b.furthest_run_km).sort((a, b) => b.furthest_run_km - a.furthest_run_km);
  renderRankList('lbFurthestRunRanking', byFurthestRun, { formatValue: r => round2(r.furthest_run_km) + ' km' });

  const byFastestRun = dedupeRankRows(rows.filter(r => r.fastest_run_pace_sec != null), (a, b) => a.fastest_run_pace_sec < b.fastest_run_pace_sec).sort((a, b) => a.fastest_run_pace_sec - b.fastest_run_pace_sec);
  renderRankList('lbFastestRunRanking', byFastestRun, { formatValue: r => formatPaceSecPerUnit(r.fastest_run_pace_sec) + ' /km' });

  const byConscientious = dedupeRankRows(rows.filter(r => r.conscientious_score != null), (a, b) => a.conscientious_score > b.conscientious_score).sort((a, b) => b.conscientious_score - a.conscientious_score);
  renderRankList('lbConscientiousRanking', byConscientious, { formatValue: r => r.conscientious_score + '%' });
}

let currentChatRoomId = localStorage.getItem('wft_chat_room') || null;
let pendingChatImageDataUrl = null;
function clearPendingChatImage() {
  pendingChatImageDataUrl = null;
  document.getElementById('chatPendingImage').hidden = true;
  document.getElementById('chatImageInput').value = '';
}

async function fetchChatMessages() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let q = sb.from('chat_messages').select('id, code_name, message, image_url, created_at, deleted, sender_share_key').gte('created_at', cutoff);
  q = currentChatRoomId ? q.eq('room_id', currentChatRoomId) : q.is('room_id', null);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  const messages = (data || []).slice().reverse();
  const ids = messages.map(m => m.id);
  if (ids.length) {
    const { data: reactions } = await sb.from('chat_message_reactions').select('message_id, share_key, emoji').in('message_id', ids);
    const byMsg = {};
    (reactions || []).forEach(r => { (byMsg[r.message_id] = byMsg[r.message_id] || []).push(r); });
    messages.forEach(m => { m.reactions = byMsg[m.id] || []; });
  }
  return messages;
}

// shareKeyOverride/codeNameOverride let the desktop dashboard post as the
// real signed-in account (wdsRemoteData.shareKey / profile name) instead of
// this device's own local identity — every mobile call site omits them and
// gets the exact same behavior as before.
// roomIdOverride lets a caller target a SPECIFIC room explicitly (the
// desktop Messenger popups do this) without touching the shared
// currentChatRoomId global mobile's own room switcher uses — passing
// undefined (every pre-existing call site) preserves the old behavior
// exactly.
async function postChatMessage(text, imageDataUrl, shareKeyOverride, codeNameOverride, roomIdOverride) {
  const trimmed = text.trim().slice(0, 280);
  if (!trimmed && !imageDataUrl) return;

  let imageUrl = null;
  if (imageDataUrl) imageUrl = await uploadChatImage(imageDataUrl, shareKeyOverride);

  const { error } = await sb.from('chat_messages').insert({
    code_name: codeNameOverride || effectiveLeaderboardName(),
    message: trimmed,
    image_url: imageUrl,
    room_id: roomIdOverride !== undefined ? roomIdOverride : (currentChatRoomId || null),
    sender_share_key: shareKeyOverride || getOrCreateShareKey(),
  });
  if (error) throw error;
}

// Pulls the first pasted image (if any) out of a clipboard paste event —
// shared by Global Chat, DM/group popups, and anywhere else that wants
// Ctrl+V-to-attach instead of only a file-picker button.
function wdsGetPastedImageFile(e) {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) return item.getAsFile();
  }
  return null;
}

// Phone camera photos routinely come in at 3000px+ on a side — uploading
// that verbatim is a lot of bandwidth/storage for something only ever
// viewed on a phone screen. Downscales to WDS_MAX_UPLOAD_DIM and
// re-encodes as JPEG; images already at or under the cap (e.g. the My Day
// composer's own 720x1280 flattened canvas) resolve to null and pass
// through untouched in uploadChatImage below — re-encoding those as JPEG
// would visibly degrade their text/pill edges for no size benefit.
const WDS_MAX_UPLOAD_DIM = 1280;
function wdsDownscaleImageForUpload(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      if (Math.max(width, height) <= WDS_MAX_UPLOAD_DIM) { resolve(null); return; }
      const scale = WDS_MAX_UPLOAD_DIM / Math.max(width, height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.82);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Single shared upload path for every image in the app — feed posts, My
// Day stories, and chat (mobile Nexus tab and desktop chat/popups alike).
async function uploadChatImage(dataUrl, shareKeyOverride) {
  let blob = await (await fetch(dataUrl)).blob();
  if (blob.type !== 'image/gif') { // skip animated GIFs — canvas would flatten to one frame
    const resized = await wdsDownscaleImageForUpload(dataUrl);
    if (resized) blob = resized;
  }
  const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
  const path = `${shareKeyOverride || getOrCreateShareKey()}/${Date.now()}.${ext}`;
  const { error } = await sb.storage.from('chat-images').upload(path, blob, { contentType: blob.type });
  if (error) throw error;
  return sb.storage.from('chat-images').getPublicUrl(path).data.publicUrl;
}

function getOrCreateShareKey() {
  if (!localStorage.getItem('wft_lb_share_key')) localStorage.setItem('wft_lb_share_key', generateShareKey());
  return localStorage.getItem('wft_lb_share_key');
}

const ID_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids look-alike mistakes
function generatePublicId() {
  let code = '';
  for (let i = 0; i < 6; i++) code += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return `WF-${code}`;
}
function getOrCreatePublicId() {
  if (!localStorage.getItem('wft_public_id')) localStorage.setItem('wft_public_id', generatePublicId());
  return localStorage.getItem('wft_public_id');
}

/* ---------------------------------------------------------------- */
/* Web Dashboard Sync — Settings > Web Dashboard Sync                */
/* ---------------------------------------------------------------- */
// Uploads the FULL local history (see wdsRemoteData above for the read side
// on wellness.winfinityfitness.com) so a signed-in operator sees real data
// there instead of placeholders. Deliberately separate from the silent,
// automatic leaderboard sync (autoSyncLeaderboardIfOptedIn) — this uploads
// far more, and more sensitive, data, so it only ever runs when the user
// explicitly enables it and taps Sync Now.
function dateMapToEntries(map) {
  return Object.keys(map || {}).map(date => ({ date, data: map[date] }));
}

// p_old_pin only required server-side when a PIN is already set (first-
// time setup doesn't need one, since there's nothing to prove yet).
async function enableWebSync(pin, oldPin) {
  if (!sbConfigured()) throw new Error('Not connected.');
  await sb.rpc('web_sync_set_pin', {
    p_share_key: getOrCreateShareKey(),
    p_public_id: getOrCreatePublicId(),
    p_pin: pin,
    p_old_pin: oldPin || null,
  }).then(({ error }) => { if (error) throw error; });
}

async function disableWebSync() {
  if (!sbConfigured()) throw new Error('Not connected.');
  await sb.rpc('web_sync_disable', { p_share_key: getOrCreateShareKey() })
    .then(({ error }) => { if (error) throw error; });
}

// Explicit-tap-only (see initWebSyncSettings) — pushes the current local
// snapshot in full each time rather than tracking deltas; upserts are
// idempotent and one person's fitness history is small enough (hundreds to
// a few thousand day-rows a year) that re-sending everything is simpler and
// safe. Best-effort per call, same pattern as pushLeaderboardEntry, so one
// failing piece doesn't block the others.
// Desktop-shell counterpart to pushWebSyncSnapshot() above — that function
// reads getOrCreateShareKey()/getProfile()/localStorage theme, all
// mobile-context assumptions that don't hold inside the wellness dashboard
// (wdsRemoteData is the source of truth there, not this browser's own
// localStorage). Used by profile-editing controls on the desktop Profile
// Page (cover photo, etc.) to persist a profile change back to Supabase.
async function wdsPushProfileUpdate(profile) {
  if (!wdsRemoteData || !sbConfigured()) throw new Error('Not connected.');
  const { error } = await sb.rpc('web_sync_push_snapshot', {
    p_share_key: wdsRemoteData.shareKey,
    p_profile: profile,
    p_theme: wdsRemoteData.theme,
    p_skin: wdsRemoteData.skin,
  });
  if (error) throw error;
}

async function pushWebSyncSnapshot() {
  if (!sbConfigured()) throw new Error('Not connected.');
  const shareKey = getOrCreateShareKey();
  try {
    await sb.rpc('web_sync_push_snapshot', {
      p_share_key: shareKey,
      p_profile: getProfile(),
      p_theme: localStorage.getItem('wft_theme') || 'dark',
      p_skin: localStorage.getItem('wft_skin') || 'default',
    });
  } catch (e) { /* best effort — profile/theme just won't update until next successful sync */ }
  try {
    await sb.rpc('web_sync_push_logs', { p_share_key: shareKey, p_entries: dateMapToEntries(getLogs()) });
  } catch (e) { /* best effort */ }
  try {
    await sb.rpc('web_sync_push_reviews', { p_share_key: shareKey, p_entries: dateMapToEntries(getReviews()) });
  } catch (e) { /* best effort */ }
  try {
    await sb.rpc('web_sync_push_daily_reviews', { p_share_key: shareKey, p_entries: dateMapToEntries(getDailyReviews()) });
  } catch (e) { /* best effort */ }
  localStorage.setItem('wft_web_sync_last_at', String(Date.now()));
}

function initWebSyncSettings() {
  const toggle = document.getElementById('webSyncEnabled');
  const fields = document.getElementById('webSyncFields');
  const oldPinField = document.getElementById('webSyncOldPinField');
  const oldPinInput = document.getElementById('webSyncOldPinInput');
  const pinInput = document.getElementById('webSyncPinInput');
  const setPinBtn = document.getElementById('btnWebSyncSetPin');
  const syncNowBtn = document.getElementById('btnWebSyncNow');
  const statusEl = document.getElementById('webSyncStatus');
  if (!toggle || !fields) return;

  const renderStatus = () => {
    const lastAt = localStorage.getItem('wft_web_sync_last_at');
    statusEl.textContent = lastAt
      ? `Last synced ${new Date(Number(lastAt)).toLocaleString()}`
      : 'Not synced yet.';
  };
  // A PIN's already been set once sync has ever been enabled — changing
  // it from here on now requires proving the current one server-side.
  const refreshOldPinVisibility = () => {
    if (oldPinField) oldPinField.hidden = localStorage.getItem('wft_web_sync_enabled') !== '1';
  };

  const enabled = localStorage.getItem('wft_web_sync_enabled') === '1';
  toggle.checked = enabled;
  fields.hidden = !enabled;
  refreshOldPinVisibility();
  renderStatus();

  toggle.addEventListener('change', async () => {
    if (toggle.checked) {
      fields.hidden = false;
      refreshOldPinVisibility();
      pinInput.focus();
    } else {
      toggle.checked = true; // stays checked until a PIN is actually set/disabled below
      fields.hidden = false;
      refreshOldPinVisibility();
    }
  });

  setPinBtn.addEventListener('click', async () => {
    const pin = pinInput.value.trim();
    const oldPin = oldPinInput ? oldPinInput.value.trim() : '';
    if (pin.length < 6) { showRestToast('PIN must be at least 6 characters.'); return; }
    if (oldPinField && !oldPinField.hidden && oldPin.length < 6) { showRestToast('Enter your current PIN to change it.'); return; }
    try {
      await enableWebSync(pin, oldPin);
      localStorage.setItem('wft_web_sync_enabled', '1');
      pinInput.value = '';
      if (oldPinInput) oldPinInput.value = '';
      refreshOldPinVisibility();
      showRestToast('Web sync enabled — tap Sync Now to upload your data.');
    } catch (e) { showRestToast('Could not set PIN — try again.'); }
  });

  syncNowBtn.addEventListener('click', async () => {
    if (localStorage.getItem('wft_web_sync_enabled') !== '1') {
      showRestToast('Set a PIN first to enable web sync.');
      return;
    }
    syncNowBtn.disabled = true;
    try {
      await pushWebSyncSnapshot();
      renderStatus();
      showRestToast('Synced to Web Dashboard.');
    } catch (e) {
      showRestToast('Sync failed — check your connection and try again.');
    } finally {
      syncNowBtn.disabled = false;
    }
  });

  const disableBtn = document.getElementById('btnWebSyncDisable');
  if (disableBtn) {
    disableBtn.addEventListener('click', async () => {
      try {
        await disableWebSync();
        localStorage.setItem('wft_web_sync_enabled', '0');
        toggle.checked = false;
        fields.hidden = true;
        showRestToast('Web sync disabled — your Digital ID can no longer sign in on the web until you set a new PIN.');
      } catch (e) { showRestToast('Could not disable web sync — try again.'); }
    });
  }
}

// Wires a "tap card to reveal an explainer hint" interaction — used by the
// Digital ID chip and the Adjusted BMI tile so their descriptions stay out
// of the way until the user actually wants to read them.
function initClickToRevealHint(cardId, hintId) {
  const card = document.getElementById(cardId);
  const hint = document.getElementById(hintId);
  const toggleHint = () => {
    const expanded = hint.hidden;
    hint.hidden = !expanded;
    card.setAttribute('aria-expanded', String(expanded));
  };
  card.addEventListener('click', toggleHint);
  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHint(); }
  });
}

function initReviewToggles() {
  initClickToRevealHint('btnToggleDailyReview', 'dailyReviewPanel');
  initClickToRevealHint('btnToggleWeeklyReview', 'weeklyReviewPanel');
}

function initHistoryLogsToggle() {
  initClickToRevealHint('btnToggleHistoryLogs', 'historyLogsPanel');
}

function initDigitalId() {
  document.getElementById('digitalIdValue').textContent = getOrCreatePublicId();
  document.getElementById('btnCopyDigitalId').addEventListener('click', async function (e) {
    e.stopPropagation();
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(getOrCreatePublicId());
      this.classList.add('is-copied');
      showRestToast('Digital ID copied!');
      setTimeout(() => this.classList.remove('is-copied'), 1500);
    } catch (e) { /* ignore */ }
  });
  initClickToRevealHint('digitalIdCard', 'digitalIdHint');
}

const DIGITAL_ID_PATTERN = /^WF-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

// Admin-only tool: reassigns a Digital ID from one user's account to
// another label server-side, replacing whatever was already at the target
// ID. Ordinary self-service reclaim now happens automatically via backup
// restore (see getBackupPayload/fileRestore) instead of this tool.
function refreshDigitalIdOverrideVisibility() {
  const loggedIn = isAdminLoggedIn();
  const section = document.getElementById('digitalIdOverrideSection');
  if (section) section.hidden = !loggedIn;
  const adFreeSection = document.getElementById('adFreeOverrideSection');
  if (adFreeSection) adFreeSection.hidden = !loggedIn;
  const adManagerSection = document.getElementById('adManagerSection');
  if (adManagerSection) {
    adManagerSection.hidden = !loggedIn;
    if (loggedIn) renderAdManagerProducts();
  }
  const splashLogoManagerSection = document.getElementById('splashLogoManagerSection');
  if (splashLogoManagerSection) {
    splashLogoManagerSection.hidden = !loggedIn;
    if (loggedIn) renderSplashLogoManager();
  }
  const syncLogsSection = document.getElementById('syncLogsSection');
  if (syncLogsSection) {
    syncLogsSection.hidden = !loggedIn;
    if (loggedIn) renderSyncLogs();
  }
  const prepMealManagerSection = document.getElementById('prepMealManagerSection');
  if (prepMealManagerSection) {
    prepMealManagerSection.hidden = !loggedIn;
    if (loggedIn) renderPrepMealManager();
  }
  renderMediaSyncWidget();
  refreshOpenFoodPrepsScreen();
  const updatesRow = document.getElementById('updatesEnabledRow');
  if (updatesRow) updatesRow.hidden = !loggedIn;
  const updatesHint = document.getElementById('updatesEnabledHint');
  if (updatesHint) updatesHint.hidden = !loggedIn;
  // The drawer tab itself is visible to every user now — only the
  // admin-specific icons inside it (marked data-admin-only in the HTML)
  // are gated here. Quick Log icons (data-quicklog-key) are unrelated to
  // login state — see loadQuickLogDialConfig/applyQuickLogDialConfig.
  document.querySelectorAll('.admin-drawer-pill-item[data-admin-only]').forEach(el => { el.hidden = !loggedIn; });
  if (!loggedIn) closeAdminDrawerAll();
}

/* ---------------------------------------------------------------- */
/* Admin Command Center — small drag/tap tab on the screen edge that   */
/* only appears while logged in as admin (see refreshDigitalIdOverrideVisibility */
/* above). Two levels: tapping/dragging the tab opens a floating icon    */
/* pill (one icon per admin feature); tapping a pill icon either fires   */
/* that action directly or opens the slide-out panel focused on just     */
/* that one section, with the panel's back arrow returning to the pill.  */
/* ---------------------------------------------------------------- */
// Plain flags, not the [hidden] attribute or the .is-open class — both of
// those are intentionally *deferred* relative to the moment open/close is
// requested (hidden flips ~220-280ms late so the close fade can play; the
// class is added a frame late via rAF so the open fade has a "before" state
// to transition from), so checking either one right after calling
// open/close reads a stale value. These flags flip synchronously with the
// call itself, so isAdminDrawerAnythingOpen() is always accurate — and the
// early-return guards below make a second close call on an already-closing
// element a true no-op (it won't re-trigger syncAdminDrawerBackdrop and
// wrongly re-show a backdrop that's mid-fade-out, which previously left a
// full-screen, pointer-events-blocking backdrop stuck open forever, e.g.
// after Log Out closes the pill twice — directly, then again via
// refreshDigitalIdOverrideVisibility's closeAdminDrawerAll()).
let adminDrawerPillOpen = false;
let adminDrawerPanelOpen = false;
// Set right before forwarding a Broadcast & Sync Tools tap (Post
// Announcement / Assign Targets / Media Sync) to its overlay — lets
// initAdminDrawerReopenOnOverlayClose tell "closed an overlay the drawer
// just launched" apart from e.g. Media Sync Calibration's other, unrelated
// entry point on the Nutrition tab widget, which shouldn't pop the dial
// back open on close.
let adminDrawerLaunchedOverlay = false;
function isAdminDrawerAnythingOpen() {
  return adminDrawerPillOpen || adminDrawerPanelOpen;
}
let adminDrawerBackdropHideTimer = null;
function syncAdminDrawerBackdrop() {
  const backdrop = document.getElementById('adminDrawerBackdrop');
  if (!backdrop) return;
  if (adminDrawerBackdropHideTimer) { clearTimeout(adminDrawerBackdropHideTimer); adminDrawerBackdropHideTimer = null; }
  if (isAdminDrawerAnythingOpen()) {
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add('is-open'));
  } else {
    backdrop.classList.remove('is-open');
    adminDrawerBackdropHideTimer = setTimeout(() => {
      if (!isAdminDrawerAnythingOpen()) backdrop.hidden = true;
      adminDrawerBackdropHideTimer = null;
    }, 280);
  }
}

// Icon diameter matches .admin-drawer-pill-item's width/height in
// style.css. Target arc-length spacing between icon CENTERS is one full
// icon-width of empty gap between edges, i.e. two icon-diameters — "an
// icon space apart." Radius is then derived FROM that spacing and the
// current icon count (circumference = n * spacing), not the other way
// around, so the arc naturally "expands" as icons are added later (e.g.
// via Drawer Settings) while the spacing itself stays constant. Floored at
// a minimum so it doesn't look cramped with only a handful of icons.
const ADMIN_ARC_ICON_DIAMETER = 36;
const ADMIN_ARC_ICON_SPACING = ADMIN_ARC_ICON_DIAMETER * 2;
const ADMIN_ARC_MIN_RADIUS = 90;
let adminDrawerArcRadius = ADMIN_ARC_MIN_RADIUS; // updated every layout, read by the drag handler
let adminDrawerArcRotation = 0;

function computeAdminArcRadius(n) {
  return Math.max(ADMIN_ARC_MIN_RADIUS, (n * ADMIN_ARC_ICON_SPACING) / (2 * Math.PI));
}

function normalizeAngle180(deg) {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

// Positions each icon along a virtual full circle based on
// adminDrawerArcRotation (only the semicircle nearest the tab, angle
// within ~100° of "pointing left," is ever visible) and marks only the one
// nearest the front (angle ~0, i.e. "most left") as .is-focused — grown,
// the only one with pointer-events enabled (so a hidden icon has to be
// rotated to the front before it's tappable), and named in the small
// label that follows it around the arc.
// Anchors the pill's own container to wherever the edge tab currently sits
// (it can be dragged anywhere now — see applyAdminTabPosition) and flips
// which side it opens toward: right-docked tabs fan the arc leftward (as
// before), left-docked tabs mirror everything so it fans rightward instead
// and never opens off the edge of the screen.
function positionAdminDrawerPill(tab, pill) {
  const rect = tab.getBoundingClientRect();
  const isLeft = tab.classList.contains('admin-drawer-tab--left');
  pill.style.top = `${rect.top + rect.height / 2}px`;
  pill.classList.toggle('admin-drawer-pill--left', isLeft);
}

function layoutAdminDrawerArc() {
  const pill = document.getElementById('adminDrawerPill');
  if (!pill) return;
  const items = Array.from(pill.querySelectorAll('.admin-drawer-pill-item:not([hidden])'));
  const n = items.length;
  if (!n) return;
  const radius = computeAdminArcRadius(n);
  adminDrawerArcRadius = radius;
  pill.style.width = pill.style.height = `${(radius * 2).toFixed(1)}px`;
  const isLeft = pill.classList.contains('admin-drawer-pill--left');
  if (isLeft) { pill.style.left = `${(-radius).toFixed(1)}px`; pill.style.right = 'auto'; }
  else { pill.style.right = `${(-radius).toFixed(1)}px`; pill.style.left = 'auto'; }
  const mirror = isLeft ? 1 : -1;

  const state = items.map((el, i) => {
    const home = (360 / n) * i;
    const phi = normalizeAngle180(home + adminDrawerArcRotation);
    return { el, phi, abs: Math.abs(phi) };
  });
  let focusedIdx = 0, minAbs = Infinity;
  state.forEach((s, i) => { if (s.abs < minAbs) { minAbs = s.abs; focusedIdx = i; } });

  const label = document.getElementById('adminDrawerArcLabel');
  state.forEach((s, i) => {
    const rad = s.phi * Math.PI / 180;
    const x = mirror * radius * Math.cos(rad);
    const y = radius * Math.sin(rad);
    const isFocused = i === focusedIdx;
    s.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${isFocused ? 1.3 : 1})`;
    let opacity;
    if (s.abs <= 80) opacity = 1;
    else if (s.abs <= 100) opacity = 1 - (s.abs - 80) / 20;
    else opacity = 0;
    s.el.style.opacity = opacity;
    s.el.style.pointerEvents = isFocused ? 'auto' : 'none';
    s.el.classList.toggle('is-focused', isFocused);
    if (isFocused && label) {
      label.textContent = s.el.title || s.el.getAttribute('aria-label') || '';
      const labelX = isLeft ? x + 16 : x - 16;
      label.style.transform = `translate(${labelX.toFixed(1)}px, ${y.toFixed(1)}px) translate(${isLeft ? '0%' : '-100%'}, -50%)`;
    }
  });
}

function openAdminDrawerPill() {
  const pill = document.getElementById('adminDrawerPill');
  const tab = document.getElementById('adminDrawerTab');
  if (!pill) return;
  adminDrawerPillOpen = true;
  adminDrawerArcRotation = 0;
  if (tab) positionAdminDrawerPill(tab, pill);
  layoutAdminDrawerArc();
  pill.hidden = false;
  requestAnimationFrame(() => pill.classList.add('is-open'));
  syncAdminDrawerBackdrop();
}
function closeAdminDrawerPill() {
  const pill = document.getElementById('adminDrawerPill');
  if (!pill || !adminDrawerPillOpen) return;
  adminDrawerPillOpen = false;
  pill.classList.remove('is-open');
  setTimeout(() => { pill.hidden = true; }, 220);
  syncAdminDrawerBackdrop();
}
function toggleAdminDrawerPill() {
  if (adminDrawerPillOpen) closeAdminDrawerPill(); else openAdminDrawerPill();
}

function openAdminDrawer() {
  const drawer = document.getElementById('adminDrawer');
  if (!drawer) return;
  adminDrawerPanelOpen = true;
  drawer.hidden = false;
  requestAnimationFrame(() => drawer.classList.add('is-open'));
  syncAdminDrawerBackdrop();
}
function closeAdminDrawer() {
  const drawer = document.getElementById('adminDrawer');
  if (!drawer || !adminDrawerPanelOpen) return;
  adminDrawerPanelOpen = false;
  drawer.classList.remove('is-open');
  setTimeout(() => { drawer.hidden = true; }, 280);
  syncAdminDrawerBackdrop();
}
function closeAdminDrawerAll() {
  closeAdminDrawerPill();
  closeAdminDrawer();
}
// Hides every other admin-drawer-section so only the tapped feature (or
// group of features, e.g. Account Admin bundles three together) shows,
// layered on top of (not replacing) each section's own admin-login-gated
// [hidden] — see refreshDigitalIdOverrideVisibility above.
function openAdminDrawerSection(sectionIds) {
  const ids = Array.isArray(sectionIds) ? sectionIds : [sectionIds];
  document.querySelectorAll('.admin-drawer-section').forEach(el => {
    el.classList.toggle('is-not-focused', !ids.includes(el.id));
  });
  if (ids.includes('adminBroadcastToolsSection')) renderQuickLogDialSettings();
  closeAdminDrawerPill();
  openAdminDrawer();
}
// Skips the fade — Post Announcement/Assign Targets/Media Sync each open
// their own full sheet-overlay immediately on top, and that overlay's
// z-index sits below the drawer's, so animating the drawer/pill/backdrop
// closed in parallel let them visually sit on top of (or dim) the overlay
// for the transition's duration, reading as "nothing happened."
function closeAdminDrawerInstant() {
  const pill = document.getElementById('adminDrawerPill');
  const drawer = document.getElementById('adminDrawer');
  const backdrop = document.getElementById('adminDrawerBackdrop');
  adminDrawerPillOpen = false;
  adminDrawerPanelOpen = false;
  if (adminDrawerBackdropHideTimer) { clearTimeout(adminDrawerBackdropHideTimer); adminDrawerBackdropHideTimer = null; }
  if (pill) { pill.classList.remove('is-open'); pill.hidden = true; }
  if (drawer) { drawer.classList.remove('is-open'); drawer.hidden = true; }
  if (backdrop) { backdrop.classList.remove('is-open'); backdrop.hidden = true; }
}

// Press-and-hold-2s-then-drag repositioning for the edge tab — see the
// pointer handlers in initAdminDrawer. Position is stored as a fraction of
// viewport height (not raw px) so it stays sensible across orientation
// changes and different screen sizes, and re-clamped on load/resize against
// whatever the header/tab-bar heights actually are right now rather than a
// hardcoded guess.
const ADMIN_TAB_POS_KEY = 'wft_admin_tab_pos';
function loadAdminTabPosition() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ADMIN_TAB_POS_KEY));
    if (!parsed || typeof parsed.yFrac !== 'number' || (parsed.edge !== 'left' && parsed.edge !== 'right')) return null;
    return parsed;
  } catch (e) { return null; }
}
function saveAdminTabPosition(edge, yFrac) {
  localStorage.setItem(ADMIN_TAB_POS_KEY, JSON.stringify({ edge, yFrac }));
}
// Keeps the tab from ever landing on top of the sticky header or the
// floating bottom tab bar — measured live via getBoundingClientRect rather
// than a fixed number since both heights vary by skin/content/safe-area.
function adminTabYBounds() {
  const header = document.querySelector('.app-header');
  const tabBarEl = document.querySelector('.tab-bar');
  const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
  const tabBarTop = tabBarEl ? tabBarEl.getBoundingClientRect().top : window.innerHeight;
  const minY = headerBottom + 24;
  const maxY = tabBarTop - 24;
  if (maxY <= minY) return { minY: window.innerHeight / 2, maxY: window.innerHeight / 2 };
  return { minY, maxY };
}
function applyAdminTabPosition(tab) {
  const pos = loadAdminTabPosition();
  const edge = pos ? pos.edge : 'right';
  const { minY, maxY } = adminTabYBounds();
  const y = Math.min(maxY, Math.max(minY, (pos ? pos.yFrac : 0.5) * window.innerHeight));
  tab.style.top = y + 'px';
  tab.style.right = edge === 'right' ? '0' : 'auto';
  tab.style.left = edge === 'left' ? '0' : 'auto';
  tab.classList.toggle('admin-drawer-tab--left', edge === 'left');
}

function initAdminDrawer() {
  const tab = document.getElementById('adminDrawerTab');
  const pill = document.getElementById('adminDrawerPill');
  const drawer = document.getElementById('adminDrawer');
  const backdrop = document.getElementById('adminDrawerBackdrop');
  const closeBtn = document.getElementById('btnCloseAdminDrawer');
  const mediaSyncBtn = document.getElementById('btnDrawerOpenMediaSync');
  const broadcastSection = document.getElementById('adminBroadcastToolsSection');
  if (!tab || !pill || !drawer) return;

  // Back arrow drills back up to the pill rather than closing everything,
  // so checking several features in a row doesn't need a re-drag/re-tap
  // of the edge tab each time.
  closeBtn.addEventListener('click', () => { closeAdminDrawer(); openAdminDrawerPill(); });
  backdrop.addEventListener('click', closeAdminDrawerAll);

  // A short drag (or a plain tap) on the edge tab opens the pill — both
  // just measure the gesture on release and hand off to the same
  // CSS-transition-driven open, rather than tracking the finger live, so
  // there's one animation path instead of two to keep in sync.
  //
  // Holding still for 2s instead turns the same pointer session into a
  // free reposition drag (see is-repositioning in style.css): any real
  // movement before the 2s mark cancels the hold and falls through to the
  // short-drag/tap behavior above untouched, so the two gestures can't be
  // confused for each other. Only the Y position tracks the finger
  // directly — X always snaps to whichever screen edge the pointer is
  // nearer, and Y is clamped (adminTabYBounds) so it can never land on top
  // of the header or the bottom tab bar.
  applyAdminTabPosition(tab);
  window.addEventListener('resize', () => applyAdminTabPosition(tab));

  const LONG_PRESS_MS = 2000;
  const MOVE_CANCEL_PX = 8;
  let gestureStartX = null;
  let gestureStartY = null;
  let holdTimer = null;
  let repositioning = false;
  let grabOffsetY = 0;
  const clearHoldTimer = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

  tab.addEventListener('pointerdown', e => {
    gestureStartX = e.clientX;
    gestureStartY = e.clientY;
    repositioning = false;
    const rect = tab.getBoundingClientRect();
    grabOffsetY = e.clientY - (rect.top + rect.height / 2);
    tab.setPointerCapture(e.pointerId);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      repositioning = true;
      tab.classList.add('is-repositioning');
      if (navigator.vibrate) navigator.vibrate(30);
    }, LONG_PRESS_MS);
  });

  tab.addEventListener('pointermove', e => {
    if (repositioning) {
      const { minY, maxY } = adminTabYBounds();
      const y = Math.min(maxY, Math.max(minY, e.clientY - grabOffsetY));
      tab.style.top = y + 'px';
      const edge = e.clientX < window.innerWidth / 2 ? 'left' : 'right';
      tab.style.right = edge === 'right' ? '0' : 'auto';
      tab.style.left = edge === 'left' ? '0' : 'auto';
      tab.classList.toggle('admin-drawer-tab--left', edge === 'left');
      return;
    }
    if (holdTimer && (Math.abs(e.clientX - gestureStartX) > MOVE_CANCEL_PX || Math.abs(e.clientY - gestureStartY) > MOVE_CANCEL_PX)) {
      clearHoldTimer();
    }
  });

  tab.addEventListener('pointerup', e => {
    clearHoldTimer();
    if (repositioning) {
      repositioning = false;
      tab.classList.remove('is-repositioning');
      const edge = tab.classList.contains('admin-drawer-tab--left') ? 'left' : 'right';
      const rect = tab.getBoundingClientRect();
      saveAdminTabPosition(edge, (rect.top + rect.height / 2) / window.innerHeight);
      gestureStartX = null;
      return;
    }
    if (gestureStartX === null) return;
    const dx = gestureStartX - e.clientX; // positive = dragged left, toward open
    gestureStartX = null;
    if (dx > 12) openAdminDrawerPill(); else toggleAdminDrawerPill();
  });

  tab.addEventListener('pointercancel', () => {
    clearHoldTimer();
    repositioning = false;
    tab.classList.remove('is-repositioning');
    gestureStartX = null;
  });

  if (mediaSyncBtn) mediaSyncBtn.addEventListener('click', openMediaSyncCalibration);

  // Post Announcement / Assign Targets / Media Sync each open their own
  // overlay on top — close the drawer instantly (see closeAdminDrawerInstant)
  // rather than letting it fade out in parallel and obscure that overlay.
  // adminDrawerLaunchedOverlay marks this as "the drawer opened it," so
  // initAdminDrawerReopenOnOverlayClose brings the dial back once it's
  // closed instead of leaving everything closed and needing a re-tap of
  // the edge tab.
  if (broadcastSection) {
    broadcastSection.addEventListener('click', e => {
      if (e.target.closest('button')) {
        adminDrawerLaunchedOverlay = true;
        closeAdminDrawerInstant();
      }
    });
  }

  // Drag up/down anywhere on the arc (including through a dimmed icon,
  // since only the focused one has pointer-events enabled — see
  // layoutAdminDrawerArc) spins it like a dial. A completed drag suppresses
  // the click that would otherwise fire on release, so spinning past the
  // focused icon's position doesn't also select it.
  let arcDragging = false;
  let arcDragStartY = 0;
  let arcDragStartRotation = 0;
  let arcJustDragged = false;
  pill.addEventListener('pointerdown', e => {
    arcDragging = true;
    arcDragStartY = e.clientY;
    arcDragStartRotation = adminDrawerArcRotation;
    arcJustDragged = false;
    pill.setPointerCapture(e.pointerId);
  });
  pill.addEventListener('pointermove', e => {
    if (!arcDragging) return;
    const dy = e.clientY - arcDragStartY;
    if (Math.abs(dy) > 6) arcJustDragged = true;
    adminDrawerArcRotation = arcDragStartRotation + (dy / adminDrawerArcRadius) * (180 / Math.PI);
    layoutAdminDrawerArc();
  });
  const endArcDrag = () => { arcDragging = false; };
  pill.addEventListener('pointerup', endArcDrag);
  pill.addEventListener('pointercancel', endArcDrag);

  pill.addEventListener('click', e => {
    if (arcJustDragged) { arcJustDragged = false; return; }
    const btn = e.target.closest('.admin-drawer-pill-item');
    if (!btn) return;
    if (btn.dataset.target) { openAdminDrawerSection(btn.dataset.target.split(',')); return; }
    if (btn.dataset.action) {
      closeAdminDrawerPill();
      const target = document.getElementById(btn.dataset.action);
      if (target) target.click();
    }
  });

  // Post Announcement / Assign Targets / Media Sync were closed after the
  // drawer opened them (adminDrawerLaunchedOverlay) — bring the dial back
  // instead of leaving everything closed and needing a re-tap of the edge
  // tab. Same MutationObserver technique as initBackButtonNav, so this
  // catches every way the overlay can close (X button, backdrop tap, a
  // successful submit's own auto-close) without hooking each one directly.
  const reopenObserver = new MutationObserver(mutations => {
    mutations.forEach(m => {
      const el = m.target;
      if (el.hidden && adminDrawerLaunchedOverlay && isAdminLoggedIn()) {
        adminDrawerLaunchedOverlay = false;
        openAdminDrawerPill();
      }
    });
  });
  ['adminPostOverlay', 'adminAssignTargetsOverlay', 'mediaSyncCalibrationOverlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) reopenObserver.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });

  initQuickLogDialSettings();
  loadQuickLogDialConfig();
}

// The six Quick Log shortcuts (see initQuickLogLaunchers/initTrainingLogQuickPopup/
// initFuelLogQuickPopup/initCommunityQuickPopup) that CAN appear as dial
// icons for every user — which ones actually do is a single admin-set list
// shared by everyone (Drawer Settings), not per-user. Local default matches
// the DB column's default so the dial is useful even before the first fetch
// resolves (or fully offline).
const QUICK_LOG_DIAL_KEYS = ['startDayLog', 'endDayLog', 'weekendLog', 'trainingLog', 'fuelLog', 'communityLog'];
let quickLogDialConfig = QUICK_LOG_DIAL_KEYS.slice();

function applyQuickLogDialConfig() {
  document.querySelectorAll('.admin-drawer-pill-item[data-quicklog-key]').forEach(el => {
    el.hidden = !quickLogDialConfig.includes(el.dataset.quicklogKey);
  });
}

async function loadQuickLogDialConfig() {
  if (!sbConfigured()) { applyQuickLogDialConfig(); return; }
  try {
    const { data } = await sb.from('ad_settings').select('quick_log_dial_buttons').eq('id', 1).maybeSingle();
    if (data && Array.isArray(data.quick_log_dial_buttons)) quickLogDialConfig = data.quick_log_dial_buttons;
  } catch (e) { /* offline/unreachable — keep the local default */ }
  applyQuickLogDialConfig();
}

// Re-synced every time Drawer Settings opens (see openAdminDrawerSection)
// so the checkboxes always reflect the last-saved state, including if
// another admin session changed it since this one loaded.
function renderQuickLogDialSettings() {
  document.querySelectorAll('#adminBroadcastToolsSection input[data-quicklog-key]').forEach(input => {
    input.checked = quickLogDialConfig.includes(input.dataset.quicklogKey);
  });
}

function initQuickLogDialSettings() {
  const inputs = Array.from(document.querySelectorAll('#adminBroadcastToolsSection input[data-quicklog-key]'));
  const note = document.getElementById('quickLogDialNote');
  inputs.forEach(input => {
    input.addEventListener('change', async () => {
      if (!isAdminLoggedIn()) { input.checked = !input.checked; return; }
      const newConfig = inputs.filter(i => i.checked).map(i => i.dataset.quicklogKey);
      try {
        const { error } = await sb.rpc('admin_set_quick_log_dial_buttons', {
          p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_buttons: newConfig,
        });
        if (error) throw error;
        quickLogDialConfig = newConfig;
        applyQuickLogDialConfig();
        if (note) { note.textContent = 'Saved.'; setTimeout(() => { note.textContent = ''; }, 1500); }
      } catch (e) {
        input.checked = !input.checked;
        if (note) note.textContent = 'Failed to save — try again.';
      }
    });
  });
}

function initDigitalIdOverride() {
  const fromInput = document.getElementById('digitalIdOverrideFromInput');
  const toInput = document.getElementById('digitalIdOverrideInput');
  const btn = document.getElementById('btnSetDigitalId');
  const note = document.getElementById('digitalIdOverrideNote');
  if (!fromInput || !toInput || !btn) return;
  refreshDigitalIdOverrideVisibility();
  btn.addEventListener('click', async () => {
    if (!isAdminLoggedIn()) { note.textContent = 'Admin login required.'; return; }
    const fromId = fromInput.value.trim().toUpperCase();
    const toId = toInput.value.trim().toUpperCase();
    if (!DIGITAL_ID_PATTERN.test(fromId) || !DIGITAL_ID_PATTERN.test(toId)) {
      note.textContent = 'Both IDs must match the format WF-XXXXXX (6 letters/numbers, no 0, O, 1, or I).';
      return;
    }
    if (fromId === toId) { note.textContent = 'User Digital ID and New Digital ID must be different.'; return; }
    if (!sbConfigured()) { note.textContent = 'Not available offline.'; return; }
    if (!confirm(`Move all of ${fromId}'s data to ${toId}? This fully replaces whatever currently exists at ${toId}. This cannot be undone.`)) return;
    btn.disabled = true;
    note.textContent = 'Transferring…';
    try {
      const { error } = await sb.rpc('admin_transfer_digital_id', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password,
        p_old_public_id: fromId, p_new_public_id: toId,
      });
      if (error) throw error;
      note.textContent = `Transferred. ${fromId} is now ${toId}.`;
      fromInput.value = '';
      toInput.value = '';
    } catch (e) {
      note.textContent = 'Transfer failed: ' + (e.message || 'no user found with that Digital ID, or you\'re offline.');
    }
    btn.disabled = false;
  });
}

// Admin-only: grants/revokes a per-Digital-ID ad-free window. There's no
// automatic way to confirm a GCash donation actually came in (no payment
// webhook exists), so the admin manually verifies it, then grants a
// time-limited window here — it expires on its own, nothing to remember to
// revoke.
function initAdFreeOverride() {
  const idInput = document.getElementById('adFreeDigitalIdInput');
  const hoursInput = document.getElementById('adFreeHoursInput');
  const note = document.getElementById('adFreeNote');
  const grantBtn = document.getElementById('btnGrantAdFree');
  const revokeBtn = document.getElementById('btnRevokeAdFree');
  if (!idInput || !grantBtn || !revokeBtn) return;

  grantBtn.addEventListener('click', async () => {
    if (!isAdminLoggedIn()) { note.textContent = 'Admin login required.'; return; }
    const targetId = idInput.value.trim().toUpperCase();
    const hours = parseInt(hoursInput.value, 10) || 24;
    if (!DIGITAL_ID_PATTERN.test(targetId)) { note.textContent = 'Must match the format WF-XXXXXX.'; return; }
    if (!sbConfigured()) { note.textContent = 'Not available offline.'; return; }
    grantBtn.disabled = true;
    note.textContent = 'Granting…';
    try {
      const { error } = await sb.rpc('admin_grant_ad_free', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password,
        p_target_public_id: targetId, p_hours: hours,
      });
      if (error) throw error;
      note.textContent = `${targetId} is ad-free for the next ${hours}h.`;
    } catch (e) {
      note.textContent = 'Failed: ' + (e.message || 'no user found with that Digital ID, or you\'re offline.');
    }
    grantBtn.disabled = false;
  });

  revokeBtn.addEventListener('click', async () => {
    if (!isAdminLoggedIn()) { note.textContent = 'Admin login required.'; return; }
    const targetId = idInput.value.trim().toUpperCase();
    if (!DIGITAL_ID_PATTERN.test(targetId)) { note.textContent = 'Must match the format WF-XXXXXX.'; return; }
    if (!sbConfigured()) { note.textContent = 'Not available offline.'; return; }
    revokeBtn.disabled = true;
    note.textContent = 'Revoking…';
    try {
      const { error } = await sb.rpc('admin_revoke_ad_free', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password,
        p_target_public_id: targetId,
      });
      if (error) throw error;
      note.textContent = `Ad-free access revoked for ${targetId}.`;
    } catch (e) {
      note.textContent = 'Failed: ' + (e.message || 'you\'re offline.');
    }
    revokeBtn.disabled = false;
  });
}

// Per-user ad-free check — only meaningful for accounts that have a
// leaderboard row at all (i.e. have synced to Nexus with sharing on at
// least once); a device that's never synced simply has no row to check, so
// this returns false for it and the global ad_settings switch is the only
// thing that applies.
async function isAdFreeUser() {
  if (!sbConfigured()) return false;
  const shareKey = localStorage.getItem('wft_lb_share_key');
  if (!shareKey) return false;
  try {
    const { data } = await sb.from('leaderboard').select('ad_free_until').eq('share_key', shareKey).maybeSingle();
    return !!(data && data.ad_free_until && new Date(data.ad_free_until) > new Date());
  } catch (e) { return false; }
}

const AD_SPLASH_COUNTDOWN_SEC = 10;

// Single-row app_settings-style table (named ad_settings historically, now
// also holds the updates kill switch) — fetched once and cached so the ad
// splash and the update-check gating below don't each pay their own
// network round trip.
let cachedAdSettingsPromise = null;
function fetchAdSettings() {
  if (!sbConfigured()) return Promise.resolve(null);
  if (!cachedAdSettingsPromise) {
    cachedAdSettingsPromise = sb.from('ad_settings').select('ads_enabled, updates_enabled').eq('id', 1).maybeSingle()
      .then(({ data }) => data)
      .catch(() => null);
  }
  return cachedAdSettingsPromise;
}

// Startup ad splash: global ads_enabled switch, then per-user ad-free grant,
// then picks a random active product from ad_products. Silently does
// nothing if any of those aren't available (offline, not configured, no
// products yet) — an ad that fails to load should never block app entry.
async function initAdSplash() {
  if (!sbConfigured()) return;
  try {
    const settings = await fetchAdSettings();
    if (!settings || !settings.ads_enabled) return;
    if (await isAdFreeUser()) return;

    const { data: products } = await sb.from('ad_products').select('*').eq('active', true);
    if (!products || !products.length) return;

    // Shows up to 8 at once in a 2x4 grid instead of one random pick —
    // shuffled so a small pool doesn't always lead with the same product
    // in the same top-left slot every time.
    const picks = products.slice().sort(() => Math.random() - 0.5).slice(0, 8);
    const overlay = document.getElementById('adSplashOverlay');
    document.getElementById('adSplashGrid').innerHTML = picks.map(p => `
      <a href="${escapeHtml(p.link_url)}" target="_blank" rel="noopener sponsored" class="ad-splash-grid-item">
        <img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}">
        <span class="ad-splash-grid-name">${escapeHtml(p.name)}</span>
      </a>
    `).join('');

    const closeBtn = document.getElementById('btnAdSplashClose');
    const countdownEl = document.getElementById('adSplashCountdown');
    closeBtn.disabled = true;
    closeBtn.classList.remove('is-ready');
    let remaining = AD_SPLASH_COUNTDOWN_SEC;
    countdownEl.textContent = remaining;
    overlay.hidden = false;

    const tick = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(tick);
        closeBtn.disabled = false;
        closeBtn.classList.add('is-ready');
      } else {
        countdownEl.textContent = remaining;
      }
    }, 1000);

    closeBtn.addEventListener('click', () => { overlay.hidden = true; }, { once: true });
  } catch (e) { /* best effort — never block app entry over a failed ad load */ }
}

// Admin-only widget on the Nexus tab: app-wide ads on/off switch plus the
// editable ad_products list that feeds initAdSplash() above.
async function renderAdManagerProducts() {
  if (!sbConfigured() || !isAdminLoggedIn()) return;
  const toggle = document.getElementById('adsEnabledToggle');
  const updatesToggle = document.getElementById('updatesEnabledToggle');
  const { data: settings } = await sb.from('ad_settings').select('ads_enabled, updates_enabled').eq('id', 1).maybeSingle();
  if (toggle) toggle.checked = !!(settings && settings.ads_enabled);
  if (updatesToggle) updatesToggle.checked = !settings || settings.updates_enabled !== false;

  const { data: products } = await sb.from('ad_products').select('*').order('created_at', { ascending: false });
  const list = document.getElementById('adManagerList');
  const empty = document.getElementById('adManagerEmptyNote');
  if (!list) return;
  list.innerHTML = '';
  if (!products || !products.length) { empty.hidden = false; return; }
  empty.hidden = true;

  products.forEach(p => {
    const row = document.createElement('div');
    row.className = 'ad-manager-row' + (p.active ? '' : ' ad-manager-inactive');
    row.innerHTML = `
      <img class="ad-manager-thumb" src="${escapeHtml(p.image_url)}" alt="">
      <div class="ad-manager-info">
        <div class="ad-manager-name">${escapeHtml(p.name)}${p.active ? '' : ' (inactive)'}</div>
        <span class="ad-manager-link">${escapeHtml(p.link_url)}</span>
      </div>
      <div class="ad-manager-actions">
        <button type="button" class="btn btn--sm" data-edit-ad="${p.id}">Edit</button>
        <button type="button" class="btn btn--danger btn--sm" data-delete-ad="${p.id}">Delete</button>
      </div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-edit-ad]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = products.find(x => String(x.id) === btn.dataset.editAd);
      if (!p) return;
      document.getElementById('adFormId').value = p.id;
      document.getElementById('adFormName').value = p.name;
      document.getElementById('adFormImage').value = p.image_url;
      document.getElementById('adFormLink').value = p.link_url;
      document.getElementById('adFormActive').checked = p.active;
      document.getElementById('btnCancelAdEdit').hidden = false;
    });
  });
  list.querySelectorAll('[data-delete-ad]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this ad product?')) return;
      try {
        await sb.rpc('admin_delete_ad_product', {
          p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_id: Number(btn.dataset.deleteAd),
        });
        renderAdManagerProducts();
      } catch (e) { showRestToast('Could not delete ad.'); }
    });
  });
}

function resetAdForm() {
  document.getElementById('adFormId').value = '';
  document.getElementById('adFormName').value = '';
  document.getElementById('adFormImage').value = '';
  document.getElementById('adFormLink').value = '';
  document.getElementById('adFormActive').checked = true;
  document.getElementById('btnCancelAdEdit').hidden = true;
}

function initAdManager() {
  const toggle = document.getElementById('adsEnabledToggle');
  if (!toggle) return;

  toggle.addEventListener('change', async () => {
    if (!isAdminLoggedIn()) { toggle.checked = !toggle.checked; return; }
    const desired = toggle.checked;
    try {
      const { error } = await sb.rpc('admin_set_ads_enabled', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_enabled: desired,
      });
      if (error) throw error;
      showRestToast(desired ? 'Ads enabled app-wide.' : 'Ads paused app-wide.');
    } catch (e) {
      toggle.checked = !desired;
      showRestToast('Could not update ad setting.');
    }
  });

  document.getElementById('btnCancelAdEdit').addEventListener('click', resetAdForm);

  document.getElementById('btnSaveAdProduct').addEventListener('click', async () => {
    const note = document.getElementById('adManagerNote');
    if (!isAdminLoggedIn()) { note.textContent = 'Admin login required.'; return; }
    const idVal = document.getElementById('adFormId').value;
    const name = document.getElementById('adFormName').value.trim();
    const image = document.getElementById('adFormImage').value.trim();
    const link = document.getElementById('adFormLink').value.trim();
    const active = document.getElementById('adFormActive').checked;
    if (!name || !image || !link) { note.textContent = 'Fill in name, image URL, and link.'; return; }
    note.textContent = 'Saving…';
    try {
      const { error } = await sb.rpc('admin_upsert_ad_product', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password,
        p_id: idVal ? Number(idVal) : null, p_name: name, p_image_url: image, p_link_url: link, p_active: active,
      });
      if (error) throw error;
      note.textContent = 'Saved.';
      resetAdForm();
      renderAdManagerProducts();
    } catch (e) {
      note.textContent = 'Failed: ' + (e.message || 'you\'re offline.');
    }
  });
}

/* ---------------------------------------------------------------- */
/* App boot logo ("stage 2" splash — the web app's own smaller         */
/* logo+text loading screen, admin-editable with no rebuild needed;    */
/* the big native logo flash before it is bundled into the APK and     */
/* can only change on rebuild).                                        */
/* ---------------------------------------------------------------- */

// Flood-fills a solid-color background out to transparent, seeded from the
// image's own border pixels (not a global color threshold) — same technique
// used to clean up the Aether-Industrial splash logo, run here in-browser
// via Canvas instead of a Node/sharp script. Background color is sampled
// from the four corners (averaged) rather than assumed to be black, so it
// works on any solid-colored source. A couple of dilation passes afterward
// clean up the leftover antialiasing fringe right at the cutout edge.
function floodRemoveBackground(imageData, threshold = 32) {
  const { data, width, height } = imageData;
  const idx = (x, y) => (y * width + x) * 4;
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  let br = 0, bg = 0, bb = 0;
  corners.forEach(([x, y]) => { const i = idx(x, y); br += data[i]; bg += data[i + 1]; bb += data[i + 2]; });
  br /= 4; bg /= 4; bb /= 4;

  const visited = new Uint8Array(width * height);
  const isBg = (x, y) => {
    const i = idx(x, y);
    const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= threshold;
  };
  const stack = [];
  const seed = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (!visited[p] && isBg(x, y)) { visited[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < width; x++) { seed(x, 0); seed(x, height - 1); }
  for (let y = 0; y < height; y++) { seed(0, y); seed(width - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width, y = (p / width) | 0;
    seed(x - 1, y); seed(x + 1, y); seed(x, y - 1); seed(x, y + 1);
  }

  let mask = visited;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(mask);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (mask[p]) continue;
        if ((x > 0 && mask[p - 1]) || (x < width - 1 && mask[p + 1]) ||
            (y > 0 && mask[p - width]) || (y < height - 1 && mask[p + width])) {
          next[p] = 1;
        }
      }
    }
    mask = next;
  }
  for (let p = 0; p < width * height; p++) if (mask[p]) data[p * 4 + 3] = 0;
  return imageData;
}

// Same flood-fill as floodRemoveBackground, but seeded from one clicked
// point instead of every border pixel — for enclosed regions (a hole inside
// a logo, a gap between two subject parts) that the border pass can't
// reach because nothing connects them to the image edge. Color reference is
// sampled at the click point itself rather than the corners.
function floodRemoveFromPoint(imageData, startX, startY, threshold = 32) {
  const { data, width, height } = imageData;
  const idx = (x, y) => (y * width + x) * 4;
  const i0 = idx(startX, startY);
  const br = data[i0], bg = data[i0 + 1], bb = data[i0 + 2];

  const visited = new Uint8Array(width * height);
  const isBg = (x, y) => {
    const i = idx(x, y);
    const dr = data[i] - br, dg = data[i + 1] - bg, db = data[i + 2] - bb;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= threshold;
  };
  const stack = [];
  const seed = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (!visited[p] && isBg(x, y)) { visited[p] = 1; stack.push(p); }
  };
  seed(startX, startY);
  while (stack.length) {
    const p = stack.pop();
    const x = p % width, y = (p / width) | 0;
    seed(x - 1, y); seed(x + 1, y); seed(x, y - 1); seed(x, y + 1);
  }
  for (let p = 0; p < width * height; p++) if (visited[p]) data[p * 4 + 3] = 0;
  return imageData;
}

// Loads the URL, runs the automatic border-seeded pass, and draws the
// result onto the given visible <canvas> (sized to the image's natural
// resolution) so btnSplashLogoRemoveBgApply's click handler can keep
// punching out leftover enclosed regions before finalizing.
async function removeImageBackgroundClientSide(url, targetCanvas, threshold = 32) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not load that image URL.'));
    el.src = url;
  });
  targetCanvas.width = img.naturalWidth;
  targetCanvas.height = img.naturalHeight;
  const ctx = targetCanvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, targetCanvas.width, targetCanvas.height);
  } catch (e) {
    throw new Error('This image host blocks cross-origin access — download it and host it somewhere that allows CORS (e.g. Supabase Storage, Imgur).');
  }
  floodRemoveBackground(imageData, threshold);
  ctx.putImageData(imageData, 0, 0);
}

async function fetchSplashSettings() {
  if (!sbConfigured()) return null;
  try {
    const { data, error } = await sb.from('app_splash_settings')
      .select('splash_image_url, splash_image_zoom, splash_image_pos_x, splash_image_pos_y').eq('id', 1).maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (e) { return null; }
}

function splashImageStyle(s) {
  const z = Number(s && s.splash_image_zoom) || 1;
  const x = (s && s.splash_image_pos_x != null) ? Number(s.splash_image_pos_x) : 50;
  const y = (s && s.splash_image_pos_y != null) ? Number(s.splash_image_pos_y) : 50;
  if (z <= 1 && x === 50 && y === 50) return '';
  return `object-position:${x}% ${y}%;transform:scale(${z});transform-origin:${x}% ${y}%`;
}

// Kicked off via setTimeout near the top of this file so it runs once sb is
// actually initialized — applies before the splash's flat 2000ms display
// timer elapses in the common case, swapping in the admin's custom logo (if
// any) in place of the bundled default before the user has reason to look
// away from it.
async function applyCustomSplashLogo() {
  const settings = await fetchSplashSettings();
  if (!settings || !settings.splash_image_url) return;
  const img = document.getElementById('splashLogo');
  if (!img) return;
  img.src = settings.splash_image_url;
  img.style.cssText = splashImageStyle(settings);
}

let splashLogoCropState = { zoom: 1, x: 50, y: 50 };

function applySplashLogoCropPreview() {
  const img = document.getElementById('splashLogoCropImg');
  const s = splashLogoCropState;
  img.style.objectPosition = `${s.x}% ${s.y}%`;
  img.style.transform = `scale(${s.zoom})`;
  img.style.transformOrigin = `${s.x}% ${s.y}%`;
  document.getElementById('splashLogoZoomValue').textContent = s.zoom.toFixed(1) + 'x';
  document.getElementById('splashLogoZoomSlider').value = Math.round(s.zoom * 100);
}

function refreshSplashLogoCropSection() {
  const url = document.getElementById('splashLogoManagerUrl').value.trim();
  const section = document.getElementById('splashLogoCropSection');
  section.hidden = !url;
  if (url) {
    document.getElementById('splashLogoCropImg').src = url;
    applySplashLogoCropPreview();
  }
}

function initSplashLogoCropControls() {
  const frame = document.getElementById('splashLogoCropFrame');
  if (!frame) return;
  document.getElementById('splashLogoManagerUrl').addEventListener('input', refreshSplashLogoCropSection);
  document.getElementById('splashLogoZoomSlider').addEventListener('input', e => {
    splashLogoCropState.zoom = Number(e.target.value) / 100;
    applySplashLogoCropPreview();
  });

  let dragging = null;
  frame.addEventListener('pointerdown', e => {
    dragging = { startX: e.clientX, startY: e.clientY, x: splashLogoCropState.x, y: splashLogoCropState.y };
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener('pointermove', e => {
    if (!dragging) return;
    const rect = frame.getBoundingClientRect();
    const dx = ((e.clientX - dragging.startX) / rect.width) * 100 / splashLogoCropState.zoom;
    const dy = ((e.clientY - dragging.startY) / rect.height) * 100 / splashLogoCropState.zoom;
    splashLogoCropState.x = Math.max(0, Math.min(100, dragging.x - dx));
    splashLogoCropState.y = Math.max(0, Math.min(100, dragging.y - dy));
    applySplashLogoCropPreview();
  });
  const endDrag = () => { dragging = null; };
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);
}

async function renderSplashLogoManager() {
  if (!sbConfigured() || !isAdminLoggedIn()) return;
  const settings = await fetchSplashSettings();
  const urlInput = document.getElementById('splashLogoManagerUrl');
  if (!urlInput) return;
  urlInput.value = (settings && settings.splash_image_url) || '';
  splashLogoCropState = {
    zoom: (settings && Number(settings.splash_image_zoom)) || 1,
    x: (settings && settings.splash_image_pos_x != null) ? Number(settings.splash_image_pos_x) : 50,
    y: (settings && settings.splash_image_pos_y != null) ? Number(settings.splash_image_pos_y) : 50,
  };
  refreshSplashLogoCropSection();
}

function initSplashLogoManager() {
  const saveBtn = document.getElementById('btnSplashLogoManagerSave');
  if (!saveBtn) return;
  initSplashLogoCropControls();
  const removeBgBtn = document.getElementById('btnSplashLogoRemoveBg');
  const previewSection = document.getElementById('splashLogoRemoveBgPreviewSection');
  const previewCanvas = document.getElementById('splashLogoRemoveBgCanvas');
  const toleranceSlider = document.getElementById('splashLogoRemoveBgTolerance');
  const toleranceOut = document.getElementById('splashLogoRemoveBgToleranceOut');
  if (toleranceSlider && toleranceOut) {
    toleranceSlider.addEventListener('input', () => { toleranceOut.textContent = toleranceSlider.value; });
  }
  const getTolerance = () => (toleranceSlider ? Number(toleranceSlider.value) : 13);
  if (removeBgBtn && previewCanvas) {
    removeBgBtn.addEventListener('click', async () => {
      const note = document.getElementById('splashLogoRemoveBgNote');
      const urlInput = document.getElementById('splashLogoManagerUrl');
      const url = urlInput.value.trim();
      if (!url) { note.textContent = 'Paste an image URL first.'; return; }
      note.textContent = 'Processing…';
      removeBgBtn.disabled = true;
      try {
        await removeImageBackgroundClientSide(url, previewCanvas, getTolerance());
        previewSection.hidden = false;
        note.textContent = 'Edges cleared — tap any leftover patch (like an enclosed hole) to remove it too, then confirm below.';
      } catch (e) {
        note.textContent = e.message || 'Could not process that image.';
      } finally {
        removeBgBtn.disabled = false;
      }
    });
    previewCanvas.addEventListener('click', e => {
      const rect = previewCanvas.getBoundingClientRect();
      const x = Math.round((e.clientX - rect.left) / rect.width * previewCanvas.width);
      const y = Math.round((e.clientY - rect.top) / rect.height * previewCanvas.height);
      const ctx = previewCanvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
      floodRemoveFromPoint(imageData, x, y, getTolerance());
      ctx.putImageData(imageData, 0, 0);
    });
    document.getElementById('btnSplashLogoRemoveBgApply').addEventListener('click', () => {
      document.getElementById('splashLogoManagerUrl').value = previewCanvas.toDataURL('image/png');
      previewSection.hidden = true;
      refreshSplashLogoCropSection();
      document.getElementById('splashLogoRemoveBgNote').textContent = 'Applied. Review the framing below, then Save.';
    });
  }
  saveBtn.addEventListener('click', async () => {
    const note = document.getElementById('splashLogoManagerNote');
    if (!isAdminLoggedIn()) { note.textContent = 'Admin login required.'; return; }
    const url = document.getElementById('splashLogoManagerUrl').value.trim();
    note.textContent = 'Saving…';
    try {
      const { error } = await sb.rpc('admin_set_splash_image', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_image_url: url,
        p_image_zoom: splashLogoCropState.zoom, p_image_pos_x: Math.round(splashLogoCropState.x), p_image_pos_y: Math.round(splashLogoCropState.y),
      });
      if (error) throw error;
      note.textContent = 'Saved — live for everyone now.';
      applyCustomSplashLogo();
    } catch (e) {
      note.textContent = 'Failed: ' + (e.message || 'you\'re offline.');
    }
  });
}

// Admin-only widget on the Nexus tab: every Digital ID that has ever
// connected Google Drive backup, with the email/gender/location captured
// at that sync (see syncAccountLogFromGoogle()). Cached here so the share
// button doesn't have to re-fetch — refreshed every time the section is
// shown (see refreshDigitalIdOverrideVisibility()).
let syncLogsRowsCache = [];

async function renderSyncLogs() {
  if (!sbConfigured() || !isAdminLoggedIn()) return;
  const list = document.getElementById('syncLogsList');
  const empty = document.getElementById('syncLogsEmptyNote');
  const summary = document.getElementById('syncLogsSummary');
  if (!list) return;
  try {
    const { data, error } = await sb.rpc('admin_list_account_sync_log', {
      p_digital_id: adminSession.digitalId, p_password: adminSession.password,
    });
    if (error) throw error;
    syncLogsRowsCache = data || [];
  } catch (e) {
    list.innerHTML = '';
    if (empty) { empty.hidden = false; empty.textContent = 'Could not load Sync Logs.'; }
    if (summary) summary.textContent = '0 synced';
    return;
  }
  summary.textContent = `${syncLogsRowsCache.length} synced`;
  list.innerHTML = '';
  if (!syncLogsRowsCache.length) { empty.hidden = false; return; }
  empty.hidden = true;
  syncLogsRowsCache.forEach(r => {
    const row = document.createElement('div');
    row.className = 'sync-log-row';
    row.innerHTML = `
      <span class="sync-log-id">${escapeHtml(r.public_id || '–')}</span>
      <span>${escapeHtml(r.gender || '–')}</span>
      <span>${escapeHtml(r.email || '–')}</span>
      <span class="sync-log-muted">${escapeHtml(r.location || '–')}</span>`;
    list.appendChild(row);
  });
}

async function generateSyncLogsShareCard(rows) {
  const width = 600;
  const headerH = 116;
  const columns = [
    { label: 'DIGITAL ID', width: 140 }, { label: 'GENDER', width: 90 },
    { label: 'EMAIL', width: 220 }, { label: 'LOCATION', width: 150 },
  ];
  const tableRows = rows.map(r => [r.public_id || '–', r.gender || '–', r.email || '–', r.location || '–']);
  const tableH = 22 + Math.max(1, tableRows.length) * 22;
  const height = headerH + 20 + tableH + 24 + 46;

  const { canvas, ctx } = shareCardShell(width, height);
  drawShareCardHeader(ctx, width, {
    name: 'Sync Logs', digitalId: adminSession.digitalId,
    date: new Date().toLocaleString(), title: `${rows.length} SYNCED ACCOUNT${rows.length === 1 ? '' : 'S'}`,
  });

  const y = headerH + 20;
  if (!tableRows.length) {
    ctx.textAlign = 'center'; ctx.fillStyle = getShareTheme().textMuted; ctx.font = '14px sans-serif';
    ctx.fillText('No synced accounts yet.', width / 2, y + 20);
  } else {
    drawShareTable(ctx, 32, y, width - 64, columns, tableRows);
  }

  await drawShareCardFooter(ctx, width, height);
  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

function initSyncLogsShare() {
  const btn = document.getElementById('btnShareSyncLogs');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!isAdminLoggedIn()) return;
    try {
      const blob = await generateSyncLogsShareCard(syncLogsRowsCache);
      await shareViaWebShare({ title: 'Sync Logs', text: `Winfinity Sync Logs — ${syncLogsRowsCache.length} synced account(s)` }, blob);
    } catch (e) { showRestToast('Could not generate Sync Logs card.'); }
  });
}

/* ---------------------------------------------------------------- */
/* Media Synchronizer (Nutrition tab) — admin-configurable still image  */
/* or auto-cycling slideshow, one global row, visible to every user.    */
/* ---------------------------------------------------------------- */
let mediaSyncSettings = { mode: 'still', image_urls: [], duration_sec: 10 };
let mediaSyncFormState = { mode: 'still', urls: [''] };
let mediaSyncSlideshowTimer = null;

async function fetchMediaSyncSettings() {
  if (!sbConfigured()) return null;
  try {
    const { data, error } = await sb.from('media_sync_settings').select('mode, image_urls, duration_sec, randomize').eq('id', 1).maybeSingle();
    if (error || !data) return null;
    return {
      mode: data.mode === 'slideshow' ? 'slideshow' : 'still',
      image_urls: Array.isArray(data.image_urls) ? data.image_urls : [],
      duration_sec: data.duration_sec || 10,
      randomize: !!data.randomize,
    };
  } catch (e) { return null; }
}

function stopMediaSyncSlideshow() {
  if (mediaSyncSlideshowTimer) { clearInterval(mediaSyncSlideshowTimer); mediaSyncSlideshowTimer = null; }
}

// Overlays the matching meal's name (upper-left tag) on whichever image is
// currently showing — slideshow URLs are matched back to prep_meals rows
// by image_url; images with no matching meal just show no tag.
function setMediaSyncImageName(url, nameByUrl) {
  const tag = document.getElementById('mediaSyncImageName');
  const name = nameByUrl && nameByUrl[url];
  tag.textContent = name || '';
  tag.hidden = !name;
}

function startMediaSyncSlideshow(imgEl, urls, durationSec, randomize, nameByUrl) {
  stopMediaSyncSlideshow();
  if (urls.length < 2) return;
  let idx = 0;
  mediaSyncSlideshowTimer = setInterval(() => {
    if (randomize) {
      // Random, but never the same image twice in a row.
      let next;
      do { next = Math.floor(Math.random() * urls.length); } while (next === idx);
      idx = next;
    } else {
      idx = (idx + 1) % urls.length;
    }
    imgEl.src = urls[idx];
    setMediaSyncImageName(urls[idx], nameByUrl);
  }, Math.max(3, durationSec) * 1000);
}

// Always visible once Supabase is configured, admin or not — the widget
// itself (image/slideshow, admin-only gear icon) is unrelated to the
// Warrior-tier gate on Browse below. With no media configured yet it just
// shows the empty-state placeholder instead of hiding the whole card.
async function renderMediaSyncWidget() {
  const card = document.getElementById('mediaSyncCard');
  if (!card) return;
  if (!sbConfigured()) { card.hidden = true; return; }
  const settings = await fetchMediaSyncSettings();
  mediaSyncSettings = settings || { mode: 'still', image_urls: [], duration_sec: 10, randomize: false };
  const img = document.getElementById('mediaSyncImage');
  const empty = document.getElementById('mediaSyncEmpty');
  const menuWrap = document.getElementById('mediaSyncMenuWrap');
  const admin = isAdminLoggedIn();
  const urls = mediaSyncSettings.image_urls.filter(Boolean);

  card.hidden = false;
  menuWrap.hidden = !admin;

  if (!urls.length) {
    img.hidden = true;
    empty.hidden = false;
    setMediaSyncImageName(null, null);
    stopMediaSyncSlideshow();
    return;
  }

  // Meal names for the image tag overlay — reuse the cache when it's warm,
  // otherwise fetch (cheap select; runs on Nutrition tab open).
  if (!prepMealsCache.length) prepMealsCache = await fetchPrepMeals();
  const nameByUrl = {};
  prepMealsCache.forEach(m => { if (m.image_url) nameByUrl[m.image_url] = m.name; });

  img.hidden = false;
  empty.hidden = true;
  img.src = urls[0];
  setMediaSyncImageName(urls[0], nameByUrl);
  if (mediaSyncSettings.mode === 'slideshow' && urls.length > 1) {
    startMediaSyncSlideshow(img, urls, mediaSyncSettings.duration_sec, mediaSyncSettings.randomize, nameByUrl);
  } else {
    stopMediaSyncSlideshow();
  }
}

// Renders the Source Configuration URL rows for whichever mode is
// currently selected in the (unsaved) form state — Still Image shows one
// field with no delete/add controls, Slideshow shows every field with
// per-row delete once there's more than one.
function renderMediaSyncUrlRows() {
  const list = document.getElementById('mediaSyncUrlList');
  const addBtn = document.getElementById('btnAddMediaSyncUrl');
  const isSlideshow = mediaSyncFormState.mode === 'slideshow';
  addBtn.hidden = !isSlideshow;
  if (!mediaSyncFormState.urls.length) mediaSyncFormState.urls.push('');
  const urls = isSlideshow ? mediaSyncFormState.urls : mediaSyncFormState.urls.slice(0, 1);
  list.innerHTML = '';
  urls.forEach((url, i) => {
    const row = document.createElement('div');
    row.className = 'media-sync-url-row';
    const canDelete = isSlideshow && urls.length > 1;
    row.innerHTML = `
      <span class="media-sync-url-index">${String(i + 1).padStart(2, '0')}</span>
      <input type="text" class="media-sync-url-input" placeholder="Enter system URL..." value="${escapeHtml(url)}">
      <button type="button" class="icon-btn media-sync-url-delete" aria-label="Remove field" ${canDelete ? '' : 'hidden'}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>`;
    row.querySelector('.media-sync-url-input').addEventListener('input', e => { mediaSyncFormState.urls[i] = e.target.value; });
    const delBtn = row.querySelector('.media-sync-url-delete');
    if (canDelete) delBtn.addEventListener('click', () => { mediaSyncFormState.urls.splice(i, 1); renderMediaSyncUrlRows(); });
    list.appendChild(row);
  });
}

function setMediaSyncMode(mode) {
  mediaSyncFormState.mode = mode;
  document.getElementById('mediaModeStillBtn').classList.toggle('is-selected', mode === 'still');
  document.getElementById('mediaModeSlideshowBtn').classList.toggle('is-selected', mode === 'slideshow');
  document.getElementById('mediaSyncTimingSection').hidden = mode !== 'slideshow';
  renderMediaSyncUrlRows();
}

function openMediaSyncCalibration() {
  mediaSyncFormState = {
    mode: mediaSyncSettings.mode || 'still',
    urls: (mediaSyncSettings.image_urls && mediaSyncSettings.image_urls.length) ? [...mediaSyncSettings.image_urls] : [''],
  };
  const duration = mediaSyncSettings.duration_sec || 10;
  document.getElementById('mediaSyncTimingSlider').value = duration;
  document.getElementById('mediaSyncTimingValue').textContent = duration + 's';
  document.getElementById('mediaSyncRandomize').checked = !!mediaSyncSettings.randomize;
  setMediaSyncMode(mediaSyncFormState.mode);
  document.getElementById('mediaSyncConfigNote').textContent = '';
  document.getElementById('mediaSyncCalibrationOverlay').hidden = false;
}

function resetMediaSyncForm() {
  mediaSyncFormState = { mode: 'still', urls: [''] };
  document.getElementById('mediaSyncTimingSlider').value = 10;
  document.getElementById('mediaSyncTimingValue').textContent = '10s';
  document.getElementById('mediaSyncRandomize').checked = false;
  setMediaSyncMode('still');
  document.getElementById('mediaSyncConfigNote').textContent = 'Reset — tap Save configuration to apply.';
}

async function saveMediaSyncConfig() {
  const note = document.getElementById('mediaSyncConfigNote');
  if (!isAdminLoggedIn()) { note.textContent = 'Admin login required.'; return; }
  const rawUrls = mediaSyncFormState.mode === 'still' ? mediaSyncFormState.urls.slice(0, 1) : mediaSyncFormState.urls;
  const urls = rawUrls.map(u => (u || '').trim()).filter(Boolean);
  const duration = Number(document.getElementById('mediaSyncTimingSlider').value) || 10;
  const randomize = document.getElementById('mediaSyncRandomize').checked;
  note.textContent = 'Saving…';
  try {
    const { error } = await sb.rpc('admin_set_media_sync', {
      p_digital_id: adminSession.digitalId, p_password: adminSession.password,
      p_mode: mediaSyncFormState.mode, p_image_urls: urls, p_duration_sec: duration, p_randomize: randomize,
    });
    if (error) throw error;
    note.textContent = 'Saved.';
    await renderMediaSyncWidget();
    setTimeout(() => { document.getElementById('mediaSyncCalibrationOverlay').hidden = true; }, 700);
  } catch (e) {
    note.textContent = 'Failed: ' + (e.message || 'you\'re offline.');
  }
}

function initMediaSyncWidget() {
  const settingsBtn = document.getElementById('btnMediaSyncSettings');
  if (!settingsBtn) return;
  settingsBtn.addEventListener('click', openMediaSyncCalibration);
  const overlay = document.getElementById('mediaSyncCalibrationOverlay');
  document.getElementById('btnCloseMediaSyncCalibration').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
  document.getElementById('mediaModeStillBtn').addEventListener('click', () => setMediaSyncMode('still'));
  document.getElementById('mediaModeSlideshowBtn').addEventListener('click', () => setMediaSyncMode('slideshow'));
  document.getElementById('btnAddMediaSyncUrl').addEventListener('click', () => { mediaSyncFormState.urls.push(''); renderMediaSyncUrlRows(); });
  document.getElementById('mediaSyncTimingSlider').addEventListener('input', e => {
    document.getElementById('mediaSyncTimingValue').textContent = e.target.value + 's';
  });
  document.getElementById('btnSaveMediaSyncConfig').addEventListener('click', saveMediaSyncConfig);
  document.getElementById('btnResetMediaSyncDefaults').addEventListener('click', resetMediaSyncForm);
  // Browse is Warrior-tier gated (see MODE_GATED_ELEMENTS) — the click
  // guard intercepts and blocks this handler entirely while locked, so it
  // only ever runs once unlocked.
  document.getElementById('btnMediaSyncBrowse').addEventListener('click', openFoodPrepsOverlay);
}

/* ---------------------------------------------------------------- */
/* Food Preps (opened from the Media Synchronizer's Browse button,      */
/* Warrior-tier gated — see MODE_GATED_ELEMENTS) — an admin-curated list */
/* of meals with true per-100g macros, same convention as the Add Food  */
/* AI estimate flow. Picking a calorie target in a meal's detail view   */
/* computes that meal's serving size: grams = target / cal_per_100g *   */
/* 100, macros scale with grams. Regular users can browse but only an   */
/* admin (password-gated) can add/edit/delete via the editor overlay.   */
/* ---------------------------------------------------------------- */
const PREP_MEAL_CATEGORY_LABELS = { breakfast: 'Breakfast', full_meal: 'Full Meal', snack: 'Snack' };
// Generated inline (no network dependency, works offline) as the thumbnail
// for any prep_meals row without an admin-set image_url — a plate/utensils
// icon in the app's own dark/cyan palette rather than a broken-image icon.
const PREP_MEAL_DEFAULT_IMAGE = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<rect width="100" height="100" rx="14" fill="#171f24"/>' +
  '<circle cx="50" cy="52" r="26" fill="none" stroke="#33c8cc" stroke-width="3"/>' +
  '<circle cx="50" cy="52" r="13" fill="none" stroke="#33c8cc" stroke-width="2" opacity="0.5"/>' +
  '<path d="M28 24v18M24 24v10c0 3 2 5 4 5s4-2 4-5V24M32 24v10c0 3-2 5-4 5" stroke="#33c8cc" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M74 24c-4 1-6 5-6 10s2 8 6 9v19" stroke="#33c8cc" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>'
);
let prepMealsCache = [];
let prepMealSelectedCategory = 'breakfast';
let foodPrepsDetailMeal = null;
let foodPrepsExpanded = false;
const FOOD_PREPS_PREVIEW_COUNT = 3;

// Admin-set image framing (zoom + focal point) is display-only — the app
// can't re-host a cropped copy of a remote image, so the "crop" is applied
// as object-position (pan) + scale (zoom) around the same focal point,
// clipped by the image's wrapper box.
function prepMealImageStyle(meal) {
  const z = Number(meal.image_zoom) || 1;
  const x = meal.image_pos_x != null ? Number(meal.image_pos_x) : 50;
  const y = meal.image_pos_y != null ? Number(meal.image_pos_y) : 50;
  if (z <= 1 && x === 50 && y === 50) return '';
  return `object-position:${x}% ${y}%;transform:scale(${z});transform-origin:${x}% ${y}%`;
}

function applyPrepMealImage(imgEl, meal) {
  imgEl.src = meal.image_url || PREP_MEAL_DEFAULT_IMAGE;
  imgEl.style.cssText = prepMealImageStyle(meal);
}

async function fetchPrepMeals() {
  if (!sbConfigured()) return [];
  try {
    const { data, error } = await sb.from('prep_meals').select('*').order('created_at', { ascending: true });
    if (error) return [];
    return data || [];
  } catch (e) { return []; }
}

// Same Edge Function as the food-estimate AI calls above, extended server-side
// to also accept a pasted recipe/menu, a URL (webpage or direct image link),
// or an uploaded photo of a dish/recipe page (see
// supabase/functions/estimate-food-nutrition/index.js's hasMealMenu branch).
async function estimatePrepMealFromMenu({ mealMenuText, mealMenuUrl, mealMenuImageBase64, mealMenuImageMimeType }) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/smooth-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ mealMenuText, mealMenuUrl, mealMenuImageBase64, mealMenuImageMimeType }),
    });
  } catch (e) {
    throw new Error('AI auto-fill unavailable — check your connection.');
  }
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('AI auto-fill unavailable — try again later.'); }
  if (!res.ok) throw new Error(data.error || 'AI auto-fill failed');
  return data;
}

// One screen: a (by default 3-item) list up top, an inline detail panel
// below it that updates live as different meals are tapped — no
// list-then-detail navigation. "Expand" grows the list in place to every
// meal in the current category instead of opening anything new.
function renderFoodPrepsList() {
  const list = document.getElementById('foodPrepsList');
  const empty = document.getElementById('foodPrepsEmptyNote');
  const expandBtn = document.getElementById('btnFoodPrepsExpand');
  const myShareKey = localStorage.getItem('wft_lb_share_key');
  // Unapproved submissions stay hidden from the public list, but their own
  // author sees them immediately (badged "Pending") — and admins see
  // everything so nothing awaiting review is invisible to them.
  const activeMeals = prepMealsCache.filter(m => m.active && m.category === prepMealSelectedCategory &&
    (m.approved !== false || isAdminLoggedIn() || (m.author_type === 'user' && !!myShareKey && m.author_share_key === myShareKey)));
  const visibleMeals = foodPrepsExpanded ? activeMeals : activeMeals.slice(0, FOOD_PREPS_PREVIEW_COUNT);

  expandBtn.hidden = activeMeals.length <= FOOD_PREPS_PREVIEW_COUNT;
  expandBtn.classList.toggle('is-expanded', foodPrepsExpanded);

  list.innerHTML = '';
  if (!activeMeals.length) {
    empty.hidden = false;
    document.getElementById('foodPrepsDetailPanel').hidden = true;
    foodPrepsDetailMeal = null;
    return;
  }
  empty.hidden = true;

  if (!foodPrepsDetailMeal || !activeMeals.some(m => m.id === foodPrepsDetailMeal.id)) {
    selectFoodPrepMeal(activeMeals[0]);
  }

  visibleMeals.forEach(m => {
    const isMine = m.author_type === 'user' && !!myShareKey && m.author_share_key === myShareKey;
    const badgeClass = m.author_type === 'admin' ? 'is-admin' : (isMine ? 'is-self' : '');
    const badgeLabel = m.author_type === 'admin' ? 'Admin' : `By ${m.author_name || 'User'}`;
    const pendingBadge = m.approved === false ? '<span class="prep-meal-author-badge is-pending">Pending review</span>' : '';
    const firstIngredientLine = (m.ingredients || '').split('\n')[0];
    const row = document.createElement('div');
    row.className = 'prep-meal-row' + (foodPrepsDetailMeal && m.id === foodPrepsDetailMeal.id ? ' is-selected' : '');
    row.dataset.mealId = m.id;
    row.innerHTML = `
      <span class="prep-meal-thumb"><img src="${escapeHtml(m.image_url || PREP_MEAL_DEFAULT_IMAGE)}" alt="" loading="lazy" style="${prepMealImageStyle(m)}"></span>
      <div class="prep-meal-info">
        <div class="prep-meal-name-row">
          <span class="prep-meal-name">${escapeHtml(m.name)}</span>
          <span class="prep-meal-author-badge ${badgeClass}">${escapeHtml(badgeLabel)}</span>${pendingBadge}
        </div>
        <div class="prep-meal-ingredients">${escapeHtml(firstIngredientLine)}</div>
      </div>
      <span class="prep-meal-cal-badge">${Math.round(m.cal_per_100g || 0)} kcal/100g</span>`;
    row.addEventListener('click', () => selectFoodPrepMeal(m));
    list.appendChild(row);
  });
}

// Ingredients are stored one-per-line (see the editor's textarea
// placeholder) — split on newlines.
function renderBulletedText(listEl, text, splitter) {
  const items = (text || '').split(splitter).map(s => s.trim()).filter(Boolean);
  listEl.innerHTML = items.length
    ? items.map(i => `<li>${escapeHtml(i)}</li>`).join('')
    : '<li>—</li>';
}

// Procedures are stored one step per line, usually already prefixed
// "1." "2." etc. — split on newlines and strip that embedded numbering,
// since the <ol> renders its own (keeping both was double-numbering every
// step). Splitting on periods is wrong here: a step like "Preheat oven to
// 400 F. Spray the dish." is one numbered step, and abbreviations like
// "400 F." would chop it mid-sentence anyway. Pasted run-on prose with no
// line breaks at all falls back to sentence splitting.
function renderProcedureList(listEl, text) {
  let items = (text || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (items.length <= 1) {
    items = (text || '').split(/\.\s+/).map(s => s.trim()).filter(Boolean)
      .map(s => (/[.!?]$/.test(s) ? s : s + '.'));
  }
  items = items.map(s => s.replace(/^\d+\s*[.)]\s*/, ''));
  listEl.innerHTML = items.length
    ? items.map(i => `<li>${escapeHtml(i)}</li>`).join('')
    : '<li>—</li>';
}

// Macros scale directly off the typed serving size (grams) against each
// meal's per-100g rates — true per-100g serving math, same convention as
// the Add Food AI estimate flow.
function renderFoodPrepsDetail() {
  const m = foodPrepsDetailMeal;
  if (!m) return;
  const grams = Number(document.getElementById('foodPrepsServingSize').value) || 0;
  const ratio = grams / 100;
  const protein = (m.protein_per_100g || 0) * ratio;
  const carbs = (m.carbs_per_100g || 0) * ratio;
  const fat = (m.fat_per_100g || 0) * ratio;
  const fiber = (m.fiber_per_100g || 0) * ratio;
  const sodium = (m.sodium_per_100g || 0) * ratio;
  document.getElementById('foodPrepsDetailProtein').textContent = Math.round(protein) + 'g';
  document.getElementById('foodPrepsDetailCarbs').textContent = Math.round(carbs) + 'g';
  document.getElementById('foodPrepsDetailFat').textContent = Math.round(fat) + 'g';
  document.getElementById('foodPrepsDetailFiber').textContent = Math.round(fiber) + 'g';
  document.getElementById('foodPrepsDetailSodium').textContent = Math.round(sodium) + 'mg';
  const proteinKcal = protein * 4, carbsKcal = carbs * 4, fatKcal = fat * 9;
  const totalKcal = proteinKcal + carbsKcal + fatKcal;
  document.getElementById('foodPrepsDetailProteinBar').style.width = (totalKcal > 0 ? (proteinKcal / totalKcal) * 100 : 0) + '%';
  document.getElementById('foodPrepsDetailCarbsBar').style.width = (totalKcal > 0 ? (carbsKcal / totalKcal) * 100 : 0) + '%';
  document.getElementById('foodPrepsDetailFatBar').style.width = (totalKcal > 0 ? (fatKcal / totalKcal) * 100 : 0) + '%';
}

// Highlights the tapped row and refreshes the detail panel below the list
// in place — this is the "live update" the list drives, not a navigation.
function selectFoodPrepMeal(meal) {
  foodPrepsDetailMeal = meal;
  document.querySelectorAll('#foodPrepsList .prep-meal-row').forEach(row => {
    row.classList.toggle('is-selected', row.dataset.mealId === String(meal.id));
  });
  const panel = document.getElementById('foodPrepsDetailPanel');
  panel.hidden = false;
  applyPrepMealImage(document.getElementById('foodPrepsDetailImage'), meal);
  document.getElementById('foodPrepsDetailName').textContent = meal.name;
  const myShareKey = localStorage.getItem('wft_lb_share_key');
  const isMine = meal.author_type === 'user' && !!myShareKey && meal.author_share_key === myShareKey;
  const badge = document.getElementById('foodPrepsDetailBadge');
  badge.textContent = meal.author_type === 'admin' ? 'Admin' : `By ${meal.author_name || 'User'}`;
  badge.className = 'prep-meal-author-badge ' + (meal.author_type === 'admin' ? 'is-admin' : (isMine ? 'is-self' : ''));
  renderBulletedText(document.getElementById('foodPrepsDetailIngredients'), meal.ingredients, '\n');
  renderProcedureList(document.getElementById('foodPrepsDetailProcedure'), meal.procedure);
  const editBtn = document.getElementById('btnFoodPrepsAdminEdit');
  editBtn.hidden = !(isAdminLoggedIn() || isMine);
  editBtn.textContent = isAdminLoggedIn() ? 'Edit this meal (Admin)' : 'Edit your meal';
  document.getElementById('foodPrepsServingSize').value = 100;
  renderFoodPrepsDetail();
}

async function openFoodPrepsOverlay() {
  prepMealsCache = await fetchPrepMeals();
  foodPrepsExpanded = false;
  foodPrepsDetailMeal = null;
  renderFoodPrepsList();
  document.getElementById('foodPrepsOverlay').hidden = false;
}

function closeFoodPrepsOverlay() {
  document.getElementById('foodPrepsOverlay').hidden = true;
}

// Refreshes the Food Preps list/detail (if the overlay is open) after a
// save/delete in the editor — a no-op when the overlay isn't open.
function refreshOpenFoodPrepsScreen(savedId) {
  const overlay = document.getElementById('foodPrepsOverlay');
  if (!overlay || overlay.hidden) return;
  if (savedId) {
    const updated = prepMealsCache.find(x => String(x.id) === String(savedId));
    if (updated) foodPrepsDetailMeal = updated;
  }
  renderFoodPrepsList();
}

// Shows a larger floating preview of a food thumbnail while it's pressed
// (mouse or touch), positioned centered on the thumbnail and scaling up
// from it — auto-hides the moment the press is released, wherever that
// happens, via one-shot document-level listeners.
function showFoodPrepsThumbPreview(thumbEl) {
  const preview = document.getElementById('foodPrepsThumbPreview');
  const img = document.getElementById('foodPrepsThumbPreviewImg');
  const thumbImg = thumbEl.querySelector('img');
  img.src = thumbImg ? thumbImg.src : '';
  img.style.cssText = thumbImg ? thumbImg.style.cssText : '';
  const rect = thumbEl.getBoundingClientRect();
  preview.style.left = Math.round(rect.left + rect.width / 2) + 'px';
  preview.style.top = Math.round(rect.top + rect.height / 2) + 'px';
  preview.hidden = false;
  requestAnimationFrame(() => preview.classList.add('is-open'));
}

function hideFoodPrepsThumbPreview() {
  const preview = document.getElementById('foodPrepsThumbPreview');
  preview.classList.remove('is-open');
  setTimeout(() => { preview.hidden = true; }, 150);
}

function initFoodPrepsThumbPreview() {
  const list = document.getElementById('foodPrepsList');
  if (!list) return;
  list.addEventListener('pointerdown', e => {
    const thumb = e.target.closest('.prep-meal-thumb');
    if (!thumb) return;
    showFoodPrepsThumbPreview(thumb);
    const end = () => {
      hideFoodPrepsThumbPreview();
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  });
}

function initFoodPrepsOverlay() {
  const overlay = document.getElementById('foodPrepsOverlay');
  if (!overlay) return;
  document.getElementById('btnCloseFoodPreps').addEventListener('click', closeFoodPrepsOverlay);
  bindOverlayBackdropClose(overlay, closeFoodPrepsOverlay);
  document.querySelectorAll('#foodPrepsCategoryTabs .prep-meal-category-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      prepMealSelectedCategory = tab.dataset.category;
      foodPrepsExpanded = false;
      foodPrepsDetailMeal = null;
      document.querySelectorAll('#foodPrepsCategoryTabs .prep-meal-category-tab').forEach(t => t.classList.toggle('is-selected', t === tab));
      renderFoodPrepsList();
    });
  });
  document.getElementById('btnFoodPrepsExpand').addEventListener('click', () => {
    foodPrepsExpanded = !foodPrepsExpanded;
    renderFoodPrepsList();
  });
  document.getElementById('foodPrepsServingSize').addEventListener('input', renderFoodPrepsDetail);
  // Edit the currently-viewed meal: admins can edit anything; a regular
  // user only sees this button on their own submissions (server-side
  // ownership check backs it up either way).
  document.getElementById('btnFoodPrepsAdminEdit').addEventListener('click', () => {
    if (!foodPrepsDetailMeal) return;
    const myShareKey = localStorage.getItem('wft_lb_share_key');
    const isMine = foodPrepsDetailMeal.author_type === 'user' && !!myShareKey && foodPrepsDetailMeal.author_share_key === myShareKey;
    if (!isAdminLoggedIn() && !isMine) return;
    openPrepMealEditor(foodPrepsDetailMeal);
  });
  document.getElementById('btnFoodPrepsAddOwn').addEventListener('click', () => openPrepMealEditor(null));
  initFoodPrepsThumbPreview();
}

// Admin-only widget on the Nutrition tab: every prep meal (Admin- and
// user-authored alike) with Approve/Edit/Delete. Edit opens the same shared
// editor overlay the Food Preps "+" button uses, just in 'admin' mode.
// Independent of the Warrior-tier gate on Browse — admins manage the
// catalog here regardless of their own fitness mode.
let lastToastedPendingCount = 0;
let prepMealManagerExpanded = false;
const PREP_MEAL_MANAGER_PREVIEW_COUNT = 3;

async function renderPrepMealManager() {
  if (!sbConfigured() || !isAdminLoggedIn()) return;
  prepMealsCache = await fetchPrepMeals();
  const list = document.getElementById('prepMealManagerList');
  const empty = document.getElementById('prepMealManagerEmptyNote');
  const expandBtn = document.getElementById('btnPrepMealManagerExpand');
  if (!list) return;
  list.innerHTML = '';
  if (!prepMealsCache.length) { empty.hidden = false; if (expandBtn) expandBtn.hidden = true; return; }
  empty.hidden = true;

  // Pending submissions float to the top of the list and get a one-tap
  // Approve button; the count doubles as the admin's review notification —
  // toasted only when it changes, not on every re-render. Everything else
  // is alphabetical so a specific meal is easy to find in a long menu.
  const sorted = [...prepMealsCache].sort((a, b) => {
    const pendingDiff = (a.approved === false ? 0 : 1) - (b.approved === false ? 0 : 1);
    return pendingDiff !== 0 ? pendingDiff : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  const pendingCount = prepMealsCache.filter(m => m.approved === false).length;
  if (pendingCount > 0 && pendingCount !== lastToastedPendingCount) {
    showRestToast(`🔔 ${pendingCount} prep meal submission${pendingCount === 1 ? '' : 's'} pending your review.`);
  }
  lastToastedPendingCount = pendingCount;

  if (expandBtn) expandBtn.hidden = sorted.length <= PREP_MEAL_MANAGER_PREVIEW_COUNT;
  list.classList.toggle('prep-meal-manager-list--expanded', prepMealManagerExpanded);
  if (expandBtn) expandBtn.classList.toggle('is-expanded', prepMealManagerExpanded);
  const visible = prepMealManagerExpanded ? sorted : sorted.slice(0, PREP_MEAL_MANAGER_PREVIEW_COUNT);

  visible.forEach(m => {
    const row = document.createElement('div');
    row.className = 'ad-manager-row prep-meal-manager-row' + (m.active ? '' : ' ad-manager-inactive');
    const authorLabel = m.author_type === 'admin' ? 'Admin' : `User: ${m.author_name || 'Unknown'}`;
    const pendingTag = m.approved === false ? ' <span class="prep-meal-author-badge is-pending">Pending review</span>' : '';
    row.innerHTML = `
      <img class="ad-manager-thumb" src="${escapeHtml(m.image_url || PREP_MEAL_DEFAULT_IMAGE)}" alt="" loading="lazy">
      <div class="ad-manager-info">
        <div class="ad-manager-name">${escapeHtml(m.name)}${m.active ? '' : ' (inactive)'}${pendingTag}</div>
        <span class="ad-manager-link">${PREP_MEAL_CATEGORY_LABELS[m.category] || m.category} · ${escapeHtml(authorLabel)} · ${m.cal_per_100g} kcal/100g (P${m.protein_per_100g}/C${m.carbs_per_100g}/F${m.fat_per_100g}/Fbr${m.fiber_per_100g}/Na${m.sodium_per_100g}mg)</span>
      </div>
      <div class="ad-manager-actions">
        ${m.approved === false ? `<button type="button" class="btn btn--primary btn--sm" data-approve-meal="${m.id}">Approve</button>` : ''}
        <button type="button" class="btn btn--sm" data-edit-meal="${m.id}">Edit</button>
        <button type="button" class="btn btn--danger btn--sm" data-delete-meal="${m.id}">Delete</button>
      </div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-approve-meal]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const { error } = await sb.rpc('admin_approve_prep_meal', {
          p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_id: Number(btn.dataset.approveMeal),
        });
        if (error) throw error;
        showRestToast('Approved — now visible to everyone.');
        prepMealsCache = await fetchPrepMeals();
        renderPrepMealManager();
        refreshOpenFoodPrepsScreen();
      } catch (e) { showRestToast('Could not approve.'); }
    });
  });
  list.querySelectorAll('[data-edit-meal]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = prepMealsCache.find(x => String(x.id) === btn.dataset.editMeal);
      if (m) openPrepMealEditor(m);
    });
  });
  list.querySelectorAll('[data-delete-meal]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this prep meal?')) return;
      try {
        await sb.rpc('admin_delete_prep_meal', {
          p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_id: Number(btn.dataset.deleteMeal),
        });
        prepMealsCache = await fetchPrepMeals();
        renderPrepMealManager();
        refreshOpenFoodPrepsScreen();
      } catch (e) { showRestToast('Could not delete meal.'); }
    });
  });
}

function initPrepMealManager() {
  const addBtn = document.getElementById('btnAdminAddPrepMeal');
  if (!addBtn) return;
  addBtn.addEventListener('click', () => openPrepMealEditor(null));
  const expandBtn = document.getElementById('btnPrepMealManagerExpand');
  if (expandBtn) expandBtn.addEventListener('click', () => { prepMealManagerExpanded = !prepMealManagerExpanded; renderPrepMealManager(); });
}

/* Prep Meal editor overlay — admin-only (view and edit). Opened from the  */
/* admin manager's Add/Edit buttons; every save/delete goes through the    */
/* password-gated admin_upsert_prep_meal/admin_delete_prep_meal RPCs. All  */
/* macro fields are per-100g, same convention as the Add Food AI flow.     */
function fillPrepMealEditorForm(m) {
  document.getElementById('prepMealFormId').value = m ? m.id : '';
  document.getElementById('prepMealFormCategory').value = m ? m.category : prepMealSelectedCategory;
  document.getElementById('prepMealFormName').value = m ? m.name : '';
  // Serving always opens at 100g, so the stored per-100g rates ARE the
  // per-serving numbers shown — the admin can then change the serving to
  // whatever their label/source states and the fields rescale to match.
  document.getElementById('prepMealFormServing').value = 100;
  prepMealEditorServing = 100;
  document.getElementById('prepMealFormCalories').value = m ? m.cal_per_100g : '';
  document.getElementById('prepMealFormProtein').value = m ? m.protein_per_100g : '';
  document.getElementById('prepMealFormCarbs').value = m ? m.carbs_per_100g : '';
  document.getElementById('prepMealFormFat').value = m ? m.fat_per_100g : '';
  document.getElementById('prepMealFormFiber').value = m ? m.fiber_per_100g : '';
  document.getElementById('prepMealFormSodium').value = m ? m.sodium_per_100g : '';
  document.getElementById('prepMealFormIngredients').value = m ? m.ingredients : '';
  document.getElementById('prepMealFormProcedure').value = m ? m.procedure : '';
  document.getElementById('prepMealFormImageUrl').value = (m && m.image_url) || '';
  prepMealEditorOriginalImageUrl = (m && m.image_url) || '';
  document.getElementById('prepMealFormActive').checked = m ? m.active : true;
  document.getElementById('prepMealAiText').value = '';
  document.getElementById('prepMealAiUrl').value = '';
  document.getElementById('prepMealAiPhotoPreview').hidden = true;
  document.getElementById('prepMealAiPhotoPreview').src = '';
  document.getElementById('prepMealAiNote').textContent = '';
  document.getElementById('prepMealFormNote').textContent = '';
  prepMealCropState = {
    zoom: (m && Number(m.image_zoom)) || 1,
    x: (m && m.image_pos_x != null) ? Number(m.image_pos_x) : 50,
    y: (m && m.image_pos_y != null) ? Number(m.image_pos_y) : 50,
  };
  refreshPrepMealCropSection();
}

function openPrepMealEditor(existingMeal) {
  const admin = isAdminLoggedIn();
  fillPrepMealEditorForm(existingMeal);
  document.getElementById('prepMealEditorTitle').textContent = existingMeal ? 'Edit Prep Meal' : 'Add Prep Meal';
  // Image URL/framing and the Active toggle stay admin-only — a user
  // submission can't inject an arbitrary image, and visibility moderation
  // belongs to the admin. AI auto-fill is admin-only too (Gemini API cost
  // control) — a submitting user gets the plain manual form. Everything
  // else is open to the submitting user.
  document.getElementById('prepMealFormImageRow').hidden = !admin;
  document.getElementById('prepMealFormActiveRow').hidden = !admin;
  document.getElementById('prepMealAiSection').hidden = !admin;
  if (!admin) document.getElementById('prepMealImageCropSection').hidden = true;
  document.getElementById('btnDeletePrepMeal').hidden = !existingMeal;
  document.getElementById('prepMealEditorOverlay').hidden = false;
}

function closePrepMealEditor() {
  document.getElementById('prepMealEditorOverlay').hidden = true;
}

// Drops an AI meal-menu result into the editor form. AI returns per-100g
// rates, so the serving declaration is pinned back to 100g to match.
function applyPrepMealAiResult(data) {
  document.getElementById('prepMealFormServing').value = 100;
  prepMealEditorServing = 100;
  if (data.name) document.getElementById('prepMealFormName').value = data.name;
  if (data.calories) document.getElementById('prepMealFormCalories').value = Math.round(data.calories);
  if (data.protein) document.getElementById('prepMealFormProtein').value = Math.round(data.protein);
  if (data.carbs) document.getElementById('prepMealFormCarbs').value = Math.round(data.carbs);
  if (data.fat) document.getElementById('prepMealFormFat').value = Math.round(data.fat);
  if (data.fiber) document.getElementById('prepMealFormFiber').value = Math.round(data.fiber);
  if (data.sodium) document.getElementById('prepMealFormSodium').value = Math.round(data.sodium);
  if (data.ingredients) document.getElementById('prepMealFormIngredients').value = data.ingredients;
  if (data.procedure) document.getElementById('prepMealFormProcedure').value = data.procedure;
}

async function fillPrepMealFromAi() {
  const note = document.getElementById('prepMealAiNote');
  const text = document.getElementById('prepMealAiText').value.trim();
  const url = document.getElementById('prepMealAiUrl').value.trim();
  if (!text && !url) { note.textContent = 'Paste a menu/recipe, enter a URL, or upload a photo first.'; return; }
  note.textContent = 'Reading…';
  try {
    const data = await estimatePrepMealFromMenu({ mealMenuText: text || undefined, mealMenuUrl: !text ? url : undefined });
    applyPrepMealAiResult(data);
    note.textContent = 'Filled in (per 100g) — review before saving.';
  } catch (e) {
    note.textContent = e.message || 'Auto-fill failed.';
  }
}

async function fillPrepMealFromAiPhoto(file) {
  const note = document.getElementById('prepMealAiNote');
  const preview = document.getElementById('prepMealAiPhotoPreview');
  note.textContent = 'Reading photo…';
  try {
    const { dataUrl } = await resizeAndCompressImage(file);
    preview.src = dataUrl;
    preview.hidden = false;
    note.textContent = 'Analyzing photo with AI…';
    // dataUrl is "data:image/jpeg;base64,<bytes>" — Gemini wants just the bytes.
    const rawBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const data = await estimatePrepMealFromMenu({ mealMenuImageBase64: rawBase64, mealMenuImageMimeType: 'image/jpeg' });
    applyPrepMealAiResult(data);
    note.textContent = 'Filled in from photo (per 100g) — review before saving.';
  } catch (e) {
    note.textContent = e.message || 'Photo auto-fill failed.';
  }
}

// Keeps the Food Prep Options widget's slideshow stocked with admin-set
// meal photos automatically — every prep meal image an admin sets gets
// folded into media_sync_settings.image_urls (deduped), switching the
// widget to slideshow mode once there's more than one image to cycle.
async function addImageToMediaSyncSlideshow(imageUrl, oldImageUrl) {
  try {
    const settings = await fetchMediaSyncSettings();
    const current = settings || { mode: 'still', image_urls: [], duration_sec: 10, randomize: false };
    // If this meal's photo changed, drop the old URL first — otherwise the
    // replaced photo lingers in the slideshow forever with no meal to match
    // its name tag against.
    let urls = (oldImageUrl && oldImageUrl !== imageUrl) ? current.image_urls.filter(u => u !== oldImageUrl) : current.image_urls;
    if (urls.includes(imageUrl)) {
      if (urls.length === current.image_urls.length) return; // nothing actually changed
    } else {
      urls = [...urls, imageUrl];
    }
    const newMode = urls.length > 1 ? 'slideshow' : current.mode;
    await sb.rpc('admin_set_media_sync', {
      p_digital_id: adminSession.digitalId, p_password: adminSession.password,
      p_mode: newMode, p_image_urls: urls, p_duration_sec: current.duration_sec, p_randomize: current.randomize,
    });
    await renderMediaSyncWidget();
  } catch (e) { /* best effort — slideshow just won't pick up this image until the next successful save */ }
}

async function savePrepMealEditor() {
  const note = document.getElementById('prepMealFormNote');
  const idVal = document.getElementById('prepMealFormId').value;
  const category = document.getElementById('prepMealFormCategory').value;
  const name = document.getElementById('prepMealFormName').value.trim();
  // Fields hold nutrition for the declared serving — convert to per-100g
  // rates for storage (grams is the multiplier: perServing / grams * 100).
  const servingGrams = Number(document.getElementById('prepMealFormServing').value) || 100;
  const toPer100 = v => Math.round((v / servingGrams) * 100 * 10) / 10;
  const calPer100g = toPer100(Number(document.getElementById('prepMealFormCalories').value) || 0);
  const proteinPer100g = toPer100(Number(document.getElementById('prepMealFormProtein').value) || 0);
  const carbsPer100g = toPer100(Number(document.getElementById('prepMealFormCarbs').value) || 0);
  const fatPer100g = toPer100(Number(document.getElementById('prepMealFormFat').value) || 0);
  const fiberPer100g = toPer100(Number(document.getElementById('prepMealFormFiber').value) || 0);
  const sodiumPer100g = toPer100(Number(document.getElementById('prepMealFormSodium').value) || 0);
  const ingredients = document.getElementById('prepMealFormIngredients').value.trim();
  const procedure = document.getElementById('prepMealFormProcedure').value.trim();
  if (!name || !ingredients || !calPer100g) { note.textContent = 'Fill in at least name, ingredients, and calories.'; return; }
  note.textContent = 'Saving…';
  try {
    if (isAdminLoggedIn()) {
      const active = document.getElementById('prepMealFormActive').checked;
      const imageUrl = document.getElementById('prepMealFormImageUrl').value.trim();
      const { error } = await sb.rpc('admin_upsert_prep_meal', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password,
        p_id: idVal ? Number(idVal) : null, p_category: category, p_name: name, p_ingredients: ingredients, p_procedure: procedure,
        p_cal_per_100g: calPer100g, p_protein_per_100g: proteinPer100g, p_carbs_per_100g: carbsPer100g, p_fat_per_100g: fatPer100g,
        p_fiber_per_100g: fiberPer100g, p_sodium_per_100g: sodiumPer100g,
        p_active: active, p_image_url: imageUrl,
        p_image_zoom: prepMealCropState.zoom, p_image_pos_x: Math.round(prepMealCropState.x), p_image_pos_y: Math.round(prepMealCropState.y),
      });
      if (error) throw error;
      note.textContent = 'Saved.';
      if (imageUrl) await addImageToMediaSyncSlideshow(imageUrl, prepMealEditorOriginalImageUrl);
    } else {
      // Self-service submission: saves immediately, visible to this user
      // right away, public only once the admin approves (ownership and
      // the pending flag are enforced server-side).
      const { error } = await sb.rpc('user_upsert_prep_meal', {
        p_share_key: getOrCreateShareKey(), p_author_name: effectiveLeaderboardName(),
        p_id: idVal ? Number(idVal) : null, p_category: category, p_name: name, p_ingredients: ingredients, p_procedure: procedure,
        p_cal_per_100g: calPer100g, p_protein_per_100g: proteinPer100g, p_carbs_per_100g: carbsPer100g, p_fat_per_100g: fatPer100g,
        p_fiber_per_100g: fiberPer100g, p_sodium_per_100g: sodiumPer100g,
      });
      if (error) throw error;
      note.textContent = 'Saved — visible to you now; it goes public once the admin approves it.';
    }
    prepMealsCache = await fetchPrepMeals();
    refreshOpenFoodPrepsScreen(idVal);
    if (isAdminLoggedIn()) renderPrepMealManager();
    setTimeout(closePrepMealEditor, isAdminLoggedIn() ? 700 : 1600);
  } catch (e) {
    note.textContent = 'Failed: ' + (e.message || 'you\'re offline.');
  }
}

async function deletePrepMealEditor() {
  const note = document.getElementById('prepMealFormNote');
  const idVal = document.getElementById('prepMealFormId').value;
  if (!idVal) return;
  if (!confirm('Delete this prep meal?')) return;
  try {
    if (isAdminLoggedIn()) {
      await sb.rpc('admin_delete_prep_meal', { p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_id: Number(idVal) });
    } else {
      await sb.rpc('user_delete_prep_meal', { p_share_key: getOrCreateShareKey(), p_id: Number(idVal) });
    }
    prepMealsCache = await fetchPrepMeals();
    foodPrepsDetailMeal = null;
    refreshOpenFoodPrepsScreen();
    if (isAdminLoggedIn()) renderPrepMealManager();
    closePrepMealEditor();
  } catch (e) { note.textContent = 'Could not delete.'; }
}

// Last-applied serving grams in the editor — the anchor the nutrition
// fields rescale from when the admin changes the serving size (fields
// always represent nutrition for the serving currently declared).
let prepMealEditorServing = 100;
// The meal's image_url as the editor opened it — lets savePrepMealEditor
// tell the slideshow to swap the old photo for the new one instead of just
// appending, so an edited image doesn't leave a stale, unnamed orphan
// cycling in the slideshow alongside the replacement.
let prepMealEditorOriginalImageUrl = '';
const PREP_MEAL_NUTRITION_FIELD_IDS = ['prepMealFormCalories', 'prepMealFormProtein', 'prepMealFormCarbs', 'prepMealFormFat', 'prepMealFormFiber', 'prepMealFormSodium'];

function rescalePrepMealNutritionFields(newGrams) {
  if (!newGrams || newGrams <= 0 || newGrams === prepMealEditorServing) return;
  const ratio = newGrams / prepMealEditorServing;
  PREP_MEAL_NUTRITION_FIELD_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el.value === '') return;
    const v = Number(el.value);
    if (!isFinite(v)) return;
    el.value = Math.round(v * ratio * 10) / 10;
  });
  prepMealEditorServing = newGrams;
}

/* Image framing controls in the editor — a live 16:9 preview the admin
   drags to move the focal point and zooms with a slider. Saved as
   image_zoom/image_pos_x/image_pos_y and applied wherever the meal's
   image renders (see prepMealImageStyle above). */
let prepMealCropState = { zoom: 1, x: 50, y: 50 };

function applyPrepMealCropPreview() {
  const img = document.getElementById('prepMealCropImg');
  const s = prepMealCropState;
  img.style.objectPosition = `${s.x}% ${s.y}%`;
  img.style.transform = `scale(${s.zoom})`;
  img.style.transformOrigin = `${s.x}% ${s.y}%`;
  document.getElementById('prepMealZoomValue').textContent = s.zoom.toFixed(1) + 'x';
  document.getElementById('prepMealZoomSlider').value = Math.round(s.zoom * 100);
}

function refreshPrepMealCropSection() {
  const url = document.getElementById('prepMealFormImageUrl').value.trim();
  const section = document.getElementById('prepMealImageCropSection');
  section.hidden = !url;
  if (url) {
    document.getElementById('prepMealCropImg').src = url;
    applyPrepMealCropPreview();
  }
}

function initPrepMealCropControls() {
  const frame = document.getElementById('prepMealCropFrame');
  document.getElementById('prepMealFormImageUrl').addEventListener('input', refreshPrepMealCropSection);
  document.getElementById('prepMealZoomSlider').addEventListener('input', e => {
    prepMealCropState.zoom = Number(e.target.value) / 100;
    applyPrepMealCropPreview();
  });

  let dragging = null;
  frame.addEventListener('pointerdown', e => {
    dragging = { startX: e.clientX, startY: e.clientY, x: prepMealCropState.x, y: prepMealCropState.y };
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener('pointermove', e => {
    if (!dragging) return;
    const rect = frame.getBoundingClientRect();
    // Dragging the picture right should reveal more of its left side, i.e.
    // move the focal point left — hence the inverted deltas. Dividing by
    // zoom keeps the drag feeling 1:1 with the on-screen picture.
    const dx = ((e.clientX - dragging.startX) / rect.width) * 100 / prepMealCropState.zoom;
    const dy = ((e.clientY - dragging.startY) / rect.height) * 100 / prepMealCropState.zoom;
    prepMealCropState.x = Math.max(0, Math.min(100, dragging.x - dx));
    prepMealCropState.y = Math.max(0, Math.min(100, dragging.y - dy));
    applyPrepMealCropPreview();
  });
  const endDrag = () => { dragging = null; };
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);
}

function initPrepMealEditor() {
  const overlay = document.getElementById('prepMealEditorOverlay');
  if (!overlay) return;
  document.getElementById('btnClosePrepMealEditor').addEventListener('click', closePrepMealEditor);
  bindOverlayBackdropClose(overlay, closePrepMealEditor);
  document.getElementById('btnPrepMealAiFill').addEventListener('click', fillPrepMealFromAi);
  const aiPhotoInput = document.getElementById('prepMealAiPhotoInput');
  document.getElementById('btnPrepMealAiPhoto').addEventListener('click', () => aiPhotoInput.click());
  aiPhotoInput.addEventListener('change', () => {
    const file = aiPhotoInput.files[0];
    aiPhotoInput.value = '';
    if (file) fillPrepMealFromAiPhoto(file);
  });
  document.getElementById('btnSavePrepMeal').addEventListener('click', savePrepMealEditor);
  document.getElementById('btnDeletePrepMeal').addEventListener('click', deletePrepMealEditor);
  // change (not input) so half-typed serving numbers (e.g. the "2" while
  // typing "250") don't trigger intermediate rescales of the fields.
  document.getElementById('prepMealFormServing').addEventListener('change', e => {
    rescalePrepMealNutritionFields(Number(e.target.value));
  });
  initPrepMealCropControls();
}

let chatRoomMeta = {}; // roomId -> { name, isDm, createdByKey, otherName }
let chatLastRead = {}; // roomId (or 'public') -> ISO timestamp
try { chatLastRead = JSON.parse(localStorage.getItem('wft_chat_last_read')) || {}; } catch (e) { chatLastRead = {}; }

async function refreshChatRooms() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  if (!shareKey || !sbConfigured()) { chatRoomMeta = {}; renderChatRoomOptions(); renderInvitesPopover([]); return; }
  try { await sb.rpc('cleanup_stale_solo_rooms'); } catch (e) { /* best effort, opportunistic */ }

  // Two plain queries instead of one embedded (chat_room_members -> chat_rooms)
  // select: the embedded/nested form can silently resolve a row's chat_rooms
  // to null (dropped with no error) right after a room is created, which was
  // making brand-new groups vanish from the room list. Plain .in() filtering
  // has no such failure mode.
  const { data: memberRows, error: memberErr } = await sb.from('chat_room_members')
    .select('status, room_id')
    .eq('share_key', shareKey);
  if (memberErr) { showRestToast('Could not load chat rooms: ' + memberErr.message); return; }
  const rows = memberRows || [];
  const roomIds = [...new Set(rows.map(r => r.room_id))];

  let roomsById = {};
  if (roomIds.length) {
    const { data: roomRows, error: roomErr } = await sb.from('chat_rooms')
      .select('id, name, is_dm, created_by_key')
      .in('id', roomIds);
    if (roomErr) { showRestToast('Could not load chat rooms: ' + roomErr.message); return; }
    (roomRows || []).forEach(r => { roomsById[r.id] = r; });
  }

  const joined = rows.filter(r => r.status === 'joined' && roomsById[r.room_id]);

  const dmRoomIds = joined.filter(r => roomsById[r.room_id].is_dm).map(r => r.room_id);
  const otherNameByRoom = {};
  if (dmRoomIds.length) {
    const { data: members } = await sb.from('chat_room_members')
      .select('room_id, share_key, code_name')
      .in('room_id', dmRoomIds);
    (members || []).forEach(m => {
      if (m.share_key !== shareKey) otherNameByRoom[m.room_id] = m.code_name;
    });
  }

  chatRoomMeta = {};
  joined.forEach(r => {
    const room = roomsById[r.room_id];
    chatRoomMeta[r.room_id] = {
      name: room.is_dm ? (otherNameByRoom[r.room_id] || room.name) : room.name,
      isDm: room.is_dm,
      createdByKey: room.created_by_key,
      joinedByMe: true,
    };
  });

  // Admin gets every group (never DMs) added to the room list even if they
  // never joined, so they can freely enter any group chat. Membership-only
  // actions (Leave/Invite/Members) stay gated on actually being a member —
  // see updateRoomActionButtons — this just makes the room selectable.
  if (isAdminLoggedIn()) {
    try {
      const { data: allGroups } = await sb.from('chat_rooms').select('id, name, created_by_key').eq('is_dm', false);
      (allGroups || []).forEach(g => {
        if (!chatRoomMeta[g.id]) {
          chatRoomMeta[g.id] = { name: g.name, isDm: false, createdByKey: g.created_by_key, joinedByMe: false };
        }
      });
    } catch (e) { /* best effort */ }
  }

  try { await checkUnreadMessages(dmRoomIds); } catch (e) { /* best effort — room list still renders without unread flags */ }
  renderChatRoomOptions();
  const invited = rows
    .filter(r => r.status === 'invited' && roomsById[r.room_id])
    .map(r => ({ roomId: r.room_id, roomName: roomsById[r.room_id].name }));
  renderInvitesPopover(invited);
}

function isNexusTabActive() {
  const btn = document.querySelector('.tab-btn[data-target="leaderboard"]');
  return !!(btn && btn.classList.contains('is-active'));
}

async function checkUnreadMessages(dmRoomIds) {
  const myName = effectiveLeaderboardName();
  const nexusActive = isNexusTabActive();
  let anyDmUnread = false;

  if (dmRoomIds.length) {
    const { data: msgs } = await sb.from('chat_messages')
      .select('room_id, code_name, created_at')
      .in('room_id', dmRoomIds)
      .order('created_at', { ascending: false });
    const latestByRoom = {};
    (msgs || []).forEach(m => { if (!latestByRoom[m.room_id]) latestByRoom[m.room_id] = m; });
    Object.keys(latestByRoom).forEach(roomId => {
      const m = latestByRoom[roomId];
      if (m.code_name === myName) return;
      // Currently-open DM while Nexus is on-screen counts as read immediately,
      // rather than flagging it and racing with a separate mark-read call.
      if (nexusActive && roomId === currentChatRoomId) {
        chatLastRead[roomId] = m.created_at;
        if (chatRoomMeta[roomId]) chatRoomMeta[roomId].unread = false;
        return;
      }
      const lastRead = chatLastRead[roomId];
      if (!lastRead || new Date(m.created_at) > new Date(lastRead)) {
        anyDmUnread = true;
        if (chatRoomMeta[roomId]) chatRoomMeta[roomId].unread = true;
      }
    });
    if (anyDmUnread) fireSystemNotification('Winfinity Tracker', 'You have a new direct message.');
  }

  let publicUnread = false;
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: publicMsgs } = await sb.from('chat_messages')
    .select('code_name, created_at')
    .is('room_id', null)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(1);
  const latestPublic = (publicMsgs || [])[0];
  if (latestPublic && latestPublic.code_name !== myName) {
    if (nexusActive && !currentChatRoomId) {
      chatLastRead.public = latestPublic.created_at;
    } else {
      const lastRead = chatLastRead.public;
      if (!lastRead || new Date(latestPublic.created_at) > new Date(lastRead)) publicUnread = true;
    }
  }

  localStorage.setItem('wft_chat_last_read', JSON.stringify(chatLastRead));
  document.getElementById('tabDotDm').hidden = !anyDmUnread;
  document.getElementById('tabDotPublic').hidden = !publicUnread;
  document.getElementById('chatBellDmDot').hidden = !anyDmUnread;
}

function markRoomRead(roomId) {
  chatLastRead[roomId] = new Date().toISOString();
  localStorage.setItem('wft_chat_last_read', JSON.stringify(chatLastRead));
  if (roomId === 'public') document.getElementById('tabDotPublic').hidden = true;
  else {
    if (chatRoomMeta[roomId]) chatRoomMeta[roomId].unread = false;
    const stillAnyDmUnread = Object.values(chatRoomMeta).some(m => m.isDm && m.unread);
    document.getElementById('tabDotDm').hidden = !stillAnyDmUnread;
    document.getElementById('chatBellDmDot').hidden = !stillAnyDmUnread;
  }
}

function updateRoomActionButtons(roomId) {
  const meta = roomId ? chatRoomMeta[roomId] : null;
  const shareKey = localStorage.getItem('wft_lb_share_key');
  document.getElementById('btnLeaveGroup').hidden = !(meta && meta.joinedByMe);
  document.getElementById('btnDeleteGroup').hidden = !(meta && !meta.isDm && meta.createdByKey === shareKey);
  document.getElementById('btnInviteGroup').hidden = !(meta && !meta.isDm);
  document.getElementById('btnRoomMembers').hidden = !(meta && !meta.isDm);
}

function renderChatRoomOptions() {
  const select = document.getElementById('chatRoomSelect');
  select.innerHTML = '<option value="">🌐 Public Chat</option>';
  Object.entries(chatRoomMeta)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([id, meta]) => {
      const opt = document.createElement('option');
      opt.value = id;
      const icon = meta.isDm ? '💬' : (meta.joinedByMe ? '👥' : '🛡️');
      const label = meta.isDm ? `DM: ${meta.name}` : meta.name;
      opt.textContent = `${icon} ${label}${meta.unread ? ' 🔴' : ''}`;
      select.appendChild(opt);
    });
  const stillJoined = currentChatRoomId && !!chatRoomMeta[currentChatRoomId];
  select.value = stillJoined ? currentChatRoomId : '';
  // Always resync the underlying JS variable to whatever the dropdown can
  // actually show — not just when the dropdown's *visible* value changes.
  // If a brand-new room wasn't found in this refresh (the exact bug this
  // was catching), the <select> falls back to the already-selected "Public
  // Chat" option, so its value never visibly changes even though
  // currentChatRoomId is still pointing at a room nothing can render —
  // silently redirecting every later message fetch to that dead room
  // while the UI still reads "Public Chat".
  if (!stillJoined) {
    currentChatRoomId = null;
    localStorage.removeItem('wft_chat_room');
  }
  updateRoomActionButtons(stillJoined ? currentChatRoomId : null);
}

function renderInvitesPopover(invitedRows) {
  const popover = document.getElementById('chatInvitesPopover');
  const badge = document.getElementById('chatBellBadge');
  badge.hidden = !invitedRows.length;
  badge.textContent = String(invitedRows.length);
  // Never force-close/blank the popover here — a background refresh (e.g. Sync to
  // Nexus) can call this while the user has it open, and yanking it away mid-tap
  // is exactly what made Accept/Decline feel broken. Only the bell button toggles
  // popover.hidden.
  popover.innerHTML = invitedRows.length
    ? invitedRows.map(r => `
      <div class="chat-invite-row">
        <span>🔔 Invited to "${escapeHtml(r.roomName)}"</span>
        <button type="button" class="btn btn--primary" data-accept-room="${r.roomId}">Accept</button>
        <button type="button" class="btn" data-decline-room="${r.roomId}">Decline</button>
      </div>
    `).join('')
    : '<p class="empty-note">No pending invites.</p>';
  popover.querySelectorAll('[data-accept-room]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const shareKey = localStorage.getItem('wft_lb_share_key');
      // .select() after the update so we get back the rows that were
      // actually changed — a plain update() reports "success" with zero
      // error even if the filter matched nothing, which would otherwise
      // look exactly like a stuck/unresponsive button.
      const roomId = btn.dataset.acceptRoom;
      const { data: joined, error } = await sb.rpc('accept_chat_room_invite', { p_room_id: roomId, p_share_key: shareKey });
      if (error) { showRestToast('Could not accept invite: ' + error.message); btn.disabled = false; return; }
      if (!joined) {
        showRestToast(`Accept failed — no matching invite for room ${roomId.slice(0, 8)}…. Try Refresh first.`);
        btn.disabled = false;
        return;
      }
      showRestToast('Joined the group!');
      refreshChatRooms();
    });
  });
  popover.querySelectorAll('[data-decline-room]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const shareKey = localStorage.getItem('wft_lb_share_key');
      const { data: declined, error } = await sb.rpc('decline_chat_room_invite', { p_room_id: btn.dataset.declineRoom, p_share_key: shareKey });
      if (error) { showRestToast('Could not decline invite: ' + error.message); btn.disabled = false; return; }
      if (!declined) {
        showRestToast('Could not decline — no matching invite found. Try Refresh first.');
        btn.disabled = false;
        return;
      }
      showRestToast('Invite declined.');
      refreshChatRooms();
    });
  });
}

function aggregateReactions(reactions) {
  const counts = {};
  (reactions || []).forEach(r => { counts[r.emoji] = (counts[r.emoji] || 0) + 1; });
  return counts;
}

function renderChatMessages(messages) {
  const list = document.getElementById('lbChatList');
  list.innerHTML = '';
  if (!messages.length) {
    list.innerHTML = '<p class="empty-note">No messages yet. Say hi!</p>';
    return;
  }
  const myName = effectiveLeaderboardName();
  const myShareKey = getOrCreateShareKey();
  const inDm = currentChatRoomId && chatRoomMeta[currentChatRoomId] && chatRoomMeta[currentChatRoomId].isDm;
  messages.forEach(m => {
    const isOwn = m.code_name === myName;
    const row = document.createElement('div');
    row.className = 'chat-row ' + (isOwn ? 'chat-row--own' : 'chat-row--other');
    const time = new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    // Own bubbles and 1:1 DMs skip the name label (you know who you are, and
    // the DM partner's name is already in the room header) — group chat
    // bubbles from others still need it to tell speakers apart.
    const nameHtml = (!isOwn && !inDm)
      ? `<span class="chat-name chat-name-link" data-dm-name="${escapeHtml(m.code_name)}">${escapeHtml(m.code_name)}</span>`
      : '';
    const myReaction = (m.reactions || []).find(r => r.share_key === myShareKey);
    const imageHtml = (!m.deleted && m.image_url) ? `<img class="chat-msg-image" src="${m.image_url}" alt="Shared photo" data-lightbox="${m.image_url}">` : '';
    const bubbleInner = m.deleted
      ? `<span class="chat-msg chat-msg-unsent">Unsent a message</span>`
      : `${imageHtml}<span class="chat-msg">${escapeHtml(m.message)}</span>`;
    const counts = aggregateReactions(m.reactions);
    const totalReactions = (m.reactions || []).length;
    // One small combined badge (all distinct emojis + total count) rather
    // than a pill per emoji — matches Messenger's single overlapping badge
    // instead of a row of separate chips that would collide at this size.
    const reactionsHtml = Object.keys(counts).length
      ? `<div class="chat-reactions"><span class="chat-reaction-pill${myReaction ? ' is-mine' : ''}">${Object.keys(counts).join('')}${totalReactions > 1 ? ' ' + totalReactions : ''}</span></div>`
      : '';
    const bubbleClass = 'chat-bubble' + (imageHtml ? ' chat-bubble--has-image' : '');
    row.innerHTML = `${nameHtml}<div class="chat-bubble-line"><div class="${bubbleClass}" data-msg-id="${m.id}" data-deleted="${m.deleted ? 1 : 0}" data-own="${isOwn ? 1 : 0}" data-my-reaction="${myReaction ? myReaction.emoji : ''}">${bubbleInner}${reactionsHtml}</div><span class="chat-time">${time}</span></div>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-dm-name]').forEach(el => {
    el.addEventListener('click', e => openChatUserMenu(el.dataset.dmName, e.clientX, e.clientY));
  });
  list.querySelectorAll('[data-lightbox]').forEach(img => {
    img.addEventListener('click', e => { e.stopPropagation(); openChatLightbox(img.dataset.lightbox); });
  });
  list.scrollTop = list.scrollHeight;
}

function openChatLightbox(src) {
  document.getElementById('chatLightboxImg').src = src;
  document.getElementById('chatLightbox').hidden = false;
}
function closeChatLightbox() {
  document.getElementById('chatLightbox').hidden = true;
  document.getElementById('chatLightboxImg').src = '';
}

/* ---- Press-and-hold a chat bubble: emoji reactions + unsend ---- */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
let chatReactionTargetId = null;

function closeChatReactionMenu() {
  document.getElementById('chatReactionMenu').hidden = true;
  chatReactionTargetId = null;
}

function openChatReactionMenu(bubble, x, y) {
  const messageId = Number(bubble.dataset.msgId);
  const isOwn = bubble.dataset.own === '1';
  const myReaction = bubble.dataset.myReaction || '';
  chatReactionTargetId = messageId;
  const menu = document.getElementById('chatReactionMenu');
  const emojiRow = `<div class="chat-reaction-emoji-row">${QUICK_REACTIONS.map(e =>
    `<button type="button" class="chat-reaction-emoji-btn${myReaction === e ? ' is-active' : ''}" data-emoji="${e}">${e}</button>`
  ).join('')}</div>`;
  const unsendBtn = isOwn ? `<button type="button" class="chat-room-menu-item chat-room-menu-item--danger" id="btnUnsendChat">Unsend</button>` : '';
  menu.innerHTML = emojiRow + unsendBtn;
  menu.hidden = false;
  const menuWidth = 240;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 12)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 140)) + 'px';
}

// shareKeyOverride/onDone let the desktop dashboard reuse this against its
// own signed-in identity and its own chat list re-render instead of the
// mobile Nexus tab's — see postChatMessage above for the same pattern.
async function setChatReaction(messageId, emoji, shareKeyOverride, onDone) {
  if (!sbConfigured()) return;
  try {
    await sb.rpc('set_chat_reaction', { p_message_id: messageId, p_share_key: shareKeyOverride || getOrCreateShareKey(), p_emoji: emoji });
    if (onDone) await onDone(); else renderChatMessages(await fetchChatMessages());
  } catch (e) { showRestToast('Could not update reaction.'); }
}

async function unsendChatMessage(messageId, shareKeyOverride, onDone) {
  if (!confirm('Unsend this message? Others will see "Unsent a message" instead.')) return;
  if (!sbConfigured()) return;
  try {
    await sb.rpc('unsend_chat_message', { p_message_id: messageId, p_share_key: shareKeyOverride || getOrCreateShareKey() });
    if (onDone) await onDone(); else renderChatMessages(await fetchChatMessages());
    showRestToast('Message unsent.');
  } catch (e) { showRestToast('Could not unsend message.'); }
}

// Event-delegated on the persistent #lbChatList container (bound once) so it
// keeps working across every renderChatMessages() re-render, which replaces
// the bubbles' innerHTML but not the container itself.
function bindChatLongPress(list) {
  const HOLD_MS = 450;
  let pressTimer = null;
  const start = (bubble, x, y) => {
    if (bubble.dataset.deleted === '1') return;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      if (navigator.vibrate) navigator.vibrate(15);
      openChatReactionMenu(bubble, x, y);
    }, HOLD_MS);
  };
  const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  list.addEventListener('touchstart', e => {
    const bubble = e.target.closest('.chat-bubble');
    if (!bubble) return;
    const t = e.touches[0];
    start(bubble, t.clientX, t.clientY);
  }, { passive: true });
  list.addEventListener('touchend', cancel);
  list.addEventListener('touchmove', cancel);
  list.addEventListener('mousedown', e => {
    const bubble = e.target.closest('.chat-bubble');
    if (!bubble) return;
    start(bubble, e.clientX, e.clientY);
  });
  list.addEventListener('mouseup', cancel);
  list.addEventListener('mouseleave', cancel);
}

// Double-tap/double-click a bubble as a quicker alternative to the
// press-and-hold above — dblclick fires naturally on both touch and mouse,
// so no custom tap-timing tracking is needed.
function bindChatDoubleTap(list) {
  list.addEventListener('dblclick', e => {
    const bubble = e.target.closest('.chat-bubble');
    if (!bubble || bubble.dataset.deleted === '1') return;
    if (navigator.vibrate) navigator.vibrate(15);
    openChatReactionMenu(bubble, e.clientX, e.clientY);
  });
}

function initChatReactionMenu() {
  bindChatLongPress(document.getElementById('lbChatList'));
  bindChatDoubleTap(document.getElementById('lbChatList'));
  document.getElementById('chatReactionMenu').addEventListener('click', e => {
    const emojiBtn = e.target.closest('.chat-reaction-emoji-btn');
    if (emojiBtn) {
      const isActive = emojiBtn.classList.contains('is-active');
      const messageId = chatReactionTargetId;
      closeChatReactionMenu();
      setChatReaction(messageId, isActive ? null : emojiBtn.dataset.emoji);
      return;
    }
    if (e.target.id === 'btnUnsendChat') {
      const messageId = chatReactionTargetId;
      closeChatReactionMenu();
      unsendChatMessage(messageId);
    }
  });
  document.addEventListener('click', e => {
    const menu = document.getElementById('chatReactionMenu');
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('.chat-bubble')) closeChatReactionMenu();
  });
}

async function startDM(otherName) {
  if (!sbConfigured()) return;
  const shareKey = getOrCreateShareKey();
  try {
    const { data, error } = await sb.rpc('start_dm_by_name', {
      p_my_key: shareKey,
      p_my_name: effectiveLeaderboardName(),
      p_other_name: otherName,
    });
    if (error) throw error;
    if (!data) { showRestToast(`Couldn't find "${otherName}" — they may not be synced to Nexus.`); return; }
    currentChatRoomId = data;
    localStorage.setItem('wft_chat_room', data);
    await refreshChatRooms();
    document.getElementById('chatRoomSelect').value = data;
    markRoomRead(data);
    updateRoomActionButtons(data);
    const messages = await fetchChatMessages();
    renderChatMessages(messages);
  } catch (e) { showRestToast('Could not start DM: ' + (e.message || 'check your connection')); }
}

/* ---- Tapping a name in chat: DM or invite to a group I created ---- */
let chatUserMenuTarget = null;

function closeChatUserMenu() {
  document.getElementById('chatUserMenu').hidden = true;
  document.getElementById('chatUserMenuGroups').hidden = true;
  document.getElementById('chatUserMenuMain').hidden = false;
}

function openChatUserMenu(name, x, y) {
  chatUserMenuTarget = name;
  const menu = document.getElementById('chatUserMenu');
  document.getElementById('chatUserMenuName').textContent = name;
  document.getElementById('chatUserMenuGroups').hidden = true;
  document.getElementById('chatUserMenuMain').hidden = false;
  menu.hidden = false;
  const menuWidth = 220;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 12)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - 160)) + 'px';
}

function renderChatUserMenuGroups() {
  const shareKey = localStorage.getItem('wft_lb_share_key');
  const myGroups = Object.entries(chatRoomMeta).filter(([id, m]) => !m.isDm && m.createdByKey === shareKey);
  const container = document.getElementById('chatUserMenuGroups');
  container.innerHTML = myGroups.length
    ? myGroups.map(([id, m]) => `<button type="button" class="chat-room-menu-item" data-invite-room="${id}">${escapeHtml(m.name)}</button>`).join('')
    : '<p class="empty-note">You haven\'t created a group yet.</p>';
  container.querySelectorAll('[data-invite-room]').forEach(btn => {
    btn.addEventListener('click', () => inviteUserToRoom(chatUserMenuTarget, btn.dataset.inviteRoom));
  });
}

async function inviteUserToRoom(name, roomId) {
  closeChatUserMenu();
  if (!sbConfigured()) return;
  try {
    const { data: row, error: lookupErr } = await sb.from('leaderboard').select('public_id').eq('code_name', name).maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row || !row.public_id) { showRestToast(`Couldn't find a Digital ID for "${name}".`); return; }
    const shareKey = getOrCreateShareKey();
    const roomName = chatRoomMeta[roomId] ? chatRoomMeta[roomId].name : 'the group';
    const { error } = await sb.rpc('invite_to_chat_room', {
      p_room_id: roomId, p_inviter_key: shareKey, p_invitee_ids: [row.public_id],
    });
    if (error) throw error;
    showRestToast(`Invited ${name} to "${roomName}".`);
  } catch (e) { showRestToast('Could not send invite: ' + (e.message || 'check your connection')); }
}

async function copyChatUserDigitalId(name) {
  if (!sbConfigured()) return;
  try {
    const { data: row, error } = await sb.from('leaderboard').select('public_id').eq('code_name', name).maybeSingle();
    if (error) throw error;
    if (!row || !row.public_id) { showRestToast(`"${name}" doesn't have a Digital ID synced yet.`); return; }
    if (!navigator.clipboard) { showRestToast(`Digital ID: ${row.public_id}`); return; }
    await navigator.clipboard.writeText(row.public_id);
    showRestToast(`Copied ${name}'s Digital ID!`);
  } catch (e) { showRestToast('Could not copy Digital ID: ' + (e.message || 'check your connection')); }
}

function initChatUserMenu() {
  document.getElementById('btnChatUserDm').addEventListener('click', () => {
    const name = chatUserMenuTarget;
    closeChatUserMenu();
    startDM(name);
  });
  document.getElementById('btnChatUserInvite').addEventListener('click', () => {
    document.getElementById('chatUserMenuMain').hidden = true;
    renderChatUserMenuGroups();
    document.getElementById('chatUserMenuGroups').hidden = false;
  });
  document.getElementById('btnChatUserCopyId').addEventListener('click', () => {
    const name = chatUserMenuTarget;
    closeChatUserMenu();
    copyChatUserDigitalId(name);
  });
  document.addEventListener('click', e => {
    const menu = document.getElementById('chatUserMenu');
    if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-dm-name]')) closeChatUserMenu();
  });
}

/* ---- Group members panel (creator can kick) ---- */
async function renderRoomMembers() {
  const list = document.getElementById('roomMembersList');
  if (!currentChatRoomId || !sbConfigured()) { list.innerHTML = ''; return; }
  const shareKey = localStorage.getItem('wft_lb_share_key');
  const meta = chatRoomMeta[currentChatRoomId];
  const isCreator = !!(meta && meta.createdByKey === shareKey);
  list.innerHTML = '<p class="empty-note">Loading…</p>';
  try {
    const { data, error } = await sb.from('chat_room_members')
      .select('share_key, code_name')
      .eq('room_id', currentChatRoomId)
      .eq('status', 'joined');
    if (error) throw error;
    const members = data || [];
    list.innerHTML = members.length
      ? members.map(m => `
        <div class="chat-invite-row">
          <span>${escapeHtml(m.code_name)}${m.share_key === shareKey ? ' (you)' : ''}</span>
          ${isCreator && m.share_key !== shareKey ? `<button type="button" class="btn" data-kick-key="${m.share_key}">Kick</button>` : ''}
        </div>
      `).join('')
      : '<p class="empty-note">No members yet.</p>';
    list.querySelectorAll('[data-kick-key]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this member from the group?')) return;
        btn.disabled = true;
        try {
          const { error: kickErr } = await sb.rpc('kick_chat_room_member', {
            p_room_id: currentChatRoomId, p_requester_key: shareKey, p_target_share_key: btn.dataset.kickKey,
          });
          if (kickErr) throw kickErr;
          showRestToast('Member removed.');
          renderRoomMembers();
        } catch (e) { showRestToast('Could not remove member: ' + (e.message || '')); btn.disabled = false; }
      });
    });
  } catch (e) { list.innerHTML = '<p class="empty-note">Could not load members.</p>'; }
}

async function updateLeaderboard() {
  const note = document.getElementById('lbSaveNote');
  note.textContent = 'Syncing…';
  try {
    // Never push auto-seeded sample stats to the public leaderboard — a
    // brand-new user who hasn't logged anything real yet would otherwise
    // show up in rankings with fake numbers the moment they hit Sync.
    const isDemo = isDemoDataActive();
    if (localStorage.getItem('wft_lb_optin') === '1' && !isDemo) await pushLeaderboardEntry();
    const rows = await pullLeaderboard();
    renderNexusRankings(rows);
    await refreshChatRooms();
    const messages = await fetchChatMessages();
    renderChatMessages(messages);
    note.textContent = isDemo
      ? 'Synced — stats not shared yet (you\'re still viewing sample demo data). Log something real or clear it in Settings to share your own.'
      : 'Synced ' + new Date().toLocaleTimeString();
    maybeAutoApplyUpdate();
  } catch (e) {
    note.textContent = 'Sync failed: ' + (e.message || 'check your connection');
  }
}

/* ---------------------------------------------------------------- */
/* Nexus announcement (single admin, verified entirely server-side —    */
/* the credentials never ship in this file or config.js)               */
/* ---------------------------------------------------------------- */
// Kept in localStorage on this device only, so the admin stays logged in
// across reloads/updates until they explicitly log out — never shipped in
// app.js/index.html/config.js, so it's still invisible to anyone just
// viewing page source. Every write is still re-verified server-side by the
// verify_admin_login / set_announcement Supabase RPCs regardless.
let adminSession = { digitalId: null, password: null };
try {
  const savedAdmin = JSON.parse(localStorage.getItem('wft_admin_session'));
  if (savedAdmin && savedAdmin.digitalId && savedAdmin.password) adminSession = savedAdmin;
} catch (e) { /* ignore malformed/missing saved session */ }
let currentAnnouncementText = '';

function isAdminLoggedIn() { return !!adminSession.password; }

// Two identical copies laid out side by side, animated -50% and looped —
// speed is set from the measured text width so it always scrolls at a
// constant pace instead of a fixed duration that would race short messages
// and crawl through long ones.
function setMarqueeText(trackId, text) {
  const track = document.getElementById(trackId);
  if (!track) return;
  track.querySelectorAll('.announcement-marquee-text').forEach(span => { span.textContent = text; });
  const singleWidth = track.children[0] ? track.children[0].getBoundingClientRect().width : 0;
  const pxPerSecond = 55;
  track.style.animationDuration = Math.max(6, singleWidth / pxPerSecond) + 's';
}

function renderAnnouncement(message) {
  currentAnnouncementText = message || '';
  setMarqueeText('announcementMarquee', currentAnnouncementText || 'No announcements yet.');

  // Top-of-page strip (under the header, above every tab): only exists at
  // all when there's a real announcement — no placeholder text, no empty
  // strip taking up space when there's nothing to show.
  const globalStrip = document.getElementById('globalAnnouncementStrip');
  if (globalStrip) {
    globalStrip.hidden = !currentAnnouncementText;
    if (currentAnnouncementText) setMarqueeText('globalAnnouncementMarquee', currentAnnouncementText);
  }
}

async function loadAnnouncement() {
  if (!sbConfigured()) return;
  try {
    const { data, error } = await sb.from('announcements').select('message').eq('id', 1).maybeSingle();
    if (error) throw error;
    renderAnnouncement(data && data.message);
  } catch (e) { showRestToast('Could not load announcement: ' + (e.message || 'check your connection')); }
}

function refreshAnnouncementMenuState() {
  const loggedIn = isAdminLoggedIn();
  document.getElementById('btnAdminLogin').hidden = loggedIn;
  document.getElementById('btnAdminPost').hidden = !loggedIn;
  document.getElementById('btnAdminAssignTargets').hidden = !loggedIn;
  document.getElementById('btnAdminLogout').hidden = !loggedIn;
  refreshDigitalIdOverrideVisibility();
}

function initAnnouncementWidget() {
  const menuBtn = document.getElementById('btnAnnouncementMenu');
  const menu = document.getElementById('announcementMenu');
  refreshAnnouncementMenuState();

  menuBtn.addEventListener('click', () => { menu.hidden = !menu.hidden; });
  document.addEventListener('click', e => {
    if (!menu.hidden && !e.target.closest('.announcement-menu-wrap')) menu.hidden = true;
  });

  document.getElementById('btnAdminLogin').addEventListener('click', () => {
    menu.hidden = true;
    document.getElementById('adminLoginNote').textContent = '';
    document.getElementById('adminLoginId').value = '';
    document.getElementById('adminLoginPassword').value = '';
    document.getElementById('adminLoginOverlay').hidden = false;
  });
  document.getElementById('btnAdminLogout').addEventListener('click', () => {
    if (!confirm('Log out of admin?')) return;
    adminSession = { digitalId: null, password: null };
    localStorage.removeItem('wft_admin_session');
    menu.hidden = true;
    refreshAnnouncementMenuState();
    refreshChatRooms();
    showRestToast('Logged out of admin.');
  });
  document.getElementById('btnAdminPost').addEventListener('click', () => {
    menu.hidden = true;
    document.getElementById('adminPostText').value = currentAnnouncementText;
    document.getElementById('adminPostNote').textContent = '';
    document.getElementById('adminPostOverlay').hidden = false;
  });
  document.getElementById('btnAdminAssignTargets').addEventListener('click', () => {
    menu.hidden = true;
    ['adminAssignTargetId', 'adminAssignCalorie', 'adminAssignSteps', 'adminAssignWorkouts', 'adminAssignRefeedCalories', 'adminAssignRefeedStart', 'adminAssignRefeedEnd', 'adminAssignSocialLinks'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('adminAssignTargetsNote').textContent = '';
    document.getElementById('adminAssignTargetsOverlay').hidden = false;
  });

  const loginOverlay = document.getElementById('adminLoginOverlay');
  document.getElementById('btnCloseAdminLogin').addEventListener('click', () => { loginOverlay.hidden = true; });
  loginOverlay.addEventListener('click', e => { if (e.target === loginOverlay) loginOverlay.hidden = true; });

  document.getElementById('btnAdminLoginSubmit').addEventListener('click', async () => {
    const id = document.getElementById('adminLoginId').value.trim();
    const pw = document.getElementById('adminLoginPassword').value;
    const noteEl = document.getElementById('adminLoginNote');
    if (!id || !pw) { noteEl.textContent = 'Enter both Digital ID and password.'; return; }
    if (!sbConfigured()) { noteEl.textContent = 'Not available offline.'; return; }
    noteEl.textContent = 'Checking…';
    try {
      const { data, error } = await sb.rpc('verify_admin_login', { p_digital_id: id, p_password: pw });
      if (error) throw error;
      if (data === true) {
        adminSession = { digitalId: id, password: pw };
        localStorage.setItem('wft_admin_session', JSON.stringify(adminSession));
        loginOverlay.hidden = true;
        refreshAnnouncementMenuState();
        refreshChatRooms();
        showRestToast('Admin unlocked.');
      } else {
        noteEl.textContent = 'Incorrect Digital ID or password.';
      }
    } catch (e) {
      noteEl.textContent = 'Login failed — try again.';
    }
  });

  const postOverlay = document.getElementById('adminPostOverlay');
  document.getElementById('btnCloseAdminPost').addEventListener('click', () => { postOverlay.hidden = true; });
  postOverlay.addEventListener('click', e => { if (e.target === postOverlay) postOverlay.hidden = true; });

  document.getElementById('btnAdminPostSubmit').addEventListener('click', async () => {
    const noteEl = document.getElementById('adminPostNote');
    if (!isAdminLoggedIn()) { noteEl.textContent = 'Not logged in.'; return; }
    const message = document.getElementById('adminPostText').value.trim();
    noteEl.textContent = 'Posting…';
    try {
      const { error } = await sb.rpc('set_announcement', {
        p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_message: message,
      });
      if (error) throw error;
      renderAnnouncement(message);
      postOverlay.hidden = true;
      showRestToast('Announcement posted.');
    } catch (e) {
      noteEl.textContent = 'Failed to post — try again.';
    }
  });

  const assignOverlay = document.getElementById('adminAssignTargetsOverlay');
  document.getElementById('btnCloseAdminAssignTargets').addEventListener('click', () => { assignOverlay.hidden = true; });
  assignOverlay.addEventListener('click', e => { if (e.target === assignOverlay) assignOverlay.hidden = true; });

  document.getElementById('btnAdminAssignTargetsSubmit').addEventListener('click', async () => {
    const noteEl = document.getElementById('adminAssignTargetsNote');
    if (!isAdminLoggedIn()) { noteEl.textContent = 'Not logged in.'; return; }
    const targetId = document.getElementById('adminAssignTargetId').value.trim();
    if (!targetId) { noteEl.textContent = "Enter the user's Digital ID."; return; }
    const refeedStart = document.getElementById('adminAssignRefeedStart').value || null;
    const refeedEnd = document.getElementById('adminAssignRefeedEnd').value || null;
    if (refeedStart && refeedEnd && refeedStart > refeedEnd) {
      noteEl.textContent = 'Refeed start date must be on or before the end date.';
      return;
    }
    const socialLinksSel = document.getElementById('adminAssignSocialLinks').value;
    const showSocialLinks = socialLinksSel === 'show' ? true : socialLinksSel === 'hide' ? false : null;
    noteEl.textContent = 'Assigning…';
    try {
      const { error } = await sb.rpc('assign_targets', {
        p_admin_digital_id: adminSession.digitalId,
        p_admin_password: adminSession.password,
        p_target_digital_id: targetId,
        p_calorie_target: parseIntOrNull(document.getElementById('adminAssignCalorie').value),
        p_step_goal: parseIntOrNull(document.getElementById('adminAssignSteps').value),
        p_workouts_per_week: parseIntOrNull(document.getElementById('adminAssignWorkouts').value),
        p_refeed_calories: parseIntOrNull(document.getElementById('adminAssignRefeedCalories').value),
        p_refeed_start: refeedStart,
        p_refeed_end: refeedEnd,
        p_show_social_links: showSocialLinks,
      });
      if (error) throw error;
      assignOverlay.hidden = true;
      showRestToast(`Targets assigned to ${targetId}.`);
    } catch (e) {
      noteEl.textContent = (e.message && e.message.includes('No user found'))
        ? 'No user found with that Digital ID.'
        : 'Failed to assign — try again.';
    }
  });

  loadAnnouncement();
}

function initLeaderboard() {
  const optInEl = document.getElementById('lbOptIn');
  optInEl.checked = localStorage.getItem('wft_lb_optin') === '1';
  updateCodeNameHint();

  document.querySelectorAll('.rank-share-btn').forEach(btn => {
    btn.addEventListener('click', () => shareLeaderboardCard(btn.dataset.target, btn.dataset.title));
  });

  optInEl.addEventListener('change', () => {
    if (optInEl.checked) {
      getOrCreateShareKey();
      localStorage.setItem('wft_lb_optin', '1');
    } else {
      localStorage.setItem('wft_lb_optin', '0');
      removeFromLeaderboard();
    }
    updateCodeNameHint();
  });

  document.getElementById('btnLbUpdate').addEventListener('click', () => {
    updateLeaderboard();
    if (localStorage.getItem('wft_drive_connected') && driveConfigured()) saveToDrive(false);
  });

  document.getElementById('btnLbChatSend').addEventListener('click', async () => {
    const input = document.getElementById('lbChatInput');
    if ((!input.value.trim() && !pendingChatImageDataUrl) || !sbConfigured()) return;
    const imageToSend = pendingChatImageDataUrl;
    try {
      await postChatMessage(input.value, imageToSend);
      input.value = '';
      clearPendingChatImage();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { showRestToast('Could not send: ' + (e.message || 'check your connection')); }
  });
  document.getElementById('lbChatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btnLbChatSend').click();
  });

  document.getElementById('btnChatAttachImage').addEventListener('click', () => {
    document.getElementById('chatImageInput').click();
  });
  document.getElementById('chatImageInput').addEventListener('change', () => {
    const file = document.getElementById('chatImageInput').files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      pendingChatImageDataUrl = reader.result;
      document.getElementById('chatPendingImagePreview').src = pendingChatImageDataUrl;
      document.getElementById('chatPendingImage').hidden = false;
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('btnChatPendingImageRemove').addEventListener('click', clearPendingChatImage);
  document.getElementById('chatLightbox').addEventListener('click', closeChatLightbox);
  document.getElementById('chatLightboxImg').addEventListener('click', e => e.stopPropagation());
  document.getElementById('chatLightboxClose').addEventListener('click', closeChatLightbox);

  document.getElementById('btnChatRefresh').addEventListener('click', async () => {
    const refreshBtn = document.getElementById('btnChatRefresh');
    refreshBtn.disabled = true;
    try {
      // refreshChatRooms() always rebuilds chatRoomMeta and the invites
      // popover from a fresh query — nothing is patched in place — so a
      // room that got deleted (or an invite that got accepted/declined,
      // here or on another device) since the last refresh is dropped
      // automatically, and anything newly joined/created appears. This
      // just makes that visible with a concrete summary instead of the
      // button appearing to silently do nothing.
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
      const roomCount = Object.keys(chatRoomMeta).length;
      const inviteCount = parseInt(document.getElementById('chatBellBadge').textContent, 10) || 0;
      showRestToast(`Refreshed — ${roomCount} room${roomCount !== 1 ? 's' : ''}, ${inviteCount} pending invite${inviteCount !== 1 ? 's' : ''}.`);
    } catch (e) { showRestToast('Refresh failed: ' + (e.message || 'check your connection')); }
    refreshBtn.disabled = false;
  });

  document.getElementById('btnChatExpand').addEventListener('click', () => {
    const card = document.getElementById('chatCard');
    const btn = document.getElementById('btnChatExpand');
    const expanded = card.classList.toggle('is-expanded');
    btn.textContent = expanded ? '⤡' : '⤢';
    btn.title = expanded ? 'Minimize' : 'Expand';
    btn.setAttribute('aria-label', expanded ? 'Minimize chat' : 'Expand chat');
    if (expanded) document.getElementById('lbChatList').scrollTop = document.getElementById('lbChatList').scrollHeight;
  });

  if (!sbConfigured()) {
    document.getElementById('lbSaveNote').textContent = 'Nexus not set up yet.';
    optInEl.disabled = true;
    document.getElementById('btnLbUpdate').disabled = true;
    document.getElementById('btnLbChatSend').disabled = true;
  }

  initGroupChat();
}

let pendingInviteIds = [];
let pendingInviteToGroupIds = [];

function initGroupChat() {
  const select = document.getElementById('chatRoomSelect');
  select.addEventListener('change', async () => {
    currentChatRoomId = select.value || null;
    if (currentChatRoomId) {
      localStorage.setItem('wft_chat_room', currentChatRoomId);
      if (chatRoomMeta[currentChatRoomId] && chatRoomMeta[currentChatRoomId].isDm) markRoomRead(currentChatRoomId);
    } else {
      localStorage.removeItem('wft_chat_room');
      markRoomRead('public');
    }
    updateRoomActionButtons(currentChatRoomId);
    if (!sbConfigured()) return;
    try {
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { /* best effort */ }
  });

  document.getElementById('btnLeaveGroup').addEventListener('click', async () => {
    if (!currentChatRoomId || !sbConfigured()) return;
    if (!confirm('Leave this chat?')) return;
    const shareKey = localStorage.getItem('wft_lb_share_key');
    try {
      const { error } = await sb.rpc('leave_chat_room', { p_room_id: currentChatRoomId, p_share_key: shareKey });
      if (error) { showRestToast('Could not leave: ' + error.message); return; }
      currentChatRoomId = null;
      localStorage.removeItem('wft_chat_room');
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { showRestToast('Could not leave: ' + (e.message || 'check your connection')); }
  });

  document.getElementById('btnDeleteGroup').addEventListener('click', async () => {
    if (!currentChatRoomId || !sbConfigured()) return;
    if (!confirm('Delete this group for everyone? This cannot be undone.')) return;
    const shareKey = localStorage.getItem('wft_lb_share_key');
    try {
      const { error } = await sb.rpc('delete_chat_room', { p_room_id: currentChatRoomId, p_requester_key: shareKey });
      if (error) { showRestToast('Could not delete group: ' + error.message); return; }
      currentChatRoomId = null;
      localStorage.removeItem('wft_chat_room');
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { showRestToast('Could not delete group.'); }
  });

  const invitePanel = document.getElementById('inviteGroupPanel');
  document.getElementById('btnInviteGroup').addEventListener('click', () => {
    invitePanel.hidden = !invitePanel.hidden;
    if (!invitePanel.hidden) { pendingInviteToGroupIds = []; renderInviteToGroupChips(); }
  });
  document.getElementById('btnCancelInviteGroup').addEventListener('click', () => {
    invitePanel.hidden = true;
    document.getElementById('inviteGroupInput').value = '';
    pendingInviteToGroupIds = [];
    renderInviteToGroupChips();
  });

  const membersPanel = document.getElementById('roomMembersPanel');
  document.getElementById('btnRoomMembers').addEventListener('click', () => {
    membersPanel.hidden = !membersPanel.hidden;
    if (!membersPanel.hidden) renderRoomMembers();
  });
  document.getElementById('btnCloseRoomMembers').addEventListener('click', () => { membersPanel.hidden = true; });

  initChatUserMenu();
  initChatReactionMenu();

  const addInviteeToGroup = () => {
    const input = document.getElementById('inviteGroupInput');
    const id = input.value.trim().toUpperCase();
    if (id && !pendingInviteToGroupIds.includes(id)) pendingInviteToGroupIds.push(id);
    input.value = '';
    renderInviteToGroupChips();
  };
  document.getElementById('btnAddInviteGroup').addEventListener('click', addInviteeToGroup);
  document.getElementById('inviteGroupInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addInviteeToGroup(); }
  });

  document.getElementById('btnSendInvites').addEventListener('click', async () => {
    const note = document.getElementById('inviteGroupNote');
    if (!currentChatRoomId) return;
    if (!pendingInviteToGroupIds.length) { note.textContent = 'Add at least one Digital ID.'; return; }
    if (!sbConfigured()) { note.textContent = 'Nexus not set up yet.'; return; }
    const shareKey = getOrCreateShareKey();
    note.textContent = 'Sending…';
    try {
      const { error } = await sb.rpc('invite_to_chat_room', {
        p_room_id: currentChatRoomId,
        p_inviter_key: shareKey,
        p_invitee_ids: pendingInviteToGroupIds,
      });
      if (error) throw error;
      invitePanel.hidden = true;
      pendingInviteToGroupIds = [];
      renderInviteToGroupChips();
      note.textContent = '';
      showRestToast('Invites sent!');
    } catch (e) { note.textContent = 'Could not send invites: ' + (e.message || 'check your connection'); }
  });

  const bellBtn = document.getElementById('btnChatInvites');
  const popover = document.getElementById('chatInvitesPopover');
  bellBtn.addEventListener('click', () => { popover.hidden = !popover.hidden; });
  document.addEventListener('click', e => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== bellBtn && !bellBtn.contains(e.target)) popover.hidden = true;
  });

  const roomMenuBtn = document.getElementById('btnChatRoomMenu');
  const roomMenu = document.getElementById('chatRoomMenu');
  roomMenuBtn.addEventListener('click', () => { roomMenu.hidden = !roomMenu.hidden; });
  roomMenu.querySelectorAll('.chat-room-menu-item').forEach(item => {
    item.addEventListener('click', () => { roomMenu.hidden = true; });
  });
  document.addEventListener('click', e => {
    if (!roomMenu.hidden && !roomMenu.contains(e.target) && e.target !== roomMenuBtn && !roomMenuBtn.contains(e.target)) roomMenu.hidden = true;
  });

  const panel = document.getElementById('chatNewGroupPanel');
  document.getElementById('btnNewGroup').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) { pendingInviteIds = []; renderInviteChips(); }
  });
  document.getElementById('btnCancelGroup').addEventListener('click', () => {
    panel.hidden = true;
    document.getElementById('newGroupName').value = '';
    document.getElementById('newGroupInviteInput').value = '';
    pendingInviteIds = [];
    renderInviteChips();
  });

  const addInvitee = () => {
    const input = document.getElementById('newGroupInviteInput');
    const id = input.value.trim().toUpperCase();
    if (id && !pendingInviteIds.includes(id)) pendingInviteIds.push(id);
    input.value = '';
    renderInviteChips();
  };
  document.getElementById('btnAddInvitee').addEventListener('click', addInvitee);
  document.getElementById('newGroupInviteInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addInvitee(); }
  });

  document.getElementById('btnCreateGroup').addEventListener('click', async () => {
    const name = document.getElementById('newGroupName').value.trim();
    const note = document.getElementById('newGroupNote');
    if (!name) { note.textContent = 'Enter a group name.'; return; }
    if (!sbConfigured()) { note.textContent = 'Nexus not set up yet.'; return; }
    const shareKey = getOrCreateShareKey();
    note.textContent = 'Creating…';
    try {
      const { data, error } = await sb.rpc('create_chat_room', {
        p_name: name,
        p_creator_key: shareKey,
        p_creator_name: effectiveLeaderboardName(),
        p_invitee_ids: pendingInviteIds,
      });
      if (error) throw error;
      panel.hidden = true;
      document.getElementById('newGroupName').value = '';
      pendingInviteIds = [];
      renderInviteChips();
      note.textContent = '';
      currentChatRoomId = data;
      localStorage.setItem('wft_chat_room', data);
      await refreshChatRooms();
      const messages = await fetchChatMessages();
      renderChatMessages(messages);
    } catch (e) { note.textContent = 'Could not create group: ' + (e.message || 'check your connection'); }
  });
}

function renderInviteChips() {
  const container = document.getElementById('newGroupInviteChips');
  container.innerHTML = pendingInviteIds.map(id => `
    <span class="invite-chip">${escapeHtml(id)}<button type="button" data-remove-id="${escapeHtml(id)}" aria-label="Remove">✕</button></span>
  `).join('');
  container.querySelectorAll('[data-remove-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingInviteIds = pendingInviteIds.filter(id => id !== btn.dataset.removeId);
      renderInviteChips();
    });
  });
}

function renderInviteToGroupChips() {
  const container = document.getElementById('inviteGroupChips');
  container.innerHTML = pendingInviteToGroupIds.map(id => `
    <span class="invite-chip">${escapeHtml(id)}<button type="button" data-remove-id="${escapeHtml(id)}" aria-label="Remove">✕</button></span>
  `).join('');
  container.querySelectorAll('[data-remove-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingInviteToGroupIds = pendingInviteToGroupIds.filter(id => id !== btn.dataset.removeId);
      renderInviteToGroupChips();
    });
  });
}

/* ---------------------------------------------------------------- */
/* Onboarding (first run — borrows the real Bio/DNA profile form)      */
/* ---------------------------------------------------------------- */
// Brand-new users start on a totally empty dashboard — every graph, ring,
// and orb is blank, which doesn't show off what the app actually looks
// like once it has data. This backfills the last 7 days plus today with
// plausible sample entries (scaled to the profile's own targets, not
// generic numbers) purely so first impressions have something to look at;
// see the Clear All Data button in Settings and the welcome popup below for
// how a user gets back to a clean slate.
function generateSeedLogs(profile) {
  const wu = profile.weightUnit || 'kg';
  const startWeightKg = profile.startWeightKg || 70;
  const calorieTarget = getEffectiveCalorieTarget(profile) || 2000;
  const stepGoal = getEffectiveStepGoal(profile) || 8000;
  const waterGoal = profile.waterGoal || 3000;
  const targets = computeTargets(profile, startWeightKg);
  const proteinTarget = targets ? Math.round((targets.protein[0] + targets.protein[1]) / 2) : 120;

  const isoForOffset = (i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  const logs = {};
  for (let i = 7; i >= 0; i--) {
    const iso = isoForOffset(i);

    const weekFrac = (7 - i) / 7;
    const weightKg = round2(startWeightKg - 0.15 * weekFrac + Math.sin(i * 1.7) * 0.1);
    const steps = Math.round(stepGoal * (0.7 + Math.sin(i) * 0.22));
    const calories = Math.round(calorieTarget * (0.85 + Math.cos(i) * 0.12));
    const protein = Math.round(proteinTarget * (0.85 + (i % 3) * 0.05));
    const carbs = Math.round((calories * 0.45) / 4);
    const fat = Math.round((calories * 0.25) / 9);

    logs[iso] = {
      date: iso,
      weightKg, steps, calories, protein, carbs, fat,
      fiber: 18 + (i % 4) * 3,
      sodium: 1900 + (i % 3) * 250,
      water: Math.round(waterGoal * (0.65 + (i % 4) * 0.1)),
      sleep: 2 + (i % 3),
      stress: 2 + (i % 3),
      fatigue: 2 + ((i + 1) % 3),
      hunger: 2 + ((i + 2) % 3),
      workout: false,
    };
  }

  // Push/Pull/Legs split across 3 of the 8 days — a realistic weekly
  // routine shape (inspired by a real logged program's exercise variety)
  // rather than one token workout, with every weight scaled off the
  // profile's own starting bodyweight instead of fixed absolute numbers.
  const bw = startWeightKg;
  const mkSet = (reps, mult) => ({ reps, weightKg: round2(bw * mult), completed: true });
  const WORKOUT_SPLITS = {
    push: [
      { name: 'Bench Press', restSeconds: 150, notes: '', unit: wu, sets: [mkSet(8, 0.55), mkSet(6, 0.65), mkSet(5, 0.7)] },
      { name: 'Chest Press Machine', restSeconds: 120, notes: '', unit: wu, sets: [mkSet(12, 0.3), mkSet(10, 0.35), mkSet(10, 0.35)] },
      { name: 'Lateral Raise Machine', restSeconds: 90, notes: '', unit: wu, sets: [mkSet(15, 0.12), mkSet(12, 0.14), mkSet(10, 0.14)] },
      { name: 'Tricep Push Down', restSeconds: 90, notes: '', unit: wu, sets: [mkSet(12, 0.25), mkSet(12, 0.25), mkSet(10, 0.28)] },
    ],
    pull: [
      { name: 'Deadlift', restSeconds: 180, notes: '', unit: wu, sets: [mkSet(5, 0.9), mkSet(3, 1.0), mkSet(3, 1.05)] },
      { name: 'Lat Pull Down', restSeconds: 120, notes: '', unit: wu, sets: [mkSet(12, 0.4), mkSet(10, 0.45), mkSet(10, 0.45)] },
      { name: 'Row Machine', restSeconds: 120, notes: '', unit: wu, sets: [mkSet(10, 0.45), mkSet(10, 0.5), mkSet(8, 0.5)] },
      { name: 'Hammer Curls', restSeconds: 90, notes: '', unit: wu, sets: [mkSet(10, 0.15), mkSet(10, 0.16), mkSet(8, 0.18)] },
    ],
    legs: [
      { name: 'Squats', restSeconds: 150, notes: '', unit: wu, sets: [mkSet(10, 0.7), mkSet(8, 0.8), mkSet(6, 0.9)] },
      { name: 'Leg Press Machine', restSeconds: 120, notes: '', unit: wu, sets: [mkSet(15, 0.9), mkSet(12, 1.0), mkSet(12, 1.0)] },
      { name: 'Leg Extensions', restSeconds: 90, notes: '', unit: wu, sets: [mkSet(15, 0.2), mkSet(15, 0.2), mkSet(12, 0.22)] },
    ],
  };
  [{ i: 6, split: 'push' }, { i: 4, split: 'pull' }, { i: 1, split: 'legs' }].forEach(({ i, split }) => {
    const iso = isoForOffset(i);
    logs[iso].workout = true;
    logs[iso].exercises = WORKOUT_SPLITS[split];
  });

  // One day with body measurements + skinfolds — feeds the Body Fat orb,
  // Edema orb, and Measurement/Body Fat history tables.
  const measureIso = isoForOffset(7);
  logs[measureIso].measurements = {
    chest: 96, shoulder: 112, lBicep: 32, rBicep: 32.5,
    abdSupra: 82, stomach: 86, abdInfra: 90, hips: 98,
    lThigh: 56, rThigh: 56.5, lCalf: 37, rCalf: 37,
  };
  logs[measureIso].skinfolds = { chest: 10, abdomen: 16, thigh: 14, triceps: 11, suprailiac: 12, subscapular: 13, midaxillary: 9 };
  logs[measureIso].bodyFatPct = computeBodyFatJP7(logs[measureIso].skinfolds, profile.age, profile.gender) ?? 18;

  // One day with an outdoor cardio session — feeds Outdoor Activity Summary.
  const cardioIso = isoForOffset(3);
  logs[cardioIso].cardioSessions = [
    { type: 'run', distanceKm: 4.2, durationSec: 1560, startedAt: new Date(cardioIso + 'T07:00:00').toISOString(), maxSpeedKmh: 11.5 },
  ];

  return logs;
}

const DEMO_SEEDED_AT_KEY = 'wft_demo_seeded_at';
const DEMO_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function seedNewUserDemoData(profile) {
  if (!profile) return;
  saveLogs(generateSeedLogs(profile));
  localStorage.setItem(DEMO_SEEDED_AT_KEY, String(Date.now()));
  const overlay = document.getElementById('welcomeDemoOverlay');
  if (overlay) overlay.hidden = false;
}

// True while the current data is still exactly what was auto-seeded — the
// flag is cleared the moment any real log write happens (see
// updateLogFields) or a backup is restored, so this only stays true for a
// brand-new user who hasn't touched anything yet.
function isDemoDataActive() {
  return !!localStorage.getItem(DEMO_SEEDED_AT_KEY);
}

// Runs once per app open. If a user seeded demo data and never logged
// anything real for a full 7 days, wipe the sample data automatically —
// same effect as tapping Clear All Data, minus the confirm dialogs since
// nothing real is at risk (a user who'd logged anything real would have
// already cleared this flag via updateLogFields). Restoring a backup also
// clears the flag (see fileRestore handler), so a returning user who
// restores their real data is never affected by this.
function checkDemoDataExpiry() {
  const seededAt = localStorage.getItem(DEMO_SEEDED_AT_KEY);
  if (!seededAt) return;
  if (Date.now() - Number(seededAt) < DEMO_EXPIRY_MS) return;
  saveLogs({});
  saveReviews({});
  saveDailyReviews({});
  localStorage.removeItem(DEMO_SEEDED_AT_KEY);
  renderDashboard();
  renderHistory();
  renderMeasureHistory();
  renderBodyFatHistory();
  updateTabDots();
  showRestToast('Sample demo data cleared after a week of inactivity — ready for your real first log.');
}

function initWelcomeDemoOverlay() {
  const overlay = document.getElementById('welcomeDemoOverlay');
  const btn = document.getElementById('btnCloseWelcomeDemo');
  if (!overlay || !btn) return;
  btn.addEventListener('click', () => { overlay.hidden = true; });
}

function initClearAllData() {
  const btn = document.getElementById('btnClearAllData');
  const note = document.getElementById('clearAllDataNote');
  const keepIdCheckbox = document.getElementById('clearDataKeepDigitalId');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const keepId = keepIdCheckbox.checked;
    if (!confirm('Clear ALL logs, reviews, and history? Your Entity Identity profile is kept, but every day you\'ve logged will be gone unless you\'ve saved a backup. This cannot be undone.')) return;
    if (!keepId) {
      if (!confirm('"Keep Digital ID" is unchecked — this will ALSO permanently delete your leaderboard entry, chat messages, reminders, and coach assignment from the Nexus server, then issue you a brand-new Digital ID. This cannot be undone. Continue?')) return;
    }
    if (!confirm('Really sure? This is permanent — tap OK only if you have a backup or genuinely want to start over.')) return;

    if (!keepId) {
      const oldShareKey = localStorage.getItem('wft_lb_share_key');
      if (oldShareKey && sbConfigured()) {
        try { await sb.rpc('delete_account_data', { p_share_key: oldShareKey }); }
        catch (e) { /* best effort — local reset still proceeds even if the server call fails */ }
      }
      localStorage.removeItem('wft_lb_share_key');
      localStorage.removeItem('wft_public_id');
      localStorage.setItem('wft_lb_optin', '0');
      getOrCreateShareKey();
      getOrCreatePublicId();
    }

    saveLogs({});
    saveReviews({});
    saveDailyReviews({});
    localStorage.removeItem('wft_demo_seeded_at');
    note.textContent = keepId ? 'All data cleared. Your Entity Identity profile is untouched.' : 'All data cleared, including your Nexus server data. You now have a new Digital ID.';
    setTimeout(() => { note.textContent = ''; }, 6000);
    renderDashboard();
    renderHistory();
    renderMeasureHistory();
    renderBodyFatHistory();
    updateTabDots();
  });
}

function initOnboarding(onComplete) {
  if (getProfile()) { if (onComplete) onComplete(); return; }

  const overlay = document.getElementById('onboardingOverlay');
  const mount = document.getElementById('onboardingFormMount');
  const form = document.getElementById('setupForm');
  const originalParent = form.parentElement;
  const originalNextSibling = form.nextSibling;

  mount.appendChild(form);
  overlay.hidden = false;

  form.addEventListener('submit', () => {
    setTimeout(() => {
      const name = document.getElementById('setupName').value.trim();
      const age = document.getElementById('setupAge').value;
      const startWeight = document.getElementById('setupStartWeight').value;
      const heightOk = document.getElementById('heightCmField').hidden
        ? document.getElementById('setupHeightFt').value
        : document.getElementById('setupHeightCm').value;
      if (!name || !age || !startWeight || !heightOk) {
        alert('Please fill in at least your name, age, height, and starting weight to continue.');
        return;
      }
      if (originalNextSibling) originalParent.insertBefore(form, originalNextSibling);
      else originalParent.appendChild(form);
      overlay.hidden = true;
      seedNewUserDemoData(getProfile());
      const freshProfile = getProfile();
      freshProfile.fitnessModeChoicePending = true;
      saveProfile(freshProfile);
      if (onComplete) onComplete();
    }, 0);
  });
}

/* ---------------------------------------------------------------- */
/* Beta lock                                                            */
/* ---------------------------------------------------------------- */
const BETA_END_DATE = new Date(2026, 6, 31, 23, 59, 59); // end of day, July 31, 2026

function initBetaLock() {
  if (Date.now() < BETA_END_DATE.getTime()) return;

  document.getElementById('lockOverlay').hidden = false;
  document.getElementById('btnLockExportCSV').addEventListener('click', () => exportCSV(sortedLogsArray(), 'fitness-log-all'));
  document.getElementById('btnLockExportBackup').addEventListener('click', downloadBackupJSON);
}

/* ---------------------------------------------------------------- */
/* Review gate (honor system, unverified — see conversation notes)     */
/* ---------------------------------------------------------------- */
function initReviewGate(onComplete) {
  if (!document.getElementById('lockOverlay').hidden) return; // beta already ended, skip

  if (isCleanShareVariant() || localStorage.getItem('wft_review_confirmed')) {
    if (onComplete) onComplete();
    return;
  }

  const overlay = document.getElementById('reviewGateOverlay');
  overlay.hidden = false;
  document.getElementById('btnReviewConfirm').addEventListener('click', () => {
    localStorage.setItem('wft_review_confirmed', '1');
    overlay.hidden = true;
    if (onComplete) onComplete();
  });
}

/* ---------------------------------------------------------------- */
/* Consent gate (Privacy Policy + Terms of Service clickwrap)         */
/* ---------------------------------------------------------------- */
function initConsentGate() {
  if (localStorage.getItem('wft_consent_agreed')) return;
  if (!document.getElementById('lockOverlay').hidden) return; // beta already ended, skip

  const overlay = document.getElementById('consentGateOverlay');
  const checkbox = document.getElementById('consentCheckbox');
  const agreeBtn = document.getElementById('btnConsentAgree');
  overlay.hidden = false;

  checkbox.addEventListener('change', () => { agreeBtn.disabled = !checkbox.checked; });
  document.getElementById('btnConsentViewPrivacy').addEventListener('click', () => { document.getElementById('privacyOverlay').hidden = false; });
  document.getElementById('btnConsentViewTerms').addEventListener('click', () => { document.getElementById('termsOverlay').hidden = false; });
  agreeBtn.addEventListener('click', () => {
    if (!checkbox.checked) return;
    localStorage.setItem('wft_consent_agreed', '1');
    localStorage.setItem('wft_consent_agreed_at', new Date().toISOString());
    overlay.hidden = true;
  });
}

/* ---------------------------------------------------------------- */
/* Fitness Journey Mode (Novice / Warrior / Spartan / Demi-God)        */
/* ---------------------------------------------------------------- */
const MODE_RANK = { beginner: 0, warrior: 1, spartan: 2, demigod: 3 };
const MODE_ORDER = ['beginner', 'warrior', 'spartan', 'demigod'];
// 'beginner' stays as the internal key (stored in profiles and synced to
// the leaderboard's fitness_mode column) — only the display label says
// Novice, so existing users' saved modes keep working.
const MODE_LABEL = { beginner: 'Novice Mode', warrior: 'Warrior Mode', spartan: 'Spartan Mode', demigod: 'Demi-God Mode' };
const MODE_ICON = { beginner: 'icons/mode-beginner.png', warrior: 'icons/mode-warrior.png', spartan: 'icons/mode-spartan.png', demigod: 'icons/mode-demigod.png' };

function updateHeaderModeIcon() {
  const icon = document.getElementById('headerModeIcon');
  if (!icon) return;
  const mode = getFitnessMode();
  icon.src = MODE_ICON[mode] || MODE_ICON.demigod;
  icon.alt = MODE_LABEL[mode] || '';
  icon.title = MODE_LABEL[mode] || '';
  icon.hidden = false;
}
const MODE_UNLOCK_FEATURES = {
  warrior: ['Training Log (exercises & sets)', 'Outdoor Activity Tracker (GPS)', 'Body Measurements', 'Weekly Review', 'Progress Photo & Measurements reminder', 'Food Preps browser'],
  spartan: ['AI food/photo nutrition estimate', 'Barcode scanner'],
  demigod: ['Body Fat Percentage (caliper entry)', 'Custom Habit Protocols (Extra Habits)'],
};
// Entry points gated behind a mode — gating just the entry point (rather
// than every downstream field) is enough, since nothing past it is
// reachable through normal UI flow when it's blocked. Leaderboard/Nexus
// sync is deliberately NOT in this list — it's available at every tier.
const MODE_GATED_ELEMENTS = [
  { id: 'btnOpenTrainingLogQuick', required: 'warrior' },
  { id: 'btnToggleWeeklyReview', required: 'warrior' },
  { id: 'progressPhotoReminderEnabled', required: 'warrior' },
  { id: 'btnOpenMeasureEntry', required: 'warrior' },
  { id: 'btnMediaSyncBrowse', required: 'warrior' },
  { id: 'btnEstimateAiNutrition', required: 'spartan' },
  { id: 'btnEstimateAiPhoto', required: 'spartan' },
  { id: 'btnScanBarcode', required: 'spartan' },
  { id: 'btnToggleCaliperEntry', required: 'demigod' },
];

function getFitnessMode() {
  const p = getProfile();
  return (p && p.fitnessMode) || 'demigod';
}
function modeRank(mode) { return MODE_RANK[mode] ?? 3; }
function isModeUnlocked(requiredMode) { return modeRank(getFitnessMode()) >= MODE_RANK[requiredMode]; }

function getModeProgress() {
  const p = getProfile();
  return (p && p.modeProgress) || { target: 7, completeCount: 0, consecutiveMissed: 0, demotionWarned: false, lastProcessedDate: null };
}
function saveModeProgress(mp) {
  const p = getProfile();
  if (!p) return;
  p.modeProgress = mp;
  saveProfile(p);
}
function freshModeProgress() {
  return { target: 7, completeCount: 0, consecutiveMissed: 0, demotionWarned: false, lastProcessedDate: todayISO() };
}

// The one daily-completeness signal driving BOTH promotion progress and
// demotion risk, regardless of current mode — matches exactly the fields
// available in Beginner Mode, since those are the actual daily habits this
// system is built around (a workout or a measurement isn't a daily
// expectation the way weigh-in/sleep/steps/mood/water/food are).
function isBeginnerDayComplete(date) {
  const entry = getLogs()[date];
  if (!entry) return false;
  const meals = entry.meals || {};
  const hasFood = ['breakfast', 'lunch', 'dinner', 'snacks'].some(mt => meals[mt] && meals[mt].length);
  return entry.weightKg != null && entry.sleep != null && entry.steps != null &&
    entry.stress != null && entry.fatigue != null && entry.hunger != null &&
    entry.water != null && entry.water > 0 && hasFood;
}

function showModeTransitionPopup({ icon, title, message, features }) {
  document.getElementById('modeTransitionIcon').textContent = icon;
  document.getElementById('modeTransitionTitle').textContent = title;
  document.getElementById('modeTransitionMessage').textContent = message;
  const list = document.getElementById('modeTransitionFeatureList');
  list.innerHTML = (features || []).map(f => `<li>${escapeHtml(f)}</li>`).join('');
  document.getElementById('modeTransitionOverlay').hidden = false;
}

function promoteFitnessMode() {
  const p = getProfile();
  if (!p) return;
  const nextMode = MODE_ORDER[MODE_ORDER.indexOf(p.fitnessMode || 'beginner') + 1];
  if (!nextMode) return;
  p.fitnessMode = nextMode;
  p.modeProgress = freshModeProgress();
  saveProfile(p);
  applyModeGating();
  autoSyncLeaderboardIfOptedIn();
  showModeTransitionPopup({
    icon: '🎉',
    title: 'CONGRATULATIONS!',
    message: `You leveled up to ${MODE_LABEL[nextMode].toUpperCase()} by logging consistently. New features unlocked:`,
    features: MODE_UNLOCK_FEATURES[nextMode] || [],
  });
}

function demoteFitnessMode() {
  const p = getProfile();
  if (!p) return;
  const prevMode = MODE_ORDER[MODE_ORDER.indexOf(p.fitnessMode || 'beginner') - 1];
  if (!prevMode) return;
  p.fitnessMode = prevMode;
  p.modeProgress = freshModeProgress();
  saveProfile(p);
  applyModeGating();
  autoSyncLeaderboardIfOptedIn();
  showModeTransitionPopup({
    icon: '⚠️',
    title: 'DEMOTED',
    message: `A few too many missed logs — you've been moved back down to ${MODE_LABEL[prevMode].toUpperCase()}. Log consistently to earn your way back up.`,
    features: [],
  });
}

// Runs once per app open: catches up on every day since the last check
// (today itself doesn't count yet — it isn't over). A missed day never
// erases progress already made toward the next mode, it just pushes the
// target out by 3 days. In Warrior/Spartan, 3 consecutive missed days
// trigger a warning, and 5 trigger a demotion back down one tier.
function processDailyModeCheck() {
  const p = getProfile();
  if (!p || !p.fitnessMode) return;
  const progress = getModeProgress();
  const today = todayISO();
  if (!progress.lastProcessedDate) { saveModeProgress(Object.assign({}, progress, { lastProcessedDate: today })); return; }
  if (progress.lastProcessedDate >= today) return;

  const cursor = parseISO(progress.lastProcessedDate);
  const todayDate = parseISO(today);
  let guard = 0;
  while (cursor < todayDate && guard < 60) {
    guard++;
    const cursorISO = cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0') + '-' + String(cursor.getDate()).padStart(2, '0');
    const complete = isBeginnerDayComplete(cursorISO);
    if (complete) {
      progress.completeCount++;
      progress.consecutiveMissed = 0;
      progress.demotionWarned = false;
      if (p.fitnessMode !== 'demigod' && progress.completeCount >= progress.target) {
        promoteFitnessMode();
        return;
      }
    } else {
      if (p.fitnessMode !== 'demigod') progress.target += 3;
      if (p.fitnessMode !== 'beginner') {
        progress.consecutiveMissed++;
        if (progress.consecutiveMissed >= 5) {
          demoteFitnessMode();
          return;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  progress.lastProcessedDate = today;
  saveModeProgress(progress);

  if (p.fitnessMode !== 'beginner' && progress.consecutiveMissed >= 3 && !progress.demotionWarned) {
    progress.demotionWarned = true;
    saveModeProgress(progress);
    const daysLeft = 5 - progress.consecutiveMissed;
    showRestToast(`⚠️ ${progress.consecutiveMissed} missed log days in a row — ${daysLeft} more and you'll be demoted from ${MODE_LABEL[p.fitnessMode]}.`);
  }
}

// A once-a-day nudge (not tied to a precise midnight timer, since a PWA
// can't reliably wake itself at exact times) showing progress toward the
// next mode whenever today's log isn't complete yet.
function checkModeProgressNudge() {
  const p = getProfile();
  if (!p || !p.fitnessMode || p.fitnessMode === 'demigod') return;
  const today = todayISO();
  if (isBeginnerDayComplete(today)) return;
  const flagKey = 'wft_mode_nudge_shown_' + today;
  if (localStorage.getItem(flagKey)) return;
  localStorage.setItem(flagKey, '1');
  const progress = getModeProgress();
  const nextMode = MODE_ORDER[MODE_ORDER.indexOf(p.fitnessMode) + 1];
  showRestToast(`Progress: ${progress.completeCount}/${progress.target} days logged toward ${MODE_LABEL[nextMode]} — finish today's log to keep climbing.`);
}

function showLockedFeatureNotice() {
  showRestToast('You need to complete the conditions first to level up and unlock this feature.');
}

function applyModeGating() {
  updateHeaderModeIcon();
  MODE_GATED_ELEMENTS.forEach(({ id, required }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const locked = !isModeUnlocked(required);
    (el.closest('label') || el).classList.toggle('mode-locked-el', locked);
  });

  const trainingTabBtn = document.querySelector('.tab-btn[data-target="training"]');
  if (trainingTabBtn) trainingTabBtn.classList.toggle('mode-locked-el', !isModeUnlocked('warrior'));

  const measureSection = document.getElementById('bioMeasurementSection');
  if (measureSection) measureSection.classList.toggle('mode-locked-visual', !isModeUnlocked('warrior'));

  // Force-close panels that may have been left open from before a demotion.
  if (!isModeUnlocked('warrior')) {
    const weeklyReviewPanel = document.getElementById('weeklyReviewPanel');
    if (weeklyReviewPanel) weeklyReviewPanel.hidden = true;
  }
  if (!isModeUnlocked('demigod')) {
    const caliperPanel = document.getElementById('caliperEntryPanel');
    if (caliperPanel) caliperPanel.hidden = true;
  }

  applyHabitProtocolsGating();
}

// Custom Habit Protocols is a small cluster of inputs/buttons rather than
// one click target, so it's disabled directly instead of going through the
// click-guard list — without a defined habit there's nothing for the daily
// check-in's "Extra habits" checkboxes to show either, so gating just this
// definition point is enough to lock the whole feature.
function applyHabitProtocolsGating() {
  const locked = !isModeUnlocked('demigod');
  const section = document.getElementById('customHabitProtocolsSection');
  const badge = document.getElementById('habitProtocolsLockBadge');
  if (badge) badge.hidden = !locked;
  if (!section) return;
  section.classList.toggle('mode-locked-visual', locked);
  section.querySelectorAll('input, button').forEach(el => { el.disabled = locked; });
}

// Capture phase so this runs before the real feature's own click handler,
// regardless of registration order — stopImmediatePropagation blocks that
// handler from ever firing when the feature is locked.
function initModeGatedClickGuard() {
  document.addEventListener('click', e => {
    const gated = MODE_GATED_ELEMENTS.find(g => e.target.closest && e.target.closest('#' + g.id));
    if (gated && !isModeUnlocked(gated.required)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showLockedFeatureNotice();
      return;
    }
    const trainingTabBtn = e.target.closest && e.target.closest('.tab-btn[data-target="training"]');
    if (trainingTabBtn && !isModeUnlocked('warrior')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showLockedFeatureNotice();
    }
  }, true);
}

/* ---------------------------------------------------------------- */
/* Fitness Journey Mode gate (initial choice, shown after Review Gate) */
/* ---------------------------------------------------------------- */
function initFitnessModeGate(onComplete) {
  const profile = getProfile();
  if (!profile) { if (onComplete) onComplete(); return; }
  if (profile.fitnessMode) { if (onComplete) onComplete(); return; }

  if (!profile.fitnessModeChoicePending) {
    // Pre-existing profile from before this feature shipped — grandfather
    // in at full access (Demi-God, the true no-restrictions tier) rather
    // than retroactively locking someone who was already using the app.
    profile.fitnessMode = 'demigod';
    saveProfile(profile);
    if (onComplete) onComplete();
    return;
  }

  const overlay = document.getElementById('fitnessModeGateOverlay');
  overlay.hidden = false;

  function choose(mode) {
    const p = getProfile();
    p.fitnessMode = mode;
    delete p.fitnessModeChoicePending;
    p.modeProgress = freshModeProgress();
    saveProfile(p);
    overlay.hidden = true;
    applyModeGating();
    autoSyncLeaderboardIfOptedIn();
    if (onComplete) onComplete();
  }
  document.getElementById('btnChooseModeBeginner').addEventListener('click', () => choose('beginner'));
  document.getElementById('btnChooseModeWarrior').addEventListener('click', () => choose('warrior'));
  document.getElementById('btnChooseModeSpartan').addEventListener('click', () => choose('spartan'));
  document.getElementById('btnChooseModeDemigod').addEventListener('click', () => choose('demigod'));
}

function initModeTransitionPopup() {
  const overlay = document.getElementById('modeTransitionOverlay');
  document.getElementById('btnModeTransitionClose').addEventListener('click', () => { overlay.hidden = true; });
  bindOverlayBackdropClose(overlay, () => { overlay.hidden = true; });
}

function initRestartJourney() {
  const btn = document.getElementById('btnRestartJourney');
  const note = document.getElementById('restartJourneyNote');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!confirm('Restart your Fitness Journey? This clears ALL logs, reviews, and history, and takes you back to Novice Mode — you\'ll need to re-earn Warrior and Spartan Mode by logging consistently again. This cannot be undone.')) return;
    if (!confirm('Really sure? This is permanent — tap OK only if you genuinely want to start your journey over from Novice Mode.')) return;
    saveLogs({});
    saveReviews({});
    saveDailyReviews({});
    localStorage.removeItem('wft_demo_seeded_at');
    const p = getProfile();
    if (p) {
      p.fitnessMode = 'beginner';
      p.modeProgress = freshModeProgress();
      saveProfile(p);
    }
    applyModeGating();
    note.textContent = 'Journey restarted — you\'re back at Novice Mode.';
    setTimeout(() => { note.textContent = ''; }, 4000);
    renderDashboard();
    renderHistory();
    renderMeasureHistory();
    renderBodyFatHistory();
    updateTabDots();
  });
}

/* ---------------------------------------------------------------- */
/* Theme toggle                                                         */
/* ---------------------------------------------------------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeIcon').textContent = theme === 'light' ? '☀️' : '🌙';
  document.getElementById('themeToggle').checked = theme === 'light';
  localStorage.setItem('wft_theme', theme);
}

function initThemeToggle() {
  applyTheme(localStorage.getItem('wft_theme') || 'dark');
  document.getElementById('themeToggle').addEventListener('change', e => {
    applyTheme(e.target.checked ? 'light' : 'dark');
  });
}
initThemeToggle();

/* ---------------------------------------------------------------- */
/* Skin (theme pack) selector — layered on top of the dark/light toggle */
/* above via a separate [data-skin] attribute, so any skin can still be */
/* viewed in either light or dark mode.                                 */
/* ---------------------------------------------------------------- */
function applySkin(skin) {
  document.documentElement.setAttribute('data-skin', skin);
  document.getElementById('skinSelect').value = skin;
  localStorage.setItem('wft_skin', skin);
}

function initSkinSelector() {
  applySkin(localStorage.getItem('wft_skin') || 'default');
  document.getElementById('skinSelect').addEventListener('change', e => {
    applySkin(e.target.value);
  });
}
initSkinSelector();

/* ---------------------------------------------------------------- */
/* Text size (Settings) — scales the root font-size so every rem-based */
/* label/value across the app grows or shrinks together. Bounded to     */
/* 90%-115% (default 100%): the compact stat tiles, chips, and ring     */
/* center-text this session were tuned tight against their fixed px     */
/* padding, so anything wider risks text overflowing/overlapping its    */
/* box — this range is the widest that stays safe across those spots.   */
/* ---------------------------------------------------------------- */
const TEXT_SCALE_MIN = 90;
const TEXT_SCALE_MAX = 115;
function getTextScale() {
  const v = parseInt(localStorage.getItem('wft_text_scale'), 10);
  return (!isNaN(v) && v >= TEXT_SCALE_MIN && v <= TEXT_SCALE_MAX) ? v : 100;
}
function applyTextScale(scale) {
  document.documentElement.style.setProperty('--user-font-scale', (scale / 100).toFixed(2));
}
applyTextScale(getTextScale());

function initTextSizeSlider() {
  const slider = document.getElementById('textSizeSlider');
  const out = document.getElementById('textSizeOut');
  const scale = getTextScale();
  slider.value = scale;
  out.textContent = scale + '%';
  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    out.textContent = v + '%';
    localStorage.setItem('wft_text_scale', v);
    applyTextScale(v);
  });
}

/* ---------------------------------------------------------------- */
/* Custom background image (Settings)                                  */
/* ---------------------------------------------------------------- */
const BG_SETTINGS_DEFAULT = { mode: 'cover', blur: 0, dim: 0, transparency: 0, widgetFill: 0, widgetOpacity: 0, cropX: 50, cropY: 50 };

function getBgImageData() {
  try { return JSON.parse(localStorage.getItem('wft_bg_image')); } catch (e) { return null; }
}
function getBgSettings() {
  try { return Object.assign({}, BG_SETTINGS_DEFAULT, JSON.parse(localStorage.getItem('wft_bg_settings')) || {}); }
  catch (e) { return Object.assign({}, BG_SETTINGS_DEFAULT); }
}
function saveBgSettings(s) { localStorage.setItem('wft_bg_settings', JSON.stringify(s)); }

// Resizes to a size that's plenty sharp for a phone screen (no point storing
// a 12MP photo when the display it's shown on is a few hundred px wide) and
// compresses to JPEG, keeping localStorage usage reasonable. Also samples a
// 1x1 downscale of the result to get an average color — used to tint the
// layer behind the image so it "blends" instead of sitting on a mismatched
// flat background when blur/transparency/tiling reveal the edges.
function resizeAndCompressImage(file) {
  return new Promise((resolve, reject) => {
    const MAX_DIM = 1440;
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);

        const swatch = document.createElement('canvas');
        swatch.width = 1; swatch.height = 1;
        const swatchCtx = swatch.getContext('2d');
        swatchCtx.drawImage(canvas, 0, 0, 1, 1);
        const [r, g, b] = swatchCtx.getImageData(0, 0, 1, 1).data;

        resolve({ dataUrl, dominantColor: `rgb(${r}, ${g}, ${b})` });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function applyCustomBg() {
  const imgData = getBgImageData();
  const layer = document.getElementById('customBgLayer');
  const imageEl = document.getElementById('customBgImage');
  const overlayEl = document.getElementById('customBgOverlay');

  // Widget Box Fill Transparency applies regardless of whether a background
  // photo is set — it's a general "let widgets go see-through" control, not
  // strictly tied to having an image (works fine over the plain page
  // pattern too). Slider convention matches Blur/Dim/Transparency above:
  // 0 = no effect (fully opaque, unchanged), 100 = fully transparent.
  // Squaring the slider fraction before subtracting from 1 (rather than a
  // flat 1-x) keeps the fill looking nearly solid through the low end of
  // the slider and only ramps the see-through effect up sharply near the
  // top — a flat linear mapping made it look maxed-out by ~30%, since the
  // eye is far more sensitive to alpha loss near full opacity than a
  // straight percentage suggests.
  const bgSettingsForWidgets = getBgSettings();
  const fillFrac = bgSettingsForWidgets.widgetFill / 100;
  const opacityFrac = bgSettingsForWidgets.widgetOpacity / 100;
  document.documentElement.style.setProperty('--widget-fill-alpha', (1 - fillFrac * fillFrac).toFixed(2));
  document.documentElement.style.setProperty('--widget-opacity', (1 - opacityFrac * opacityFrac).toFixed(2));

  if (!imgData || !imgData.dataUrl) {
    layer.hidden = true;
    document.body.classList.remove('has-custom-bg');
    return;
  }
  const s = getBgSettings();
  layer.hidden = false;
  document.body.classList.add('has-custom-bg');
  layer.style.backgroundColor = imgData.dominantColor || '';
  imageEl.style.backgroundImage = `url(${imgData.dataUrl})`;
  // Fit mode is the one mode that reliably leaves letterbox gaps (top/bottom
  // for a wide image, left/right for a tall one) — fill them with a blurred,
  // full-bleed copy of the same photo instead of the flat dominant-color
  // tint alone, so the gap reads as the photo's own colors extending rather
  // than a mismatched solid block.
  const backdropEl = document.getElementById('customBgBackdrop');
  if (backdropEl) {
    backdropEl.hidden = s.mode !== 'contain';
    backdropEl.style.backgroundImage = s.mode === 'contain' ? `url(${imgData.dataUrl})` : '';
  }
  if (s.mode === 'tile') {
    imageEl.style.backgroundSize = 'auto';
    imageEl.style.backgroundRepeat = 'repeat';
    imageEl.style.backgroundPosition = '0 0';
  } else if (s.mode === 'contain') {
    imageEl.style.backgroundSize = 'contain';
    imageEl.style.backgroundRepeat = 'no-repeat';
    imageEl.style.backgroundPosition = 'center';
  } else if (s.mode === 'center') {
    imageEl.style.backgroundSize = 'auto';
    imageEl.style.backgroundRepeat = 'no-repeat';
    imageEl.style.backgroundPosition = 'center';
  } else if (s.mode === 'crop') {
    imageEl.style.backgroundSize = 'cover';
    imageEl.style.backgroundRepeat = 'no-repeat';
    imageEl.style.backgroundPosition = `${s.cropX}% ${s.cropY}%`;
  } else {
    imageEl.style.backgroundSize = 'cover';
    imageEl.style.backgroundRepeat = 'no-repeat';
    imageEl.style.backgroundPosition = 'center';
  }
  imageEl.style.filter = s.blur > 0 ? `blur(${s.blur}px)` : 'none';
  imageEl.style.opacity = String(1 - (s.transparency / 100));
  overlayEl.style.opacity = String(s.dim / 100);
}
applyCustomBg();

// Mirrors the exact math applyCustomBg() uses for --widget-fill-alpha /
// --widget-opacity, but reads live off the sliders (not saved settings) and
// only paints the small swatch — never touches the real app-wide CSS vars.
// Both effects stack on the same fill layer in the real CSS (see the
// .chart-card::before rule), so the preview multiplies them the same way,
// otherwise the preview wouldn't match what Apply actually produces.
function updateWidgetOpacityPreview() {
  const fillFrac = parseInt(document.getElementById('bgWidgetFillSlider').value, 10) / 100;
  const opacityFrac = parseInt(document.getElementById('bgWidgetOpacitySlider').value, 10) / 100;
  const fillAlpha = 1 - fillFrac * fillFrac;
  const opacityAlpha = 1 - opacityFrac * opacityFrac;
  const effectiveAlpha = (fillAlpha * opacityAlpha).toFixed(2);
  document.getElementById('widgetOpacityPreviewFill').style.background = `rgba(var(--surface-1-rgb), ${effectiveAlpha})`;
}

// Crop position previews via drag before Apply commits it (see
// initCustomBackground below) — kept at module scope so both the drag
// handler and loadBgSettingsIntoUI can read/reset the same pending value.
let pendingCropX = 50, pendingCropY = 50;

function updateCropPreviewBg() {
  const imgData = getBgImageData();
  const preview = document.getElementById('bgCropPreview');
  if (!imgData) return;
  preview.style.backgroundImage = `url(${imgData.dataUrl})`;
  preview.style.backgroundPosition = `${pendingCropX}% ${pendingCropY}%`;
}

function loadBgSettingsIntoUI() {
  const s = getBgSettings();
  document.getElementById('bgModeSelect').value = s.mode;
  document.getElementById('bgBlurSlider').value = s.blur;
  document.getElementById('bgBlurOut').textContent = s.blur;
  document.getElementById('bgDimSlider').value = s.dim;
  document.getElementById('bgDimOut').textContent = s.dim;
  document.getElementById('bgTransparencySlider').value = s.transparency;
  document.getElementById('bgTransparencyOut').textContent = s.transparency;
  document.getElementById('bgWidgetFillSlider').value = s.widgetFill;
  document.getElementById('bgWidgetFillOut').textContent = s.widgetFill;
  document.getElementById('bgWidgetOpacitySlider').value = s.widgetOpacity;
  document.getElementById('bgWidgetOpacityOut').textContent = s.widgetOpacity;
  document.getElementById('bgCropWrap').hidden = s.mode !== 'crop';
  pendingCropX = s.cropX;
  pendingCropY = s.cropY;
  updateCropPreviewBg();
  updateWidgetOpacityPreview();
  document.getElementById('btnApplyWidgetOpacity').disabled = true;
  document.getElementById('btnApplyBgSettings').disabled = true;
}

function initCustomBackground() {
  const fileInput = document.getElementById('bgImageInput');
  const statusEl = document.getElementById('bgImageStatus');
  const settingsGroup = document.getElementById('bgSettingsGroup');
  const removeBtn = document.getElementById('btnRemoveBgImage');

  function refreshUploadUiState() {
    const has = !!(getBgImageData() && getBgImageData().dataUrl);
    settingsGroup.hidden = !has;
    removeBtn.hidden = !has;
    statusEl.textContent = has ? 'Background image set.' : 'No background image set.';
  }

  document.getElementById('btnChooseBgImage').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { statusEl.textContent = 'Please choose an image file.'; return; }
    statusEl.textContent = 'Processing image…';
    try {
      const { dataUrl, dominantColor } = await resizeAndCompressImage(file);
      // Resize/compress above already keeps normal photos well under this —
      // this only catches pathological cases (e.g. a giant single-color PNG
      // that doesn't compress well as JPEG source).
      if (dataUrl.length > 2000000) {
        statusEl.textContent = 'That image is too large even after compressing — try a smaller photo.';
        return;
      }
      localStorage.setItem('wft_bg_image', JSON.stringify({ dataUrl, dominantColor }));
      refreshUploadUiState();
      loadBgSettingsIntoUI();
      applyCustomBg();
      statusEl.textContent = 'Background image set.';
    } catch (e) {
      statusEl.textContent = e.message || 'Could not process that image — try another.';
    }
  });

  removeBtn.addEventListener('click', () => {
    localStorage.removeItem('wft_bg_image');
    refreshUploadUiState();
    applyCustomBg();
  });

  // Position mode / Crop / Blur / Dim / Transparency all preview locally
  // (mode + crop box update on screen, slider readouts update) but don't
  // touch the real background layer or saved settings until Apply is
  // tapped — same deferred-apply pattern as Widget Fill/Opacity below.
  const applyBgSettingsBtn = document.getElementById('btnApplyBgSettings');

  document.getElementById('bgModeSelect').addEventListener('change', e => {
    document.getElementById('bgCropWrap').hidden = e.target.value !== 'crop';
    if (e.target.value === 'crop') updateCropPreviewBg();
    applyBgSettingsBtn.disabled = false;
  });

  [['bgBlurSlider', 'blur'], ['bgDimSlider', 'dim'], ['bgTransparencySlider', 'transparency']].forEach(([id, key]) => {
    document.getElementById(id).addEventListener('input', e => {
      document.getElementById(id.replace('Slider', 'Out')).textContent = e.target.value;
      applyBgSettingsBtn.disabled = false;
    });
  });

  applyBgSettingsBtn.addEventListener('click', () => {
    const s = getBgSettings();
    s.mode = document.getElementById('bgModeSelect').value;
    s.blur = parseInt(document.getElementById('bgBlurSlider').value, 10);
    s.dim = parseInt(document.getElementById('bgDimSlider').value, 10);
    s.transparency = parseInt(document.getElementById('bgTransparencySlider').value, 10);
    s.cropX = pendingCropX;
    s.cropY = pendingCropY;
    saveBgSettings(s);
    applyCustomBg();
    applyBgSettingsBtn.disabled = true;
  });

  // Widget Box Fill Transparency / Widget Opacity dragging every step
  // instantly re-rendered the whole app's widgets, which made the fade feel
  // like it was snapping straight to fully transparent mid-drag. These two
  // now only update a small preview swatch (and the settings sliders'
  // own numeric readout) while dragging — the real app-wide CSS vars only
  // change once "Apply" is tapped, using whatever the sliders are set to
  // at that moment.
  const applyWidgetOpacityBtn = document.getElementById('btnApplyWidgetOpacity');
  ['bgWidgetFillSlider', 'bgWidgetOpacitySlider'].forEach(id => {
    document.getElementById(id).addEventListener('input', e => {
      document.getElementById(id.replace('Slider', 'Out')).textContent = e.target.value;
      updateWidgetOpacityPreview();
      applyWidgetOpacityBtn.disabled = false;
    });
  });
  applyWidgetOpacityBtn.addEventListener('click', () => {
    const s = getBgSettings();
    s.widgetFill = parseInt(document.getElementById('bgWidgetFillSlider').value, 10);
    s.widgetOpacity = parseInt(document.getElementById('bgWidgetOpacitySlider').value, 10);
    saveBgSettings(s);
    applyCustomBg();
    applyWidgetOpacityBtn.disabled = true;
  });

  // Drag-to-reposition on the crop preview box — only relevant in Crop &
  // Position mode, but harmless to leave wired otherwise (box is hidden).
  const cropPreview = document.getElementById('bgCropPreview');
  let dragging = false, startX = 0, startY = 0, startCropX = 50, startCropY = 50;
  cropPreview.addEventListener('pointerdown', e => {
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    startCropX = pendingCropX; startCropY = pendingCropY;
    cropPreview.setPointerCapture(e.pointerId);
  });
  cropPreview.addEventListener('pointermove', e => {
    if (!dragging) return;
    const rect = cropPreview.getBoundingClientRect();
    const dxPct = ((e.clientX - startX) / rect.width) * 100;
    const dyPct = ((e.clientY - startY) / rect.height) * 100;
    pendingCropX = Math.max(0, Math.min(100, startCropX - dxPct));
    pendingCropY = Math.max(0, Math.min(100, startCropY - dyPct));
    cropPreview.style.backgroundPosition = `${pendingCropX}% ${pendingCropY}%`;
    applyBgSettingsBtn.disabled = false;
  });
  cropPreview.addEventListener('pointerup', () => { dragging = false; });
  cropPreview.addEventListener('pointercancel', () => { dragging = false; });

  refreshUploadUiState();
  loadBgSettingsIntoUI();
}

/* ---------------------------------------------------------------- */
/* Init                                                                 */
/* ---------------------------------------------------------------- */
document.getElementById('headerToday').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

// Each init step runs in its own try/catch: a bug in one feature (e.g. a
// stray cached-asset mismatch after an update) must not silently cancel
// every init step listed after it — that's what let a single early failure
// take out unrelated late-registered features (like the chat refresh
// button) with zero visible symptom. Failures are collected and, if any
// happened, surfaced as a toast so they're actually reportable instead of
// invisible in a console nobody's looking at.
const initFailures = [];
function safeInit(fn, label) {
  try { fn(); } catch (err) {
    console.error(`Init failed: ${label}`, err);
    initFailures.push(label + ': ' + (err && err.message ? err.message : String(err)));
  }
}

safeInit(migrateWaterUnitsIfNeeded, 'migrateWaterUnitsIfNeeded');
safeInit(initTabs, 'initTabs');
safeInit(initSwipeNavigation, 'initSwipeNavigation');
safeInit(initBackButtonNav, 'initBackButtonNav');
safeInit(() => {
  document.getElementById('btnGoToBioFromChart').addEventListener('click', () => {
    document.querySelector('.tab-btn[data-target="bio"]').click();
  });
}, 'btnGoToBioFromChart');
safeInit(initSettingsOverlay, 'initSettingsOverlay');
safeInit(initAppUpdateButton, 'initAppUpdateButton');
safeInit(initDonationPrompt, 'initDonationPrompt');
safeInit(initLastStateRestore, 'initLastStateRestore');
safeInit(incrementAppOpens, 'incrementAppOpens');
safeInit(initDigitalId, 'initDigitalId');
safeInit(initDigitalIdOverride, 'initDigitalIdOverride');
safeInit(initAdFreeOverride, 'initAdFreeOverride');
safeInit(initAdManager, 'initAdManager');
safeInit(initSplashLogoManager, 'initSplashLogoManager');
safeInit(initSyncLogsShare, 'initSyncLogsShare');
safeInit(initMediaSyncWidget, 'initMediaSyncWidget');
safeInit(initFoodPrepsOverlay, 'initFoodPrepsOverlay');
safeInit(initPrepMealManager, 'initPrepMealManager');
safeInit(initPrepMealEditor, 'initPrepMealEditor');
safeInit(() => initClickToRevealHint('adjustedBmiTile', 'adjustedBmiHint'), 'initAdjustedBmiHint');
safeInit(() => initClickToRevealHint('stepsCaloriesTitle', 'stepsCaloriesHint'), 'initStepsCaloriesHint');
safeInit(initContact, 'initContact');
safeInit(initFooterShare, 'initFooterShare');
safeInit(initFooterTagline, 'initFooterTagline');
safeInit(initFooterSocialLinks, 'initFooterSocialLinks');
safeInit(initPrivacyPolicy, 'initPrivacyPolicy');
safeInit(initTermsOfService, 'initTermsOfService');
safeInit(initPRBoardOverlay, 'initPRBoardOverlay');
safeInit(initMeasureEntryOverlay, 'initMeasureEntryOverlay');
safeInit(initEntityIdentityOverlay, 'initEntityIdentityOverlay');
safeInit(initEntityPhotoUpload, 'initEntityPhotoUpload');
safeInit(initDateTimeWidget, 'initDateTimeWidget');
safeInit(initTimezonePicker, 'initTimezonePicker');
safeInit(initWeatherWidget, 'initWeatherWidget');
safeInit(initWeatherLocationPicker, 'initWeatherLocationPicker');
safeInit(initSetupForm, 'initSetupForm');
safeInit(initCheckin, 'initCheckin');
safeInit(initQuickLogLaunchers, 'initQuickLogLaunchers');
safeInit(initTrainingLogQuickPopup, 'initTrainingLogQuickPopup');
safeInit(initFuelLogQuickPopup, 'initFuelLogQuickPopup');
safeInit(initCommunityQuickPopup, 'initCommunityQuickPopup');
safeInit(initMeasurements, 'initMeasurements');
safeInit(initTraining, 'initTraining');
safeInit(initExerciseTimerPopup, 'initExerciseTimerPopup');
safeInit(initCardioTracker, 'initCardioTracker');
safeInit(initMissionLog, 'initMissionLog');
safeInit(initDatePicker, 'initDatePicker');
safeInit(initWeightChartToggle, 'initWeightChartToggle');
safeInit(initVolumeTrendToggle, 'initVolumeTrendToggle');
safeInit(initNutrition, 'initNutrition');
safeInit(initFoodDiary, 'initFoodDiary');
safeInit(initAddFoodPanel, 'initAddFoodPanel');
safeInit(initManualIntake, 'initManualIntake');
safeInit(initBarcodeScanner, 'initBarcodeScanner');
safeInit(initBarcodePhotoFallback, 'initBarcodePhotoFallback');
safeInit(initBioLog, 'initBioLog');
safeInit(initDailyReviewForm, 'initDailyReviewForm');
safeInit(initReviewForm, 'initReviewForm');
safeInit(initReviewToggles, 'initReviewToggles');
safeInit(initHistoryLogsToggle, 'initHistoryLogsToggle');
safeInit(initExport, 'initExport');
safeInit(initDrive, 'initDrive');
safeInit(initClearAllData, 'initClearAllData');
safeInit(initWelcomeDemoOverlay, 'initWelcomeDemoOverlay');
safeInit(initCustomBackground, 'initCustomBackground');
safeInit(initTextSizeSlider, 'initTextSizeSlider');
safeInit(initPushNotifications, 'initPushNotifications');
safeInit(initDeepLinkHandling, 'initDeepLinkHandling');
safeInit(initWidgetActionHandling, 'initWidgetActionHandling');
safeInit(initProgressPhotoCamera, 'initProgressPhotoCamera');
safeInit(initLeaderboard, 'initLeaderboard');
safeInit(initAnnouncementWidget, 'initAnnouncementWidget');
safeInit(initAdminDrawer, 'initAdminDrawer');
safeInit(loadSetupForm, 'loadSetupForm');
safeInit(loadCheckinForm, 'loadCheckinForm');
safeInit(() => { document.getElementById('sysVersion').textContent = APP_VERSION; }, 'sysVersion');
safeInit(renderDashboard, 'renderDashboard');
safeInit(updateTabDots, 'updateTabDots');
safeInit(initBetaLock, 'initBetaLock');
safeInit(() => {
  if (document.getElementById('lockOverlay').hidden) {
    initOnboarding(() => initReviewGate(() => initFitnessModeGate(() => initConsentGate())));
  }
}, 'initOnboarding');
safeInit(initModeTransitionPopup, 'initModeTransitionPopup');
safeInit(initRestartJourney, 'initRestartJourney');
safeInit(initModeGatedClickGuard, 'initModeGatedClickGuard');
safeInit(() => { processDailyModeCheck(); checkModeProgressNudge(); applyModeGating(); }, 'fitnessModeDaily');

if (initFailures.length) {
  setTimeout(() => {
    showRestToast(`${initFailures.length} feature(s) failed to load: ${initFailures[0]}${initFailures.length > 1 ? ` (+${initFailures.length - 1} more, see console)` : ''}`);
  }, 2200);
}

setTimeout(() => {
  const splash = document.getElementById('splashScreen');
  if (!splash) return;
  splash.classList.add('splash-hide');
  setTimeout(() => { splash.hidden = true; }, 400);
  initAdSplash();
  checkDemoDataExpiry();
  checkDataReminder();
  setTimeout(checkMeasurementReminder, 6000);
  cleanupOldHydrationFiredKeys();
  setTimeout(checkHydrationReminders, 8000);
  setTimeout(checkDonationPrompt, 500);
  restoreLastState();
}, 2000);

setInterval(checkHydrationReminders, 5 * 60 * 1000);

// Background unread-message check so the Nexus tab dot can light up even while
// the user is elsewhere — the Nexus tab's own polling only runs while it's active.
function checkUnreadMessagesBackground() {
  if (!sbConfigured() || !localStorage.getItem('wft_lb_share_key')) return Promise.resolve();
  return refreshChatRooms().catch(() => {});
}
setTimeout(checkUnreadMessagesBackground, 5000);
setInterval(checkUnreadMessagesBackground, 60000);


let swRegistration = null;
let swReloadedOnce = false;
let updateAvailable = false;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache: 'none' stops the browser from ever serving sw.js (or
    // anything it imports) from HTTP cache during an update check — without
    // this, a stale cached copy of sw.js can make every check falsely
    // report "already latest" until the HTTP cache entry happens to expire.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(async reg => {
      swRegistration = reg;

      const enabled = await updatesGloballyEnabled();
      if (!enabled) {
        // Admin's "Updates enabled" kill switch (Settings, admin-only) is
        // off — don't even look, so a paused build genuinely never checks.
        if (reg.waiting && navigator.serviceWorker.controller) markUpdateAvailable();
        return;
      }

      // Cold-launch check: look for an update right away and, if one's
      // already waiting (found now, or left over from a previous session
      // that never got applied), apply it immediately — before the splash
      // screen even finishes — instead of opening on a possibly-stale
      // cached version and only mentioning it later. This is the ONE place
      // that auto-applies without asking; the reload it triggers (via the
      // controllerchange listener below) just restarts the app once,
      // landing on the fresh build. Updates found later in the same
      // session (the 15-min interval below) intentionally still only get
      // marked available rather than force-applied, so nothing yanks an
      // active session out from under the user mid-use — only the initial
      // open auto-updates.
      if (reg.waiting && navigator.serviceWorker.controller) {
        reg.waiting.postMessage('SKIP_WAITING');
      } else {
        const found = await checkForUpdate();
        if (found && reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
      }

      setInterval(() => checkForUpdate(), 15 * 60 * 1000);
    }).catch(() => {});
  });
  // Fires once the new worker actually takes control (after SKIP_WAITING) —
  // this is the one-and-only reload the "Update Now" flow needs.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swReloadedOnce) return;
    swReloadedOnce = true;
    location.reload();
  });
}

async function fetchLatestVersionLabel() {
  try {
    const res = await fetch('app.js?_=' + Date.now(), { cache: 'no-store' });
    const text = await res.text();
    const m = text.match(/APP_VERSION\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

async function markUpdateAvailable() {
  updateAvailable = true;
  const note = document.getElementById('updateAvailableNote');
  const versionEl = document.getElementById('updateAvailableVersion');
  if (!note || !versionEl) return;
  note.hidden = false;
  versionEl.textContent = 'checking version…';
  const label = await fetchLatestVersionLabel();
  versionEl.textContent = label || 'ready to install';
}

function clearUpdateAvailable() {
  updateAvailable = false;
  const note = document.getElementById('updateAvailableNote');
  if (note) note.hidden = true;
}

// Event-driven: waits for the actual 'installed' state instead of guessing
// with a fixed delay, so it isn't a race against slow networks. Resolves
// true if a new version ended up waiting to activate.
function checkForUpdate() {
  if (!swRegistration) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = found => {
      if (settled) return;
      settled = true;
      swRegistration.removeEventListener('updatefound', onUpdateFound);
      clearTimeout(fallbackTimer);
      if (found) markUpdateAvailable();
      resolve(found);
    };
    const onUpdateFound = () => {
      const installing = swRegistration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') finish(!!swRegistration.waiting);
        else if (installing.state === 'redundant') finish(false);
      });
    };
    swRegistration.addEventListener('updatefound', onUpdateFound);
    const fallbackTimer = setTimeout(() => finish(!!swRegistration.waiting), 8000);
    swRegistration.update().catch(() => finish(!!swRegistration.waiting));
  });
}

async function checkAndApplyAppUpdate() {
  const overlay = document.getElementById('appUpdateOverlay');
  const statusEl = document.getElementById('appUpdateStatus');
  overlay.hidden = false;
  statusEl.textContent = 'Checking for updates…';

  if (!(await updatesGloballyEnabled())) {
    statusEl.textContent = 'Updates are currently paused — check back later.';
    setTimeout(() => { overlay.hidden = true; }, 2200);
    return;
  }

  if (!swRegistration) {
    statusEl.textContent = 'Update system unavailable — try closing and reopening the app.';
    setTimeout(() => { overlay.hidden = true; }, 2200);
    return;
  }

  // Already found one in the background — apply immediately, no re-check needed.
  const found = swRegistration.waiting ? true : await checkForUpdate();

  if (found && swRegistration.waiting) {
    statusEl.textContent = 'Updating…';
    clearUpdateAvailable();
    swRegistration.waiting.postMessage('SKIP_WAITING');
    // Safety net in case controllerchange never fires for some reason.
    setTimeout(() => { if (!swReloadedOnce) location.reload(); }, 4000);
  } else {
    statusEl.textContent = "You're already on the latest version.";
    setTimeout(() => { overlay.hidden = true; }, 1800);
  }
}

function initAppUpdateButton() {
  document.getElementById('settingsAppVersion').textContent = APP_VERSION;
  document.getElementById('btnCheckUpdate').addEventListener('click', checkAndApplyAppUpdate);

  const autoToggle = document.getElementById('autoUpdateToggle');
  autoToggle.checked = localStorage.getItem('wft_auto_update') === '1';
  autoToggle.addEventListener('change', () => {
    localStorage.setItem('wft_auto_update', autoToggle.checked ? '1' : '0');
  });

  const updatesToggle = document.getElementById('updatesEnabledToggle');
  if (updatesToggle) {
    updatesToggle.addEventListener('change', async () => {
      if (!isAdminLoggedIn()) { updatesToggle.checked = !updatesToggle.checked; return; }
      const desired = updatesToggle.checked;
      try {
        const { error } = await sb.rpc('admin_set_updates_enabled', {
          p_digital_id: adminSession.digitalId, p_password: adminSession.password, p_enabled: desired,
        });
        if (error) throw error;
        cachedAdSettingsPromise = null; // next check picks up the new value instead of the stale cache
        showRestToast(desired ? 'Updates re-enabled app-wide.' : 'Updates paused app-wide — everyone stays on their current version.');
      } catch (e) {
        updatesToggle.checked = !desired;
        showRestToast('Could not update setting.');
      }
    });
  }
}

// Global admin kill switch — false only when an admin explicitly turned it
// off server-side. Any failure (offline, not configured) fails OPEN so a
// network hiccup never accidentally freezes everyone on an old build.
async function updatesGloballyEnabled() {
  const settings = await fetchAdSettings();
  return !settings || settings.updates_enabled !== false;
}

// Called right after a Sync to Nexus / local backup / Drive backup
// succeeds — those are the safe checkpoints the Auto-update toggle in
// Settings promises, since everything's already saved by the time this
// runs. Silently does nothing if the toggle is off, no update is actually
// waiting, or the update system isn't available — never surprises a user
// who hasn't opted in, and never reloads them out of an unsaved change
// elsewhere (every write in this app is already synchronous-to-localStorage,
// so there's nothing "unsaved" left standing regardless of when this fires).
async function maybeAutoApplyUpdate() {
  if (localStorage.getItem('wft_auto_update') !== '1') return;
  if (!swRegistration) return;
  if (!(await updatesGloballyEnabled())) return;
  const found = swRegistration.waiting ? true : await checkForUpdate();
  if (!found || !swRegistration.waiting) return;
  showRestToast('Update found — applying automatically…');
  clearUpdateAvailable();
  swRegistration.waiting.postMessage('SKIP_WAITING');
  setTimeout(() => { if (!swReloadedOnce) location.reload(); }, 4000);
}


