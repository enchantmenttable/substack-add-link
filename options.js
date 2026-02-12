// Parse newsletter URL from various input formats
function parseNewsletterUrl(input) {
  let url = input.trim();
  // Add https if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  // Parse and return origin (removes paths, trailing slashes)
  try {
    const urlObj = new URL(url);
    return urlObj.origin;
  } catch (e) {
    return null;
  }
}

// Parse CSV content into array of objects
function parseCSV(content) {
  const lines = content.split('\n');
  if (lines.length < 2) {
    throw new Error('CSV file appears to be empty');
  }

  // Parse header row
  const headers = parseCSVLine(lines[0]);
  const requiredColumns = ['post_id', 'title', 'is_published', 'post_date'];
  const columnIndices = {};

  for (const col of requiredColumns) {
    const index = headers.findIndex(h => h.toLowerCase() === col.toLowerCase());
    if (index === -1) {
      throw new Error(`Missing required column: ${col}`);
    }
    columnIndices[col] = index;
  }

  // Parse data rows
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);

    // Skip if not published
    const isPublished = values[columnIndices['is_published']];
    if (isPublished !== 'true') continue;

    const postId = values[columnIndices['post_id']];
    const title = values[columnIndices['title']];
    const postDate = values[columnIndices['post_date']];

    // Extract slug from post_id
    if (!postId || !postId.includes('.')) continue;
    const slug = postId.split('.', 2)[1];
    if (!slug) continue;

    rows.push({
      title: title || 'Untitled',
      slug,
      date: postDate
    });
  }

  return rows;
}

// Parse a single CSV line, handling quoted fields
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else if (char === '"') {
        // End of quoted field
        inQuotes = false;
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        // Start of quoted field
        inQuotes = true;
      } else if (char === ',') {
        // Field separator
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }

  // Push last field
  result.push(current);

  return result;
}

// Build full URLs and sort by date
function buildPostData(rows, newsletterUrl) {
  const posts = rows.map(row => ({
    title: row.title,
    url: `${newsletterUrl}/p/${row.slug}`,
    date: row.date
  }));

  // Sort by date descending (newest first)
  posts.sort((a, b) => {
    const dateA = new Date(a.date);
    const dateB = new Date(b.date);
    return dateB - dateA;
  });

  return posts;
}

// Format a timestamp as "Jan 12, 2025"
function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

// DOM elements
const form = document.getElementById('settings-form');
const newsletterUrlInput = document.getElementById('newsletter-url');
const fileInput = document.getElementById('csv-file');
const fileNameSpan = document.getElementById('file-name');
const statusDiv = document.getElementById('status');
const statsDiv = document.getElementById('stats');
const statsUrl = document.getElementById('stats-url');
const statsCount = document.getElementById('stats-count');
const deleteBtn = document.getElementById('delete-btn');
const saveBtn = document.getElementById('save-btn');

// Track whether form has unsaved changes
let formDirty = false;

// Enable/disable save button based on form state
function updateSaveButton() {
  const hasUrl = newsletterUrlInput.value.trim().length > 0;
  saveBtn.disabled = !(hasUrl && formDirty);
}

// Page navigation elements
const pageMain = document.getElementById('page-main');
const pageInstructions = document.getElementById('page-instructions');
const howToLink = document.getElementById('how-to-link');
const backBtn = document.getElementById('back-btn');
const fileInputInstructions = document.getElementById('csv-file-instructions');
const fileNameInstructions = document.getElementById('file-name-instructions');

// Page navigation
function showInstructions() {
  pageMain.style.opacity = '0';
  setTimeout(() => {
    pageMain.classList.add('hidden');
    pageInstructions.classList.add('visible');
  }, 150);
}

function showMain() {
  pageInstructions.style.opacity = '0';
  setTimeout(() => {
    pageInstructions.classList.remove('visible');
    pageInstructions.style.opacity = '';
    pageMain.classList.remove('hidden');
    pageMain.style.opacity = '';
  }, 150);
}

howToLink.addEventListener('click', showInstructions);
backBtn.addEventListener('click', showMain);

// Show file name when selected
fileInput.addEventListener('change', () => {
  if (fileInput.files.length > 0) {
    fileNameSpan.textContent = fileInput.files[0].name;
  } else {
    fileNameSpan.textContent = 'No file selected';
  }
  formDirty = true;
  updateSaveButton();
});

newsletterUrlInput.addEventListener('input', () => {
  formDirty = true;
  updateSaveButton();
});

// Sync instruction page file input with main form
fileInputInstructions.addEventListener('change', () => {
  if (fileInputInstructions.files.length > 0) {
    fileNameInstructions.textContent = fileInputInstructions.files[0].name;

    // Copy the file to the main form's input
    const dt = new DataTransfer();
    dt.items.add(fileInputInstructions.files[0]);
    fileInput.files = dt.files;
    fileNameSpan.textContent = fileInputInstructions.files[0].name;

    // Navigate back to main page
    showMain();
    formDirty = true;
    updateSaveButton();
  }
});

