chrome.action.onClicked.addListener(function (tab) {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'dst:toggle' }, function () {
    if (chrome.runtime.lastError) {
      chrome.tabs.create({ url: 'https://chat.deepseek.com/' });
    }
  });
});
