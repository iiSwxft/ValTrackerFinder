// Single-hit scans open the match in a new tab through here — content-script
// window.open without a user gesture gets popup-blocked, chrome.tabs doesn't.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'trnmf-open' && typeof msg.url === 'string') {
    chrome.tabs.create({ url: msg.url });
  }
});
