# Modifier Draft Capture Extension

Development extension for sending draft records from the active browser page to the local modifier app.

## Current local target

The extension posts to:

```text
http://localhost:3000/api/draft-capture
```

The modifier app then loads the received draft via **Add Single Record → Load Latest Browser Capture**.

## Current capture behaviour

The extension has three layers:

1. **Wikipedia biography capture**
   - English label
   - Japanese Wikipedia title as `label_jp` when a Japanese language page is linked
   - birth/death year where detectable
   - Wikidata QID where detectable

2. **Site-specific cleanup layer**
   - IMDb title pages: prefer the displayed primary title and year from the document title/hero area rather than localised release dates.
   - Amazon product pages: prefer `#productTitle`, byline author, ISBN, publisher and publication-date details; suppress SEO/returns text from note/article.
   - Goodreads and Google Books: attempt title, author, published year and cleaner description when available.

3. **Generic metadata fallback**
   - OpenGraph / Twitter Card metadata
   - schema.org JSON-LD metadata
   - citation metadata
   - first useful paragraph fallback
   - image candidates preserved in `sourceMeta.raw.imageCandidates`

## Important limitation

This is not a Zotero-grade translator ecosystem. It is a small capture bridge into the modifier app. For academic publisher pages, Zotero translators or a Zotero translation-server backend may become useful later.

Images are still treated as candidates. Do not assume the scraped image URL is canonical or permanent. A later image review/cache/upload workflow should decide which image becomes `info.imgURL`.
