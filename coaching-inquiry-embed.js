(function () {
  var SUPABASE_URL = 'https://mzkjboplfalauivwcnni.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_YwHBnvbBjd8Oj8hgPXb_JA_buurC92v';

  var form = document.getElementById('wfInquiryForm');
  if (!form || typeof supabase === 'undefined') return;

  var sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  var nameEl = document.getElementById('wfInquiryName');
  var contactEl = document.getElementById('wfInquiryContact');
  var messageEl = document.getElementById('wfInquiryMessage');
  var submitBtn = document.getElementById('wfInquirySubmit');
  var statusEl = document.getElementById('wfInquiryStatus');

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? '#ff6b6b' : '#7be0a8';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var name = nameEl.value.trim();
    var contact = contactEl.value.trim();
    var message = messageEl.value.trim();
    if (!name || !contact || !message) {
      setStatus('Please fill in every field.', true);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    setStatus('', false);

    sb.rpc('submit_coaching_inquiry', { p_name: name, p_contact: contact, p_message: message })
      .then(function (res) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Inquiry';
        if (res.error) {
          setStatus(res.error.message || 'Something went wrong. Please try again.', true);
          return;
        }
        form.reset();
        setStatus("Thanks! We'll get back to you soon.", false);
      })
      .catch(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Inquiry';
        setStatus('Could not reach the server. Check your connection and try again.', true);
      });
  });
})();
