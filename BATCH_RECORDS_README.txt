Modifier Batch Records Workbench - Round 4
=========================================

Scope:
- Modifier app only.
- Canonical reference records remain the write target.
- Saved curations are selection sources only, not editable batch records.

Included by the end of this feature pass:
- Batch Records screen with reference-root and saved-curation selection sources.
- Typed root search for reference records.
- Direct / recursive reference cluster loading.
- Curation-based record loading as a selection source.
- Type and missing-image filters.
- Expandable inline record editing.
- Dirty row tracking and Save Edited Rows.
- Previewed repeated field-set operation for selected records.
- label and label_jp are deliberately excluded from repeated field-set operations.
- Previewed Add Parent relationship operation.
- Previewed Add Child relationship operation.
- Reciprocal relationship writes for parentId / children.
- Send selected missing-image records to the existing Image Queue.

Image workflow note:
- Batch Records does not duplicate the SerpAPI candidate UI.
- It hands selected missing-image records to the existing Image Queue, where SerpAPI fetch / candidate review / validation / cloud upload / database save already live.

Suggested test flow:
1. Open Batch Records.
2. Search a reference root, load recursive descendants.
3. Click Edit All, change one row, confirm Save Edited Rows activates.
4. Save edited rows.
5. Select several records, preview a field set, then commit only after reviewing.
6. Confirm label and label_jp are not available in the repeated field-set dropdown.
7. Resolve a related record, test Add Parent preview/commit.
8. Switch operation to Add Child, resolve a child, test preview/commit.
9. Select missing-image records and send them to the Image Queue.
10. Use the Image Queue screen for SerpAPI fetch and image finalisation.


Round 5 image queue limit change:
- Manual Image Queue use still starts in 5-record manual mode.
- Batch Records switches the queue into batch mode and may send up to 50 selected missing-image records.
- SerpApi fetching for large queues asks for confirmation and still runs sequentially, which is slower but kinder to the API and easier to interrupt mentally.
