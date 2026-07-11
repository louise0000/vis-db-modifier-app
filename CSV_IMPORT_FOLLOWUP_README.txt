CSV import follow-up patch
==========================

This patch keeps CSV import as canonical reference-database ingest, then adds an optional post-commit follow-up modal.

After a successful CSV commit, the modal can:

1. Create an unarranged saved curation from committed created/merged records.
   - The curation stores lightweight includedNodes entries with empty positions.
   - The visual app should load it as a saved diagram/selection to arrange later.

2. Send committed records without images to the existing Image Queue.
   - People means artist + theorist.
   - Artwork/books means artworkBook.
   - The Image Queue remains the SerpAPI/candidate-review/upload pipeline.

This does not make the modifier app into a layout editor, and it does not make CSV rows into curation source-of-truth records.
