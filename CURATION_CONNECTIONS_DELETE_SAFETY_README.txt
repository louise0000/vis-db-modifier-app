Patch notes: curation connection generation + delete safety

This patch keeps the modifier app as the canonical reference-record maintenance tool.
It does not import vis-app code.

Changes:
1. POST /api/curations/from-records now builds database curationConnections from reference.parentId and reference.children whenever both endpoints are included in the created curation.
2. POST /api/curations/:curationId/rebuild-connections repairs existing saved curations whose includedNodes are correct but whose curationConnections are empty or stale. Custom connections are preserved.
3. Batch Records source panel exposes a Rebuild Saved Curation Connections button when the selected source is a saved curation.
4. Batch Records now has a reviewed delete section:
   - preview delete impact;
   - show other records whose parentId/children contain deleted IDs;
   - show saved curations containing the deleted nodes/connections;
   - commit reviewed delete with optional cleanup of relationships and saved curation overlays.

Important boundaries:
- The rebuild action regenerates database-type curationConnections from reference relationships. It does not invent positions.
- Delete cleanup removes deleted nodes/connections from saved curations, but does not delete whole curations.
- The vis app should remain the layout editor and should still get a separate deleted-node placeholder later.