// Show status message
function showStatus(message, isError = false, type = null) {
  statusDiv.className = 'status ' + (type || (isError ? 'error' : 'success'));
  if (type === 'loading') {
    statusDiv.innerHTML = `<span>${message}</span><button class="stop-btn" id="stop-fetch-btn">Stop</button>`;
  } else {
    statusDiv.textContent = message;
  }
}

// Load and display current stats
async function loadStats() {
  const data = await chrome.storage.local.get(['newsletterUrl', 'posts', 'csvUploadDate']);

  if (data.newsletterUrl && data.posts && data.posts.length > 0) {
    statsUrl.textContent = `Newsletter: ${data.newsletterUrl}`;
    statsCount.textContent = `Posts indexed: ${data.posts.length}`;
    statsDiv.classList.add('visible');

    // Pre-fill URL input
    newsletterUrlInput.value = data.newsletterUrl.replace('https://', '');
    updateSaveButton();
  }

  // Show persisted upload date if no new file is selected
  if (data.csvUploadDate && fileInput.files.length === 0) {
    fileNameSpan.textContent = `posts.csv (uploaded ${formatDate(data.csvUploadDate)})`;
  }
}

// Disable/enable form fields during fetch
function setFormLocked(locked) {
  newsletterUrlInput.disabled = locked;
  fileInput.disabled = locked;
  saveBtn.disabled = locked;
}

// Form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  document.activeElement?.blur();

  const newsletterUrl = parseNewsletterUrl(newsletterUrlInput.value);
  if (!newsletterUrl) {
    showStatus('Please enter a valid newsletter URL.', true);
    return;
  }

  const file = fileInput.files[0];

  try {
    // If a CSV file is selected, parse and save it
    if (file) {
      const content = await file.text();
      const rows = parseCSV(content);

      if (rows.length === 0) {
        showStatus('No published posts found in the CSV file.', true);
        return;
      }

      const posts = buildPostData(rows, newsletterUrl);
      const csvUploadDate = Date.now();
      await chrome.storage.local.set({ newsletterUrl, posts, csvUploadDate });

      // Update file name display with upload date
      fileNameSpan.textContent = `posts.csv (uploaded ${formatDate(csvUploadDate)})`;
    } else {
      // No file — just save the URL
      await chrome.storage.local.set({ newsletterUrl });
    }

    // Lock form and show loading status
    setFormLocked(true);
    showStatus('Fetching posts...', false, 'loading');

    // Set up stop button
    let stopped = false;
    const stopBtn = document.getElementById('stop-fetch-btn');
    stopBtn?.addEventListener('click', () => {
      stopped = true;
      chrome.runtime.sendMessage({ action: 'stopFetch' }).catch(() => {});
      showStatus('Stopping...', false, 'loading');
    });

    const onProgress = (message) => {
      if (message.action === 'fetchProgress' && !stopped) {
        showStatus(`Fetching posts... (${message.count} found)`, false, 'loading');
        // Re-attach stop button listener after innerHTML update
        document.getElementById('stop-fetch-btn')?.addEventListener('click', () => {
          stopped = true;
          chrome.runtime.sendMessage({ action: 'stopFetch' }).catch(() => {});
          showStatus('Stopping...', false, 'loading');
        });
      }
    };
    chrome.runtime.onMessage.addListener(onProgress);

    let fetchFailed = false;
    try {
      const result = await chrome.runtime.sendMessage({ action: 'fetchPosts' });
      if (result?.error) fetchFailed = true;
    } catch (e) {
      fetchFailed = true;
    }
    chrome.runtime.onMessage.removeListener(onProgress);
    setFormLocked(false);

    const data = await chrome.storage.local.get(['posts']);
    const total = data.posts?.length || 0;

    if (stopped && total > 0) {
      showStatus(`Saved ${total} posts found so far. You can close this page now.`);
    } else if (fetchFailed && total === 0) {
      showStatus('Could not fetch posts. Please make sure the newsletter URL is correct.', true);
    } else if (fetchFailed) {
      showStatus(`Saved ${total} posts, but could not reach the newsletter. Please check the URL.`, true);
    } else {
      showStatus(`Successfully imported ${total} posts. You can close this page now.`);
    }
    formDirty = false;
    updateSaveButton();
    loadStats();

  } catch (error) {
    setFormLocked(false);
    showStatus(`Error: ${error.message}`, true);
  }
});

// Delete all data
deleteBtn.addEventListener('click', async () => {
  if (confirm('Are you sure you want to delete all data?')) {
    await chrome.storage.local.clear();
    statsDiv.classList.remove('visible');
    newsletterUrlInput.value = '';
    fileNameSpan.textContent = 'No file selected';
    fileInput.value = '';
    showStatus('All data deleted.');
  }
});

// Load stats on page load
loadStats();
