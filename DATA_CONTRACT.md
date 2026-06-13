# Modifier / Reference Database Data Contract

This is a conservative working contract for the modifier app and the wider D3/MongoDB curation-tool family. It is not a full migration plan.

## 1. Canonical reference database

The `reference` collection is the canonical source for durable node/entity data.

It owns:

- stable node IDs
- base labels
- Japanese labels
- base notes
- Japanese notes
- dates, birth/death fields, and other durable descriptive fields
- image URLs and image metadata
- source/provenance metadata
- durable parent/child relationships between records

## 2. Root-level relationship fields

Relationship arrays belong at the document root:

```js
{
  id: "uuid",
  info: { ... },
  parentId: [],
  children: []
}
```

`parentId` and `children` should not also be written inside `info` for new records.

This modifier patch preserves root-level relationship editing in the add form, but strips accidental `info.parentId` and `info.children` during add/edit writes.

## 3. Info fields

`info` is for descriptive record fields, for example:

```js
info: {
  type: "artist",
  label: "Base / English label",
  label_jp: "Japanese label",
  note: "Base / English Markdown note",
  note_jp: "Japanese Markdown note",
  date: "",
  birth: "",
  death: "",
  imgUrl: ""
}
```

`note_jp` is now treated as a first-class optional field. If an older record or template lacks it, the modifier app adds an empty editable field without requiring a database migration.

## 4. Curation overlays

Saved curations are interpretive overlays. They own:

- node positions
- diagram-local colour overrides
- custom / curation-local connections
- custom subtypes
- artboard settings
- link display settings
- static-export presentation settings

Curations should not become the source of truth for central notes, translations, dates, image provenance, or durable parent/child relationships.

## 5. Static exports

Downloaded curation JSON may contain full node objects for portability and static display, but it is a snapshot. It should not be treated as the canonical database.

## 6. Import workflow principle

Future Zotero, browser, Wikipedia, or image gathering workflows should write to a staging/review layer first, not directly to `reference`.

Recommended future collections:

```js
importBatches
importCandidates
imageCandidates
```

Only reviewed candidates should be committed to `reference`.
