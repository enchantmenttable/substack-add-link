// Open options page on first install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

// Fetch with timeout (5 seconds)
function fetchWithTimeout(url, ms = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
}

// Fetch posts from API or RSS and merge with existing
async function fetchAndMergePosts() {
  const data = await chrome.storage.local.get(['newsletterUrl', 'posts']);
  const { newsletterUrl } = data;
  const existingPosts = data.posts || [];

  if (!newsletterUrl) return { added: 0 };

  let newPosts = [];

  // Try API first, then RSS fallback
  let apiFailed = false;
  try {
    const res = await fetchWithTimeout(`${newsletterUrl}/api/v1/archive`);
    if (res.ok) {
      const apiData = await res.json();
      newPosts = apiData.map(item => ({
        title: item.title,
        url: `${newsletterUrl}/p/${item.slug}`,
        date: item.post_date
      }));
    } else {
      apiFailed = true;
    }
  } catch (e) {
    apiFailed = true;
  }

  // If API failed or returned no posts, try RSS
  if (apiFailed || newPosts.length === 0) {
    try {
      const res = await fetchWithTimeout(`${newsletterUrl}/feed`);
      if (res.ok) {
        const xml = await res.text();
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
        const rssPosts = items.map(match => {
          const content = match[1];
          const title = content.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/);
          const link = content.match(/<link>(.*?)<\/link>/);
          const pubDate = content.match(/<pubDate>(.*?)<\/pubDate>/);
          return {
            title: (title?.[1] || title?.[2]) || 'Untitled',
            url: link?.[1],
            date: pubDate?.[1] ? new Date(pubDate[1]).toISOString() : null
          };
        }).filter(p => p.url);
        if (rssPosts.length > 0) newPosts = rssPosts;
      }
    } catch (e2) {
      // Both failed
    }
  }

  if (newPosts.length === 0) {
    return { added: 0, total: existingPosts.length, error: 'Could not fetch posts' };
  }

  // Merge with existing posts (dedupe by URL)
  const existingUrls = new Set(existingPosts.map(p => p.url));
  const uniqueNew = newPosts.filter(p => !existingUrls.has(p.url));

  if (uniqueNew.length > 0) {
    const merged = [...uniqueNew, ...existingPosts];
    merged.sort((a, b) => new Date(b.date) - new Date(a.date));
    await chrome.storage.local.set({ posts: merged, lastUpdated: Date.now() });
    return { added: uniqueNew.length, total: merged.length };
  }

  return { added: 0, total: existingPosts.length };
}

// Listen for fetch requests from options page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchPosts') {
    fetchAndMergePosts().then(sendResponse);
    return true; // keep channel open for async response
  }
});
