Relationship sweep patch
========================

Purpose
-------
This patch tightens parent/child handling across the modifier app after the Batch Records and CSV-import work.

What changed
------------
1. Add Single Record
   - parentId / children fields now have a small label-search helper.
   - saving a new record with parent/child IDs asks whether to update reciprocal links.
   - server-side add now supports children as well as parents, so newRecord.children can add newRecord.id to each child.parentId.

2. Search and Edit Records
   - parentId / children fields now have a label-search helper.
   - saving relationship changes asks whether to update reciprocal links on related records.
   - server-side update can add and remove reciprocals when syncRelationships=true.

3. Batch Records
   - expanded rows now have parent/child label-search helpers beside direct ID textareas.
   - saving one row asks about reciprocal sync if relationships changed.
   - Save Edited Rows asks once if any dirty rows include relationship changes.

4. Delete Single Record
   - Delete Selected is now Preview Delete Impact.
   - preview shows relationship and saved-curation impact.
   - commit offers cleanup checkboxes for other records and saved curations.
   - it uses the same reviewed-delete backend as Batch Records.

5. Legacy duplicate delete endpoint
   - now also cleans parent/child references and saved curation overlays by default.

6. CSV Import
   - already reciprocates reviewed parent/child relationships on commit, so no extra UI was added in this patch.

Notes
-----
The app still allows direct ID editing for power use, but common Add/Edit/Batch paths now provide a human-friendly resolver and a reciprocal-sync prompt.
