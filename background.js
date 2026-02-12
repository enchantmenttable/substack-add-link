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

// Abort flag for stopping fetch
let fetchStopped = false;

// Fetch posts from API or RSS and merge with existing
async function fetchAndMergePosts() {
  fetchStopped = false;
  const data = await chrome.storage.local.get(['newsletterUrl', 'posts']);
  const { newsletterUrl } = data;
  const existingPosts = data.posts || [];

  if (!newsletterUrl) return { added: 0 };

  let newPosts = [];

  // Try API first (with parallel pagination), then RSS fallback
  let apiFailed = false;
  try {
    // Fetch first page to get page size
    const firstRes = await fetchWithTimeout(`${newsletterUrl}/api/v1/archive?offset=0`);
    if (!firstRes.ok) {
      apiFailed = true;
    } else {
      const firstBatch = await firstRes.json();
      if (Array.isArray(firstBatch) && firstBatch.length > 0) {
        const pageSize = firstBatch.length;
        for (const item of firstBatch) {
          newPosts.push({ title: item.title, url: `${newsletterUrl}/p/${item.slug}`, date: item.post_date });
        }
        chrome.runtime.sendMessage({ action: 'fetchProgress', count: newPosts.length }).catch(() => {});

        // Fetch remaining pages in parallel batches of 5
        let offset = pageSize;
        let hasMore = true;
        while (hasMore && !fetchStopped) {
          const offsets = [];
          for (let i = 0; i < 5 && hasMore; i++) {
            offsets.push(offset);
            offset += pageSize;
          }
          const results = await Promise.all(
            offsets.map(o =>
              fetchWithTimeout(`${newsletterUrl}/api/v1/archive?offset=${o}`)
                .then(r => r.ok ? r.json() : [])
                .catch(() => [])
            )
          );
          for (const batch of results) {
            if (!Array.isArray(batch) || batch.length === 0) { hasMore = false; break; }
            for (const item of batch) {
              newPosts.push({ title: item.title, url: `${newsletterUrl}/p/${item.slug}`, date: item.post_date });
            }
          }
          chrome.runtime.sendMessage({ action: 'fetchProgress', count: newPosts.length }).catch(() => {});
        }
      }
    }
  } catch (e) {
    if (newPosts.length === 0) apiFailed = true;
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
    return true;
  }
  if (message.action === 'stopFetch') {
    fetchStopped = true;
  }
});
