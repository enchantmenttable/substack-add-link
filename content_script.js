// Substack Internal Linking Content Script
// Monitors the Substack editor for [[ triggers and provides a post search panel

(function() {
  'use strict';

  let posts = [];
  let panel = null;
  let selectedIndex = 0;
  let triggerContext = null;
  let hasFetchedThisSession = false;

  // Load posts from storage
  async function loadPosts() {
    const data = await chrome.storage.local.get(['posts']);
    posts = data.posts || [];
  }

  // Initialize
  loadPosts();

  // Listen for storage changes (in case user updates in options or auto-fetch)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.posts) {
      posts = changes.posts.newValue || [];
    }
  });

  // Parse RSS feed XML
  function parseRSS(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const items = doc.querySelectorAll('item');

    return Array.from(items).map(item => ({
      title: item.querySelector('title')?.textContent || 'Untitled',
      url: item.querySelector('link')?.textContent,
      date: new Date(item.querySelector('pubDate')?.textContent).toISOString()
    })).filter(p => p.url);
  }

  // Fetch with timeout (5 seconds)
  function fetchWithTimeout(url, ms = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
  }

  // Fetch new posts from API or RSS
  async function fetchNewPosts() {
    if (hasFetchedThisSession) return;
    hasFetchedThisSession = true;

    const data = await chrome.storage.local.get(['newsletterUrl', 'posts']);
    const { newsletterUrl } = data;
    const existingPosts = data.posts || [];

    if (!newsletterUrl) return;

    let newPosts = [];

    // Fetch first page only (to catch recently published posts)
    let apiFailed = false;
    try {
      const res = await fetchWithTimeout(`${newsletterUrl}/api/v1/archive?offset=0`);
      if (!res.ok) {
        apiFailed = true;
      } else {
        const batch = await res.json();
        if (Array.isArray(batch)) {
          for (const item of batch) {
            newPosts.push({ title: item.title, url: `${newsletterUrl}/p/${item.slug}`, date: item.post_date });
          }
        }
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
          newPosts = parseRSS(xml);
        }
      } catch (e2) {
        console.error('Substack Internal Linking: Failed to fetch updates');
        return;
      }
    }

    if (newPosts.length === 0) return;

    // Merge with existing posts (dedupe by URL)
    const existingUrls = new Set(existingPosts.map(p => p.url));
    const uniqueNew = newPosts.filter(p => !existingUrls.has(p.url));

    if (uniqueNew.length > 0) {
      const merged = [...uniqueNew, ...existingPosts];
      // Sort by date descending
      merged.sort((a, b) => new Date(b.date) - new Date(a.date));
      await chrome.storage.local.set({ posts: merged, lastUpdated: Date.now() });
      console.log(`Substack Internal Linking: Added ${uniqueNew.length} new post(s)`);
    }
  }

  // Auto-fetch on publish pages
  if (window.location.pathname.includes('/publish')) {
    fetchNewPosts();
  }

  // Check if we're in the Substack editor
  function isSubstackEditor(element) {
    // Check if it's a contenteditable element
    if (!element.isContentEditable) return false;

    // Check if we're on a Substack publish/edit page
    const path = window.location.pathname;
    return path.includes('/publish') || path.includes('/p/') && path.includes('/edit');
  }

  // Check for [[ trigger and return context
  function checkForTrigger() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return null;

    const range = selection.getRangeAt(0);
    const textNode = range.startContainer;

    if (textNode.nodeType !== Node.TEXT_NODE) return null;

    const text = textNode.textContent.slice(0, range.startOffset);
    const triggerIndex = text.lastIndexOf('[[');

    // Make sure [[ isn't closed with ]]
    const afterTrigger = text.slice(triggerIndex);
    if (afterTrigger.includes(']]')) return null;

    if (triggerIndex === -1) return null;

    return {
      query: text.slice(triggerIndex + 2),
      triggerIndex,
      textNode,
      range,
      cursorOffset: range.startOffset
    };
  }

  // Filter posts by query
  function filterPosts(query) {
    if (!query) return posts.slice(0, 10);

    const lowerQuery = query.toLowerCase();
    return posts
      .filter(post => post.title.toLowerCase().includes(lowerQuery))
      .slice(0, 10);
  }

  // Create search panel
  function createPanel() {
    const div = document.createElement('div');
    div.className = 'substack-linker-panel';
    document.body.appendChild(div);
    return div;
  }

  // Position panel at cursor
  function positionPanel() {
    if (!panel) return;

    const selection = window.getSelection();
    if (!selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // Position below the cursor
    let top = rect.bottom + window.scrollY + 4;
    let left = rect.left + window.scrollX;

    // Keep panel within viewport
    const panelRect = panel.getBoundingClientRect();
    if (left + panelRect.width > window.innerWidth) {
      left = window.innerWidth - panelRect.width - 16;
    }
    if (top + panelRect.height > window.innerHeight + window.scrollY) {
      top = rect.top + window.scrollY - panelRect.height - 4;
    }

    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  }

  const ICON_X = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  // Render search results
  function renderResults(filteredPosts) {
    if (!panel) return;

    if (filteredPosts.length === 0) {
      panel.innerHTML = '<div class="substack-linker-empty">No posts found</div>';
      return;
    }

    panel.innerHTML = filteredPosts.map((post, i) => `
      <div class="substack-linker-item${i === selectedIndex ? ' selected' : ''}" data-index="${i}">
        <div class="substack-linker-title">${escapeHtml(post.title)}</div>
        <button class="substack-linker-remove" data-url="${escapeHtml(post.url)}">${ICON_X}</button>
      </div>
    `).join('');

    // Add click handlers
    panel.querySelectorAll('.substack-linker-item').forEach(item => {
      item.addEventListener('mousedown', (e) => {
        // Ignore if clicking the remove button
        if (e.target.closest('.substack-linker-remove')) return;
        e.preventDefault();
        const index = parseInt(item.dataset.index, 10);
        selectPost(filteredPosts[index]);
      });

      item.addEventListener('mouseenter', () => {
        selectedIndex = parseInt(item.dataset.index, 10);
        updateSelection();
      });
    });

    // Add remove button handlers
    panel.querySelectorAll('.substack-linker-remove').forEach(btn => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = btn.dataset.url;
        const post = filteredPosts.find(p => p.url === url);
        if (post) confirmRemovePost(post);
      });
    });
  }

  // Show confirmation to remove a post
  function confirmRemovePost(post) {
    if (!panel) return;

    panel.innerHTML = `
      <div class="substack-linker-confirm">
        <div class="substack-linker-confirm-title">Remove "${escapeHtml(post.title)}" from the link panel?</div>
        <div class="substack-linker-confirm-subtitle">This won't delete the post from Substack.</div>
        <div class="substack-linker-confirm-actions">
          <button class="substack-linker-confirm-remove">Remove</button>
          <button class="substack-linker-confirm-cancel">Cancel</button>
        </div>
      </div>
    `;

    panel.querySelector('.substack-linker-confirm-remove').addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removePost(post.url);
    });

    panel.querySelector('.substack-linker-confirm-cancel').addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const filteredPosts = filterPosts(triggerContext?.query || '');
      renderResults(filteredPosts);
    });
  }

  // Remove a post from storage and re-render
  async function removePost(url) {
    posts = posts.filter(p => p.url !== url);
    await chrome.storage.local.set({ posts });

    const filteredPosts = filterPosts(triggerContext?.query || '');
    if (filteredPosts.length > 0) {
      selectedIndex = Math.min(selectedIndex, filteredPosts.length - 1);
      renderResults(filteredPosts);
    } else {
      panel.innerHTML = '<div class="substack-linker-empty">No posts found</div>';
    }
  }

  // Escape HTML for safe rendering
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Update visual selection
  function updateSelection() {
    if (!panel) return;

    const items = panel.querySelectorAll('.substack-linker-item');
    items.forEach((item, i) => {
      item.classList.toggle('selected', i === selectedIndex);
    });

    // Scroll selected item into view
    const selected = panel.querySelector('.selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  // Show the panel
  function showPanel() {
    if (!panel) {
      panel = createPanel();
    }
    panel.style.display = 'block';
    selectedIndex = 0;
  }

  // Hide the panel
  function hidePanel() {
    if (panel) {
      panel.style.display = 'none';
    }
    triggerContext = null;
  }

  // Select a post and insert it
  function selectPost(post) {
    if (!post || !triggerContext) return;

    const { textNode, triggerIndex, cursorOffset } = triggerContext;
    const editor = textNode.parentElement?.closest('[contenteditable="true"]');

    // Delete the [[ and search query
    const beforeTrigger = textNode.textContent.slice(0, triggerIndex);
    const afterCursor = textNode.textContent.slice(cursorOffset);
    textNode.textContent = beforeTrigger + afterCursor;

    // Create a range at the deletion point
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode, triggerIndex);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    // Re-focus the editor
    if (editor) {
      editor.focus();
    }

    // Dispatch a synthetic paste event with the URL
    // This mimics a real Cmd+V and triggers ProseMirror's link detection
    const dt = new DataTransfer();
    dt.setData('text/plain', post.url);

    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt
    });

    const pasteTarget = editor || textNode.parentElement;
    pasteTarget.dispatchEvent(pasteEvent);

    hidePanel();
  }

  // Handle input events on contenteditable
  function handleInput(e) {
    const target = e.target;

    if (!isSubstackEditor(target)) return;
    if (posts.length === 0) return;

    triggerContext = checkForTrigger();

    if (triggerContext) {
      const filteredPosts = filterPosts(triggerContext.query);
      showPanel();
      renderResults(filteredPosts);
      positionPanel();
    } else {
      hidePanel();
    }
  }

  // Handle keyboard navigation
  function handleKeydown(e) {
    if (!panel || panel.style.display === 'none') return;

    const filteredPosts = filterPosts(triggerContext?.query || '');

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % filteredPosts.length;
        updateSelection();
        break;

      case 'ArrowUp':
        e.preventDefault();
        selectedIndex = (selectedIndex - 1 + filteredPosts.length) % filteredPosts.length;
        updateSelection();
        break;

      case 'Enter':
        e.preventDefault();
        selectPost(filteredPosts[selectedIndex]);
        break;

      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        hidePanel();
        break;

      case 'Backspace':
        // Check if we've deleted back past [[
        setTimeout(() => {
          if (!checkForTrigger()) {
            hidePanel();
          }
        }, 0);
        break;
    }
  }

  // Handle clicks outside the panel
  function handleClickOutside(e) {
    if (panel && panel.style.display !== 'none') {
      if (!panel.contains(e.target)) {
        hidePanel();
      }
    }
  }

  // Set up event listeners
  document.addEventListener('input', handleInput, true);
  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('mousedown', handleClickOutside, true);

  // Handle scroll to reposition panel
  document.addEventListener('scroll', () => {
    if (panel && panel.style.display !== 'none') {
      positionPanel();
    }
  }, true);

})();
