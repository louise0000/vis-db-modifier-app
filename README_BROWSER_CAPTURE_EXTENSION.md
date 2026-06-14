# Modifier Draft Capture browser extension

This is a deliberately small local-only WebExtension prototype.

It captures the current page as a draft-record object and POSTs it to the modifier app's local receiver:

```text
POST http://localhost:3000/api/draft-capture
```

If your modifier app runs on a different port, change the port in the extension popup before clicking **Capture Current Page**.

## Test in Firefox

1. Make sure the modifier app is running with `node server.js`.
2. Open Firefox.
3. Go to `about:debugging`.
4. Choose **This Firefox**.
5. Click **Load Temporary Add-on**.
6. Select `browser-capture-extension/manifest.json`.
7. Visit a Wikipedia biography page.
8. Click the extension icon.
9. Leave record type as `Auto`, or choose `theorist`.
10. Click **Capture Current Page**.
11. Go back to the modifier app.
12. Click **Load Latest Browser Capture** in Add Single Record.

## What this version does

- Extracts page title and URL.
- Extracts the first useful paragraph.
- Detects Wikipedia pages.
- Guesses `theorist` for Wikipedia pages and `artworkBook` for generic pages when type is set to `Auto`.
- Extracts a candidate image URL.
- Tries to parse birth/death years from biography-like first paragraphs.
- Sends a draft-record object to the local modifier app.

## What this version does not do yet

- It does not use Zotero translators.
- It does not use Wikidata API lookups.
- It does not scrape every website intelligently.
- It does not save anything directly to Mongo.
- It does not bypass the modifier app review step.
