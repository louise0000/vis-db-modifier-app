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
  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function firstNonEmpty(...values) {
    return values.map(cleanText).find(Boolean) || '';
  }

  function contentFromSelector(selector, attr = 'content') {
    const el = document.querySelector(selector);
    return cleanText(el?.getAttribute(attr) || el?.content || el?.textContent || '');
  }

  function metaByNames(names) {
    for (const name of names) {
      const escaped = String(name).replace(/"/g, '\\"');
      const value = contentFromSelector(`meta[name="${escaped}"], meta[itemprop="${escaped}"]`);
      if (value) return value;
    }
    return '';
  }

  function metaByProperties(properties) {
    for (const property of properties) {
      const escaped = String(property).replace(/"/g, '\\"');
      const value = contentFromSelector(`meta[property="${escaped}"], meta[name="${escaped}"]`);
      if (value) return value;
    }
    return '';
  }

  function valuesFromSelectors(selectors, attr = 'content') {
    return selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)))
      .map(el => cleanText(el.getAttribute(attr) || el.content || el.currentSrc || el.src || el.href || el.textContent || ''))
      .filter(Boolean);
  }

  function toArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  }

  function normaliseSchemaType(typeValue) {
    return toArray(typeValue).map(type => String(type || '').replace(/^https?:\/\/schema\.org\//i, '').trim()).filter(Boolean);
  }

  function parseJsonLdDocuments() {
    const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const parsed = [];

    for (const block of blocks) {
      try {
        const raw = block.textContent || '';
        if (!raw.trim()) continue;
        parsed.push(JSON.parse(raw));
      } catch (err) {
        // Some sites include invalid JSON-LD; ignore and preserve graceful capture.
      }
    }

    return parsed;
  }

  function flattenJsonLd(input, output = []) {
    if (!input) return output;
    if (Array.isArray(input)) {
      input.forEach(item => flattenJsonLd(item, output));
      return output;
    }
    if (typeof input !== 'object') return output;

    output.push(input);
    if (input['@graph']) flattenJsonLd(input['@graph'], output);
    if (input.mainEntity) flattenJsonLd(input.mainEntity, output);
    if (input.about) flattenJsonLd(input.about, output);
    return output;
  }

  function findSchemaEntity(entities, preferredTypes) {
    const lowerPreferred = preferredTypes.map(type => type.toLowerCase());
    return entities.find(entity => {
      const types = normaliseSchemaType(entity['@type']).map(type => type.toLowerCase());
      return types.some(type => lowerPreferred.includes(type));
    }) || null;
  }

  function stringFromSchemaValue(value) {
    if (!value) return '';
    if (typeof value === 'string' || typeof value === 'number') return cleanText(value);
    if (Array.isArray(value)) return firstNonEmpty(...value.map(stringFromSchemaValue));
    if (typeof value === 'object') {
      return firstNonEmpty(value.name, value.headline, value.title, value.url, value['@id']);
    }
    return '';
  }

  function stringsFromSchemaValue(value) {
    return toArray(value).map(stringFromSchemaValue).filter(Boolean);
  }

  function urlsFromSchemaImages(value) {
    const urls = [];
    for (const item of toArray(value)) {
      if (!item) continue;
      if (typeof item === 'string') urls.push(item);
      else if (typeof item === 'object') {
        if (item.url) urls.push(item.url);
        if (item.contentUrl) urls.push(item.contentUrl);
        if (item.thumbnailUrl) urls.push(item.thumbnailUrl);
      }
    }
    return urls.map(cleanText).filter(Boolean);
  }

  function firstUsefulParagraphFromDocument() {
    const selectors = [
      '#mw-content-text .mw-parser-output > p',
      'article p',
      'main p',
      'p'
    ];

    for (const selector of selectors) {
      const paragraph = Array.from(document.querySelectorAll(selector))
        .map(p => cleanText(p.innerText || p.textContent || ''))
        .find(text => text.length > 80);

      if (paragraph) return paragraph;
    }

    return '';
  }

  function addImageCandidate(candidates, url, source, extra = {}) {
    const cleanUrl = cleanText(url);
    if (!cleanUrl || candidates.some(candidate => candidate.url === cleanUrl)) return;
    candidates.push({
      url: cleanUrl,
      source,
      alt: cleanText(extra.alt),
      width: extra.width || '',
      height: extra.height || ''
    });
  }

  function imageCandidatesFromDocument(schemaEntities) {
    const candidates = [];

    const infoboxImage = document.querySelector('.infobox img');
    if (infoboxImage) {
      addImageCandidate(candidates, infoboxImage.currentSrc || infoboxImage.src, 'wikipedia-infobox', {
        alt: infoboxImage.alt,
        width: infoboxImage.naturalWidth || infoboxImage.width || '',
        height: infoboxImage.naturalHeight || infoboxImage.height || ''
      });
    }

    valuesFromSelectors(['meta[property="og:image"]', 'meta[property="og:image:secure_url"]', 'meta[name="twitter:image"]'])
      .forEach(url => addImageCandidate(candidates, url, 'page-meta-image'));

    valuesFromSelectors(['link[rel="image_src"]'], 'href')
      .forEach(url => addImageCandidate(candidates, url, 'image-src-link'));

    schemaEntities.flatMap(entity => urlsFromSchemaImages(entity.image || entity.thumbnailUrl || entity.primaryImageOfPage))
      .forEach(url => addImageCandidate(candidates, url, 'schema-image'));

    Array.from(document.querySelectorAll('article img, main img')).slice(0, 6).forEach(img => {
      addImageCandidate(candidates, img.currentSrc || img.src, 'article-image', {
        alt: img.alt,
        width: img.naturalWidth || img.width || '',
        height: img.naturalHeight || img.height || ''
      });
    });

    return candidates;
  }

  function cleanPageTitleFromDocument(rawTitle, isWikipedia) {
    const title = cleanText(rawTitle);
    if (!isWikipedia) return title.replace(/\s*[|—-]\s*.+$/, '').trim() || title;
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
      const header = cleanText(row.querySelector('th')?.textContent || '');
      if (!labelPattern.test(header)) continue;
      const years = yearsFromText(row.textContent || '');
      if (years.length) return years[0];
    }
    return '';
  }

  function yearsFromLifespanText(text) {
    const source = cleanText(text);
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

  function extractGenericMetadata(schemaEntities) {
    const webPageEntity = findSchemaEntity(schemaEntities, ['WebPage', 'ProfilePage', 'Article', 'NewsArticle', 'ScholarlyArticle', 'BlogPosting', 'Book', 'Movie', 'CreativeWork']) || schemaEntities[0] || {};
    const personEntity = findSchemaEntity(schemaEntities, ['Person']);
    const bookEntity = findSchemaEntity(schemaEntities, ['Book']);
    const articleEntity = findSchemaEntity(schemaEntities, ['ScholarlyArticle', 'Article', 'NewsArticle', 'BlogPosting']);
    const movieEntity = findSchemaEntity(schemaEntities, ['Movie']);
    const creativeEntity = bookEntity || articleEntity || movieEntity || webPageEntity;

    const schemaTypes = schemaEntities.flatMap(entity => normaliseSchemaType(entity['@type']));
    const citationAuthors = valuesFromSelectors(['meta[name="citation_author"]']);
    const schemaAuthors = stringsFromSchemaValue(creativeEntity.author || creativeEntity.creator || webPageEntity.author);
    const schemaPublishers = stringsFromSchemaValue(creativeEntity.publisher || webPageEntity.publisher);

    const citationTitle = metaByNames(['citation_title']);
    const citationDate = metaByNames(['citation_publication_date', 'citation_date', 'citation_online_date']);
    const schemaDate = stringFromSchemaValue(creativeEntity.datePublished || creativeEntity.dateCreated || creativeEntity.dateModified || webPageEntity.datePublished);
    const dateYear = yearsFromText(firstNonEmpty(citationDate, schemaDate, metaByProperties(['article:published_time'])))[0] || '';

    const metadataTitle = firstNonEmpty(
      personEntity?.name,
      creativeEntity?.name,
      creativeEntity?.headline,
      webPageEntity?.name,
      webPageEntity?.headline,
      citationTitle,
      metaByProperties(['og:title', 'twitter:title'])
    );

    const description = firstNonEmpty(
      creativeEntity?.description,
      webPageEntity?.description,
      metaByNames(['citation_abstract', 'description', 'twitter:description']),
      metaByProperties(['og:description'])
    );

    return {
      schemaTypes,
      metadataTitle,
      description,
      dateYear,
      authors: citationAuthors.length ? citationAuthors : schemaAuthors,
      publisher: firstNonEmpty(...schemaPublishers, metaByNames(['citation_publisher'])),
      publicationTitle: firstNonEmpty(metaByNames(['citation_journal_title', 'citation_conference_title', 'citation_book_title']), stringFromSchemaValue(creativeEntity.isPartOf)),
      doi: metaByNames(['citation_doi']),
      isbn: firstNonEmpty(metaByNames(['citation_isbn']), stringFromSchemaValue(bookEntity?.isbn)),
      pdfUrl: metaByNames(['citation_pdf_url']),
      contentKind: personEntity ? 'person' : bookEntity ? 'book' : articleEntity ? 'article' : movieEntity ? 'movie' : ''
    };
  }

  function textFromSelectors(selectors) {
    for (const selector of selectors) {
      const value = Array.from(document.querySelectorAll(selector))
        .map(el => cleanText(el.innerText || el.textContent || el.getAttribute('content') || ''))
        .find(Boolean);
      if (value) return value;
    }
    return '';
  }

  function bodyTextSnippet() {
    return cleanText(document.body?.innerText || '').slice(0, 120000);
  }

  function yearFromAnyDateText(text) {
    const years = yearsFromText(text);
    return years[0] || '';
  }

  function extractFieldAfterLabel(text, labels) {
    const lines = String(text || '').split(/\n|\r/).map(cleanText).filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const label of labels) {
        const pattern = new RegExp(`^${label}\\s*[:：]?\\s*(.+)$`, 'i');
        const inlineMatch = line.match(pattern);
        if (inlineMatch?.[1]) return cleanText(inlineMatch[1]);
        if (new RegExp(`^${label}$`, 'i').test(line) && lines[index + 1]) return lines[index + 1];
      }
    }
    return '';
  }

  function cleanAmazonAuthor(rawAuthor) {
    return cleanText(rawAuthor)
      .replace(/^by\s+/i, '')
      .replace(/\s*\(Author\).*$/i, '')
      .replace(/\s*Visit Amazon's .+? Store.*$/i, '')
      .replace(/\s+and\s+\d+\s+more.*$/i, '')
      .trim();
  }

  function extractAmazonBookMetadata(schemaEntities) {
    const hostname = window.location.hostname;
    if (!/(^|\.)amazon\./i.test(hostname)) return null;

    const pageText = document.body?.innerText || '';
    const compactPageText = cleanText(pageText);
    const bookEntity = findSchemaEntity(schemaEntities, ['Book']) || {};

    const title = firstNonEmpty(
      textFromSelectors(['#productTitle', '#ebooksProductTitle', 'h1#title span']),
      stringFromSchemaValue(bookEntity.name)
    );

    const author = firstNonEmpty(
      ...valuesFromSelectors(['.author .a-link-normal', '#bylineInfo .author a', '#bylineInfo a']),
      cleanAmazonAuthor(textFromSelectors(['#bylineInfo']))
    );

    const productDetailsText = Array.from(document.querySelectorAll('#detailBullets_feature_div, #productDetailsTable, #detailBulletsWrapper_feature_div, table#productDetails_techSpec_section_1, table#productDetails_detailBullets_sections1'))
      .map(el => el.innerText || el.textContent || '')
      .join('\n');
    const detailsSource = productDetailsText || pageText;

    const publisherLine = extractFieldAfterLabel(detailsSource, ['Publisher']);
    const publisher = firstNonEmpty(
      stringFromSchemaValue(bookEntity.publisher),
      publisherLine.replace(/\s*\([^)]*\)\s*$/, '')
    );

    const publicationDate = firstNonEmpty(
      extractFieldAfterLabel(detailsSource, ['Publication date', 'Publication Date']),
      publisherLine.match(/\(([^)]*(?:1[0-9]{3}|20[0-9]{2})[^)]*)\)/)?.[1] || '',
      stringFromSchemaValue(bookEntity.datePublished)
    );

    const isbn13 = firstNonEmpty(
      extractFieldAfterLabel(detailsSource, ['ISBN-13']),
      compactPageText.match(/ISBN-13\s*[:‏‎ ]+\s*([0-9\-]{10,})/i)?.[1] || ''
    ).replace(/[^0-9Xx-]/g, '');
    const isbn10 = firstNonEmpty(
      extractFieldAfterLabel(detailsSource, ['ISBN-10']),
      compactPageText.match(/ISBN-10\s*[:‏‎ ]+\s*([0-9Xx\-]{8,})/i)?.[1] || ''
    ).replace(/[^0-9Xx-]/g, '');

    const description = textFromSelectors([
      '#bookDescription_feature_div noscript',
      '#bookDescription_feature_div',
      '#productDescription',
      '#aplus_feature_div p'
    ]).replace(/^Book Description\s*/i, '').trim();

    return {
      source: 'browser-amazon-book-page',
      contentKind: 'book',
      title,
      authors: author ? [author] : [],
      publisher,
      dateYear: yearFromAnyDateText(publicationDate),
      isbn: isbn13 || isbn10,
      description,
      suppressGenericDescription: true,
      suppressArticleFallback: true,
      siteRaw: {
        amazonTitle: title,
        amazonAuthor: author,
        publisherLine,
        publicationDate,
        isbn13,
        isbn10
      }
    };
  }

  function extractImdbMovieMetadata(schemaEntities) {
    const hostname = window.location.hostname;
    if (!/(^|\.)imdb\.com$/i.test(hostname) || !/\/title\/tt\d+/i.test(window.location.pathname)) return null;

    const movieEntity = findSchemaEntity(schemaEntities, ['Movie']) || {};
    const documentTitle = cleanText(document.title || '');
    const titleFromDocument = cleanText(documentTitle.replace(/\s*-\s*IMDb\s*$/i, '').replace(/\s*\(\d{4}\).*$/, ''));
    const primaryTitle = firstNonEmpty(
      textFromSelectors(['[data-testid="hero__primary-text"]', 'h1[data-testid="hero__pageTitle"] span', 'h1']),
      titleFromDocument,
      stringFromSchemaValue(movieEntity.name)
    );
    const originalTitle = textFromSelectors(['[data-testid="hero__original-title"]']).replace(/^Original title:\s*/i, '');

    const yearFromTitle = documentTitle.match(/\((\d{4})\)/)?.[1] || '';
    const yearFromHero = textFromSelectors(['[data-testid="hero__pageTitle"] ~ ul a[href*="releaseinfo"]', 'a[href*="releaseinfo"]']).match(/\b(1[0-9]{3}|20[0-9]{2})\b/)?.[1] || '';
    const yearFromSchema = yearFromAnyDateText(stringFromSchemaValue(movieEntity.datePublished));

    return {
      source: 'browser-imdb-title-page',
      contentKind: 'movie',
      title: primaryTitle,
      dateYear: yearFromTitle || yearFromHero || yearFromSchema,
      description: stringFromSchemaValue(movieEntity.description) || metaByProperties(['og:description']),
      suppressArticleFallback: true,
      siteRaw: {
        imdbTitle: primaryTitle,
        imdbOriginalTitle: originalTitle,
        imdbDocumentTitle: documentTitle,
        imdbYearFromDocumentTitle: yearFromTitle,
        imdbYearFromHero: yearFromHero,
        imdbYearFromSchema: yearFromSchema
      }
    };
  }

  function extractGoodreadsBookMetadata(schemaEntities) {
    const hostname = window.location.hostname;
    if (!/(^|\.)goodreads\.com$/i.test(hostname)) return null;

    const pageText = document.body?.innerText || '';
    const title = firstNonEmpty(
      textFromSelectors(['h1[data-testid="bookTitle"]', '#bookTitle', 'h1']),
      metaByProperties(['og:title'])
    ).replace(/\s+by\s+.+$/i, '');
    const author = firstNonEmpty(
      textFromSelectors(['span.ContributorLink__name', 'a.ContributorLink', '.authorName span', '.authorName']),
      metaByNames(['author'])
    );
    const firstPublished = firstNonEmpty(
      pageText.match(/First published\s+([^\n]+)/i)?.[1] || '',
      pageText.match(/Published\s+([^\n]+)/i)?.[1] || ''
    );
    const description = textFromSelectors(['[data-testid="description"]', '#description span:last-child', '#description']);

    return {
      source: 'browser-goodreads-book-page',
      contentKind: 'book',
      title,
      authors: author ? [author] : [],
      dateYear: yearFromAnyDateText(firstPublished),
      description,
      suppressGenericDescription: true,
      suppressArticleFallback: true,
      siteRaw: {
        goodreadsTitle: title,
        goodreadsAuthor: author,
        goodreadsPublishedText: firstPublished
      }
    };
  }

  function extractGoogleBooksMetadata(schemaEntities) {
    const hostname = window.location.hostname;
    if (!/(^|\.)books\.google\./i.test(hostname)) return null;

    const pageText = document.body?.innerText || '';
    const title = firstNonEmpty(textFromSelectors(['h1', '#book-title']), metaByProperties(['og:title'])).replace(/\s*-\s*Google Books\s*$/i, '');
    const author = firstNonEmpty(
      textFromSelectors(['a[href*="inauthor:"]', '.addmd']),
      pageText.match(/By\s+([^\n]+)/i)?.[1] || ''
    );
    const publisherLine = pageText.match(/(?:Publisher|Published by)\s*[:\n]\s*([^\n]+)/i)?.[1] || '';
    const description = firstNonEmpty(metaByNames(['description']), textFromSelectors(['#synopsistext', '.bookDescription']));

    return {
      source: 'browser-google-books-page',
      contentKind: 'book',
      title,
      authors: author ? [cleanText(author.replace(/^By\s+/i, ''))] : [],
      publisher: publisherLine,
      dateYear: yearFromAnyDateText(publisherLine || pageText.match(/Published\s+([^\n]+)/i)?.[1] || ''),
      description,
      suppressGenericDescription: true,
      suppressArticleFallback: true,
      siteRaw: {
        googleBooksTitle: title,
        googleBooksAuthor: author,
        googleBooksPublisherLine: publisherLine
      }
    };
  }

  function extractSiteSpecificMetadata(schemaEntities) {
    return extractImdbMovieMetadata(schemaEntities)
      || extractAmazonBookMetadata(schemaEntities)
      || extractGoodreadsBookMetadata(schemaEntities)
      || extractGoogleBooksMetadata(schemaEntities)
      || null;
  }

  const hostname = window.location.hostname;
  const isWikipedia = /(^|\.)wikipedia\.org$/i.test(hostname);
  const canonicalUrl = document.querySelector('link[rel="canonical"]')?.href || window.location.href;
  const firstParagraph = firstUsefulParagraphFromDocument();
  const jsonLdDocuments = parseJsonLdDocuments();
  const schemaEntities = flattenJsonLd(jsonLdDocuments);
  const genericMetadata = extractGenericMetadata(schemaEntities);
  const siteMetadata = extractSiteSpecificMetadata(schemaEntities);
  const imageCandidates = imageCandidatesFromDocument(schemaEntities);
  const imgURL = imageCandidates[0]?.url || '';

  const rawTitle = firstNonEmpty(siteMetadata?.title, genericMetadata.metadataTitle, document.title);
  const title = cleanPageTitleFromDocument(rawTitle, isWikipedia);
  const description = siteMetadata?.suppressGenericDescription
    ? cleanText(siteMetadata?.description || '')
    : firstNonEmpty(siteMetadata?.description, genericMetadata.description, firstParagraph);
  const years = parseYearsFromDocument(firstNonEmpty(firstParagraph, description));
  const wikidataQID = extractWikidataIdFromDocument();
  const japaneseWikipedia = isWikipedia ? extractJapaneseWikipediaInfoFromDocument() : { title: '', url: '' };

  const contentKind = siteMetadata?.contentKind || genericMetadata.contentKind;
  const inferredType = isWikipedia || contentKind === 'person' ? 'theorist' : 'artworkBook';
  const proposedType = requestedType === 'auto' ? inferredType : requestedType;
  const capturedAt = new Date().toISOString();
  const authors = siteMetadata?.authors?.length ? siteMetadata.authors : genericMetadata.authors;
  const publisher = firstNonEmpty(siteMetadata?.publisher, genericMetadata.publisher);
  const dateYear = firstNonEmpty(siteMetadata?.dateYear, genericMetadata.dateYear);
  const isbn = firstNonEmpty(siteMetadata?.isbn, genericMetadata.isbn);

  const proposedInfo = {
    label: title,
    label_jp: japaneseWikipedia.title || '',
    type: proposedType,
    note: description,
    note_jp: '',
    imgURL
  };

  if (proposedType === 'theorist' || proposedType === 'artist') {
    proposedInfo.birth = years.birth;
    proposedInfo.death = years.death;
  }

  if (proposedType === 'artworkBook') {
    proposedInfo.date = dateYear || '';
    proposedInfo.article = siteMetadata?.suppressArticleFallback ? '' : (firstParagraph && firstParagraph !== description ? firstParagraph : '');
  }

  return {
    proposedType,
    proposedInfo,
    sourceMeta: {
      source: siteMetadata?.source || (isWikipedia ? 'browser-wikipedia-page' : (contentKind ? 'browser-metadata-page' : 'browser-generic-page')),
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
        inferredContentKind: contentKind,
        firstParagraph,
        description,
        imgURL,
        imageCandidates,
        birth: years.birth,
        death: years.death,
        dateYear,
        authors,
        publisher,
        publicationTitle: firstNonEmpty(siteMetadata?.publicationTitle, genericMetadata.publicationTitle),
        doi: firstNonEmpty(siteMetadata?.doi, genericMetadata.doi),
        isbn,
        pdfUrl: firstNonEmpty(siteMetadata?.pdfUrl, genericMetadata.pdfUrl),
        schemaTypes: genericMetadata.schemaTypes,
        siteSpecificData: siteMetadata?.siteRaw || {},
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

  const raw = draftRecord.sourceMeta?.raw || {};
  const detail = raw.inferredContentKind ? ` (${raw.inferredContentKind})` : '';
  setStatus(`Captured${detail}. Return to the modifier app and click “Load Latest Browser Capture”.`, 'ok');
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
