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

function extractDraftFromCurrentPage(requestedType) {
  function firstUsefulParagraphFromDocument() {
    const selectors = [
      '#mw-content-text .mw-parser-output > p',
      'article p',
      'main p',
      'p'
    ];

    for (const selector of selectors) {
      const paragraph = Array.from(document.querySelectorAll(selector))
        .map(p => (p.innerText || p.textContent || '').replace(/\s+/g, ' ').trim())
        .find(text => text.length > 80);

      if (paragraph) return paragraph;
    }

    return '';
  }

  function imageFromDocument() {
    const infoboxImage = document.querySelector('.infobox img');
    if (infoboxImage?.src) return infoboxImage.src;

    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage?.content) return ogImage.content;

    const firstArticleImage = document.querySelector('article img, main img, img');
    if (firstArticleImage?.src) return firstArticleImage.src;

    return '';
  }

  function cleanPageTitleFromDocument(rawTitle, isWikipedia) {
    const title = (rawTitle || '').replace(/\s+/g, ' ').trim();
    if (!isWikipedia) return title;
    return title.replace(/\s*-\s*Wikipedia\s*$/i, '').trim();
  }

  function yearsFromText(rawText) {
    return Array.from(String(rawText || '').matchAll(/(?:1[0-9]{3}|20[0-9]{2})/g)).map(match => match[0]);
  }

  function yearFromStructuredDate(selectorList) {
    const text = Array.from(document.querySelectorAll(selectorList))
      .map(el => el.getAttribute('datetime') || el.textContent || '')
      .join(' ');
    return yearsFromText(text)[0] || '';
  }

  function infoboxRowYear(labelPattern) {
    const rows = Array.from(document.querySelectorAll('.infobox tr'));
    for (const row of rows) {
      const header = (row.querySelector('th')?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!labelPattern.test(header)) continue;
      const years = yearsFromText(row.textContent || '');
      if (years.length) return years[0];
    }
    return '';
  }

  function yearsFromLifespanText(text) {
    const source = String(text || '').replace(/\s+/g, ' ');
    const parentheticals = Array.from(source.matchAll(/\(([^)]*[–—-][^)]*)\)/g)).map(match => match[1]);
    for (const segment of parentheticals) {
      const years = yearsFromText(segment);
      if (years.length >= 2) {
        return { birth: years[0], death: years[years.length - 1] };
      }
    }

    const directYears = source.match(/(?:born\s+)?([^.;]{0,80})(?:1[0-9]{3}|20[0-9]{2})[^.;]{0,60}[–—-][^.;]{0,60}(?:1[0-9]{3}|20[0-9]{2})/i);
    if (directYears) {
      const years = yearsFromText(directYears[0]);
      if (years.length >= 2) return { birth: years[0], death: years[years.length - 1] };
    }

    return { birth: '', death: '' };
  }

  function parseYearsFromDocument(text) {
    const birthFromBday = yearFromStructuredDate('.bday, .birthdate, .birth-date, time[itemprop="birthDate"]');
    const deathFromDday = yearFromStructuredDate('.dday, .deathdate, .death-date, time[itemprop="deathDate"]');

    const birthFromInfobox = infoboxRowYear(/^(born|birth)$/i);
    const deathFromInfobox = infoboxRowYear(/^(died|death)$/i);

    const lifespanYears = yearsFromLifespanText(text);

    return {
      birth: birthFromBday || birthFromInfobox || lifespanYears.birth || '',
      death: deathFromDday || deathFromInfobox || lifespanYears.death || ''
    };
  }

  function extractWikidataIdFromDocument() {
    const wikidataLink = document.querySelector('li#t-wikibase a, a[href*="wikidata.org/wiki/Q"]');
    const href = wikidataLink?.href || '';
    return href.match(/\/wiki\/(Q\d+)/)?.[1] || '';
  }

  function titleFromWikipediaUrl(href) {
    try {
      const url = new URL(href, window.location.href);
      const marker = '/wiki/';
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex === -1) return '';
      const encodedTitle = url.pathname.slice(markerIndex + marker.length);
      return decodeURIComponent(encodedTitle).replace(/_/g, ' ').trim();
    } catch (err) {
      return '';
    }
  }

  function extractJapaneseWikipediaInfoFromDocument() {
    const candidates = Array.from(document.querySelectorAll([
      'link[rel="alternate"][hreflang="ja"]',
      'a[hreflang="ja"]',
      'li.interlanguage-link.interwiki-ja a',
      'a[href^="https://ja.wikipedia.org/wiki/"]'
    ].join(',')));

    const href = candidates
      .map(el => el.href || el.getAttribute('href') || '')
      .find(value => /https?:\/\/ja\.wikipedia\.org\/wiki\//i.test(value)) || '';

    return {
      url: href,
      title: href ? titleFromWikipediaUrl(href) : ''
    };
  }

  const hostname = window.location.hostname;
  const isWikipedia = /(^|\.)wikipedia\.org$/i.test(hostname);
  const title = cleanPageTitleFromDocument(document.title, isWikipedia);
  const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href || window.location.href;
  const firstParagraph = firstUsefulParagraphFromDocument();
  const imgURL = imageFromDocument();
  const years = parseYearsFromDocument(firstParagraph);
  const wikidataQID = extractWikidataIdFromDocument();
  const japaneseWikipedia = isWikipedia ? extractJapaneseWikipediaInfoFromDocument() : { title: '', url: '' };
  const inferredType = isWikipedia ? 'theorist' : 'artworkBook';
  const proposedType = requestedType === 'auto' ? inferredType : requestedType;
  const capturedAt = new Date().toISOString();

  const proposedInfo = {
    label: title,
    label_jp: japaneseWikipedia.title || '',
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
        death: years.death,
        wikidataQID,
        japaneseWikipediaTitle: japaneseWikipedia.title,
        japaneseWikipediaUrl: japaneseWikipedia.url
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
