const statusEl = document.getElementById('status');
const previewEl = document.getElementById('payload-preview');
const captureButton = document.getElementById('capture-page');
const typeSelect = document.getElementById('capture-type');
const portInput = document.getElementById('modifier-port');

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.classList.toggle('status-error', kind === 'error');
  statusEl.classList.toggle('status-ok', kind === 'ok');
}

function getExtensionApi() {
  if (typeof browser !== 'undefined') return browser;
  if (typeof chrome !== 'undefined') return chrome;
  throw new Error('No browser extension API found.');
}

function tabQuery(api, queryInfo) {
  if (api.tabs.query.length === 1) {
    return api.tabs.query(queryInfo);
  }

  return new Promise((resolve, reject) => {
    api.tabs.query(queryInfo, tabs => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tabs);
    });
  });
}

function executeScript(api, details) {
  if (api.scripting.executeScript.length === 1) {
    return api.scripting.executeScript(details);
  }

  return new Promise((resolve, reject) => {
    api.scripting.executeScript(details, results => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve(results);
    });
  });
}

function firstUsefulParagraph() {
  const selectors = [
    '#mw-content-text .mw-parser-output > p',
    'article p',
    'main p',
    'p'
  ];

  for (const selector of selectors) {
    const paragraph = Array.from(document.querySelectorAll(selector))
      .map(p => (p.innerText || '').replace(/\s+/g, ' ').trim())
      .find(text => text.length > 80);

    if (paragraph) return paragraph;
  }

  return '';
}

function imageFromPage() {
  const infoboxImage = document.querySelector('.infobox img');
  if (infoboxImage?.src) return infoboxImage.src;

  const ogImage = document.querySelector('meta[property="og:image"]');
  if (ogImage?.content) return ogImage.content;

  const firstArticleImage = document.querySelector('article img, main img, img');
  if (firstArticleImage?.src) return firstArticleImage.src;

  return '';
}

function cleanPageTitle(rawTitle, isWikipedia) {
  const title = (rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!isWikipedia) return title;
  return title.replace(/\s*-\s*Wikipedia\s*$/i, '').trim();
}

function parseYearsFromText(text) {
  const rangeMatch = text.match(/(?:\(|\b)(\d{3,4})\s*[–—-]\s*(\d{3,4})(?:\)|\b)/);
  if (rangeMatch) {
    return { birth: rangeMatch[1], death: rangeMatch[2] };
  }

  const bday = document.querySelector('.bday')?.textContent?.trim() || '';
  const bdayYear = bday.match(/(\d{3,4})/)?.[1] || '';
  return { birth: bdayYear, death: '' };
}

function extractDraftFromCurrentPage(requestedType) {
  const hostname = window.location.hostname;
  const isWikipedia = /(^|\.)wikipedia\.org$/i.test(hostname);
  const title = cleanPageTitle(document.title, isWikipedia);
  const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href || window.location.href;
  const firstParagraph = firstUsefulParagraph();
  const imgURL = imageFromPage();
  const years = parseYearsFromText(firstParagraph);
  const inferredType = isWikipedia ? 'theorist' : 'artworkBook';
  const proposedType = requestedType === 'auto' ? inferredType : requestedType;
  const capturedAt = new Date().toISOString();

  const proposedInfo = {
    label: title,
    type: proposedType,
    note: firstParagraph,
    note_jp: '',
    imgURL
  };

  if (proposedType === 'theorist' || proposedType === 'artist') {
    proposedInfo.birth = years.birth;
    proposedInfo.death = years.death;
  }

  if (proposedType === 'artworkBook') {
    proposedInfo.date = '';
    proposedInfo.article = '';
  }

  return {
    proposedType,
    proposedInfo,
    sourceMeta: {
      source: isWikipedia ? 'browser-wikipedia-page' : 'browser-generic-page',
      capturedAt,
      raw: {
        title,
        documentTitle: document.title,
        url: window.location.href,
        canonicalUrl,
        hostname,
        isWikipedia,
        requestedType,
        inferredType,
        firstParagraph,
        imgURL,
        birth: years.birth,
        death: years.death
      }
    },
    duplicateWarnings: []
  };
}

async function captureCurrentPage() {
  setStatus('Capturing current page...');
  previewEl.textContent = '';

  const api = getExtensionApi();
  const [tab] = await tabQuery(api, { active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error('Could not identify the active tab.');
  }

  const requestedType = typeSelect.value || 'auto';
  const results = await executeScript(api, {
    target: { tabId: tab.id },
    func: extractDraftFromCurrentPage,
    args: [requestedType]
  });

  const draftRecord = results?.[0]?.result;
  if (!draftRecord) {
    throw new Error('The page did not return a draft record.');
  }

  previewEl.textContent = JSON.stringify(draftRecord, null, 2);

  const port = (portInput.value || '3000').trim();
  const response = await fetch(`http://localhost:${port}/api/draft-capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draftRecord })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Modifier app returned ${response.status}.`);
  }

  setStatus('Captured. Return to the modifier app and click “Load Latest Browser Capture”.', 'ok');
}

captureButton.addEventListener('click', async () => {
  captureButton.disabled = true;
  try {
    await captureCurrentPage();
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), 'error');
  } finally {
    captureButton.disabled = false;
  }
});
