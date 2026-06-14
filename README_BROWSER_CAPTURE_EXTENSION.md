# Modifier Draft Capture browser extension

This is a deliberately small local-only WebExtension prototype.

It captures the current page as a draft-record object and POSTs it to the modifier app's local receiver:

```text
POST http://localhost:3000/api/draft-capture
```

The modifier app port is currently assumed to be `3000`.

## Important Firefox development behaviour

When this extension is loaded through `about:debugging`, it is a **temporary extension**. Firefox removes temporary extensions when Firefox restarts. This is normal and does not mean the project is broken.

For development, reload it from:

```text
about:debugging#/runtime/this-firefox
```

Then choose **Load Temporary Add-on** and select:

```text
browser-capture-extension/manifest.json
```

## Pinning it to the visible toolbar

Firefox may keep the extension under the jigsaw/extensions button.

Try:

1. Click the jigsaw/extensions button.
2. Right-click **Modifier Draft Capture**.
3. Choose **Pin to Toolbar** if the option appears.

If Firefox does not offer the option for a temporary add-on, continue using it from the jigsaw menu during development. The icon files are included so a signed/permanent build will have a recognisable toolbar/menu icon later.

## Faster development workflow with web-ext

This patch adds a small `package.json` inside `browser-capture-extension/`.

From the project root:

```bash
cd browser-capture-extension
npm install
npm run firefox
```

This launches Firefox with the extension loaded. It is still a development workflow, not a properly signed permanent install, but it avoids manually navigating through `about:debugging` every time.

To lint:

```bash
npm run lint
```

To build an unsigned development package:

```bash
npm run build
```

## Permanent install later

For normal Firefox release builds, extensions generally need to be signed before they can be installed permanently. Keep using temporary install or `web-ext` while developing. Later, package/signing can be treated as a separate release step.

## Test capture

1. Make sure the modifier app is running:

```bash
node server.js
```

2. Open a Wikipedia biography page.
3. Open **Modifier Draft Capture**.
4. Leave record type as `Auto`, or choose `theorist`.
5. Click **Capture Current Page**.
6. Go back to the modifier app.
7. Click **Load Latest Browser Capture** in Add Single Record.

## What this version does

- Extracts page title and URL.
- Extracts the first useful paragraph.
- Detects Wikipedia pages.
- Guesses `theorist` for Wikipedia pages and `artworkBook` for generic pages when type is set to `Auto`.
- Extracts a candidate image URL.
- Tries to parse birth/death years from biography-like first paragraphs and infobox text.
- On Wikipedia pages, looks for a Japanese Wikipedia language link and maps that page title into `label_jp`.
- Sends a draft-record object to the local modifier app.

## What this version does not do yet

- It does not use Zotero translators.
- It does not use Wikidata API lookups.
- It does not scrape every website intelligently.
- It does not save anything directly to Mongo.
- It does not make external image URLs canonical.
- It does not bypass the modifier app review step.
