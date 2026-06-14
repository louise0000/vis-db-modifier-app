# Modifier Draft Capture extension

This is a small local browser-extension prototype for sending draft records to the modifier app.

It is intentionally not a Zotero clone. It captures a page into the same draft-record shape used by the modifier app:

```text
web page -> extension popup -> POST http://localhost:3000/api/draft-capture -> Load Latest Browser Capture
```

## Development install in Firefox

Temporary Firefox extensions disappear when Firefox restarts.

To reload manually:

1. Type `about:debugging#/runtime/this-firefox` in the Firefox address bar.
2. Click **Load Temporary Add-on…**.
3. Choose `browser-capture-extension/manifest.json`.
4. Use the jigsaw/extensions menu if the button is not pinned to the toolbar.

## Modifier app

Start the modifier app first:

```bash
node server.js
```

The extension defaults to port `3000`.

## Current capture behaviour

### Wikipedia biography pages

The extension attempts to capture:

- English page title
- Japanese Wikipedia page title into `label_jp`, where available
- first useful paragraph into `note`
- birth and death years
- Wikidata QID
- image candidates
- canonical/source URLs

### Generic pages

The extension now also harvests common page metadata:

- OpenGraph and Twitter Card title/description/image
- schema.org JSON-LD entities such as `Person`, `Book`, `Article`, `ScholarlyArticle`, `Movie`, and `CreativeWork`
- citation metadata such as `citation_title`, `citation_author`, `citation_publication_date`, `citation_doi`, `citation_isbn`, and `citation_pdf_url`
- a first useful paragraph fallback

If the page appears to describe a person, Auto mode proposes `theorist`.
Otherwise Auto mode proposes `artworkBook`.

## Image handling note

The extension does not solve image preservation. It sends the first image candidate to `proposedInfo.imgURL` for continuity with the current app, but it also preserves a fuller list in:

```js
sourceMeta.raw.imageCandidates
```

Those candidates should later feed a separate image-review/upload workflow before a stable canonical image URL is written back to `info.imgURL`.
