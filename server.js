const Fuse = require('fuse.js');
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Connection URL
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri); // https://www.mongodb.com/community/forums/t/argument-of-type-usenewurlparser-boolean-useunifiedtopology-boolean-is-not-assignable-to-parameter-of-type/169033/3


const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static('public'));


const dbName = 'philosophyDiagrams';
let db;

const ROOT_RELATIONSHIP_FIELDS = ['parentId', 'children'];

function normaliseRelationshipArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }

  return [];
}

function normaliseInfo(info = {}) {
  const nextInfo = { ...info };

  // Relationship arrays are root-level fields in the reference schema.
  // Remove accidental duplicates from info during manual adds/edits.
  ROOT_RELATIONSHIP_FIELDS.forEach(field => {
    delete nextInfo[field];
  });

  if (!Object.prototype.hasOwnProperty.call(nextInfo, 'note_jp')) {
    nextInfo.note_jp = '';
  }

  return nextInfo;
}

client.connect().then(() => {
  db = client.db(dbName);
  console.log('Connected to MongoDB');
}).catch(err => console.error(err));

// Route to serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Endpoint to get unique types
app.get('/api/reference/types', async (req, res) => {
  try {
      console.log("Fetching types..."); // Log to confirm route is hit
      const collection = db.collection('reference');
      const types = await collection.distinct('info.type');
      console.log("Fetched types:", types); // Log the fetched types
      res.json(types);
  } catch (err) {
      console.error("Error fetching types:", err); // Detailed error logging
      res.status(500).json({ error: err.toString() });
  }
});


// Query theorists/artists
app.get('/api/reference/label/theorist-artist/:label', async (req, res) => {
  try {
    const label = req.params.label;
    const collection = db.collection('reference');
    const documents = await collection.find({ $or: [{ "info.type": "theorist" }, { "info.type": "artist" }] }).toArray();

    const options = {
      keys: ['info.label'],
      threshold: 0.3,
      distance: 100,
      includeScore: true,
    };

    const fuse = new Fuse(documents, options);
    const results = fuse.search(label);
    const matchedItems = results.map(result => {
      return {
        id: result.item.id,  // Include the id
        info: {
          label: result.item.info.label,
          birth: result.item.info.birth || null,
          death: result.item.info.death || null,
          type: result.item.info.type || null
        }
      };
    });

    res.json(matchedItems);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Query works (note that query works is a bit more nuanced than query theorists)
app.get('/api/reference/label/artworkbook/:label', async (req, res) => {
  try {
    const label = req.params.label;
    const collection = db.collection('reference');
    const documents = await collection.find({ "info.type": "artworkBook" }).toArray();

    const options = {
      keys: ['info.label'],
      threshold: 0.3,
      distance: 100,
      includeScore: true,
    };

    const fuse = new Fuse(documents, options);
    const results = fuse.search(label);

    // Now fetch the parent authors and include parentId and children arrays
    const matchedItems = await Promise.all(results.map(async result => {
      const artwork = result.item;
      let parentLabels = [];

      if (artwork.parentId && artwork.parentId.length > 0) {
        const validParents = await Promise.all(artwork.parentId.map(async (id) => {
          const parent = await collection.findOne({ id });
          return parent ? parent.info.label : null;
        }));

        // Filter out null values (which indicate ghost authors)
        parentLabels = validParents.filter(label => label !== null);
      }

      return {
        id: artwork.id,  // Include the id
        parentId: artwork.parentId || [],  // Include parentId array
        children: artwork.children || [],  // Include children array
        parentLabels,
        label: artwork.info.label,
        date: artwork.info.date || null,
        type: artwork.info.type || null
      };
    }));

    res.json(matchedItems);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Check for ghost parents
app.get('/api/check-author/:label', async (req, res) => {
  try {
    const label = req.params.label;
    const collection = db.collection('reference');
    const document = await collection.findOne({ "info.label": label });
    res.json({ exists: !!document });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

//search for all works without authors
app.get('/api/reference/orphans', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const orphans = await collection.find({ "info.type": "artworkBook", "parentId": { $size: 0 } }).toArray();

    const matchedItems = orphans.map(artwork => {
      return {
        id: artwork.id,
        parentId: artwork.parentId || [],
        children: artwork.children || [],
        label: artwork.info.label,
        date: artwork.info.date || null,
        type: artwork.info.type || null
      };
    });

    res.json(matchedItems);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Endpoint to add theorist/artist ID to parentId of selected artworkBook items
app.post('/api/reference/add-parent', async (req, res) => {
  try {
    const { parentId, artworkIds } = req.body;
    const collection = db.collection('reference');

    const updateResults = await Promise.all(artworkIds.map(async artworkId => {
      const result = await collection.updateOne(
        { id: artworkId }, // Correctly referencing the top-level id field
        { $addToSet: { parentId: parentId } } // $addToSet ensures no duplicates
      );
      return result;
    }));

    res.json({ success: true, results: updateResults });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// Endpoint to add artworkBook IDs to children array of selected theorist/artist item
app.post('/api/reference/add-children', async (req, res) => {
  try {
    const { parentId, childrenIds } = req.body;
    const collection = db.collection('reference');

    const result = await collection.updateOne(
      { id: parentId }, // Correctly referencing the top-level id field
      { $addToSet: { children: { $each: childrenIds } } } // $each allows adding multiple items
    );

    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

//search for duplicates
app.get('/api/reference/duplicates', async (req, res) => {
  try {
    const collection = db.collection('reference');
    
    // Group records by label and filter those with more than one occurrence
    const duplicates = await collection.aggregate([
      {
        $group: {
          _id: "$info.label",
          count: { $sum: 1 },
          records: { $push: "$$ROOT" }
        }
      },
      { $match: { count: { $gt: 1 } } },
      { $project: { _id: 1, count: 1, records: 1 } }
    ]).toArray();

    // Format the results to only show one result per duplicate label
    const uniqueLabels = duplicates.map(duplicate => ({
      label: duplicate._id,
      type: duplicate.records[0].info.type,
      id: duplicate.records[0].id,
      count: duplicate.count
    }));

    res.json(uniqueLabels);
  } catch (err) {
    console.error("Error fetching duplicates:", err);
    res.status(500).json({ error: err.toString() });
  }
});

//search for individual instances of selected duplicates
app.get('/api/reference/duplicates/:label', async (req, res) => {
  try {
    const label = req.params.label;
    const collection = db.collection('reference');
    
    // Find all records with the specified label
    const duplicates = await collection.find({ "info.label": label }).toArray();

    res.json(duplicates);
  } catch (err) {
    console.error("Error fetching duplicates for label:", err);
    res.status(500).json({ error: err.toString() });
  }
});


function createRecordSummary(record) {
  return {
    id: record.id || null,
    label: record.info?.label || null,
    type: record.info?.type || null,
    date: record.info?.date || null,
    birth: record.info?.birth || null,
    death: record.info?.death || null
  };
}

function normaliseLabelForIntegrity(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function relationshipArrayIssue(record, field) {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    return {
      record: createRecordSummary(record),
      field,
      valueType: 'missing'
    };
  }

  if (!Array.isArray(record[field])) {
    return {
      record: createRecordSummary(record),
      field,
      valueType: typeof record[field],
      value: record[field]
    };
  }

  return null;
}

function createEmptyIntegrityIssues() {
  return {
    recordsMissingId: [],
    duplicateIds: [],
    missingParentIdField: [],
    malformedParentId: [],
    missingChildrenField: [],
    malformedChildren: [],
    parentIdsPointingNowhere: [],
    childrenIdsPointingNowhere: [],
    childParentNotReciprocated: [],
    parentChildNotReciprocated: [],
    duplicateLabelsByType: [],
    historicalInfoRelationshipFields: []
  };
}

function describeRelationshipValue(value) {
  if (value === null) return '[null]';
  if (value === undefined) return '[undefined]';
  const stringValue = String(value).trim();
  return stringValue || '[empty string]';
}

function isDirtyRelationshipValue(value) {
  if (value === null || value === undefined) return true;
  const stringValue = String(value).trim().toLowerCase();
  return stringValue === '' || stringValue === 'null' || stringValue === 'undefined';
}

function createMissingReferenceGroups(items, missingValueKey) {
  const groups = new Map();

  items.forEach(item => {
    const rawValue = item[missingValueKey];
    const displayValue = describeRelationshipValue(rawValue);
    const groupKey = `${typeof rawValue}::${displayValue}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        missingId: rawValue ?? null,
        displayValue,
        valueKind: isDirtyRelationshipValue(rawValue) ? 'dirty-array-value' : 'missing-record-id',
        count: 0,
        records: []
      });
    }

    const group = groups.get(groupKey);
    group.count += 1;
    group.records.push(item.record);
  });

  return Array.from(groups.values()).sort((a, b) => b.count - a.count || a.displayValue.localeCompare(b.displayValue));
}

function createGroupedIntegrityDiagnostics(issues) {
  return {
    missingParentIdsGrouped: createMissingReferenceGroups(issues.parentIdsPointingNowhere, 'missingParentId'),
    missingChildIdsGrouped: createMissingReferenceGroups(issues.childrenIdsPointingNowhere, 'missingChildId')
  };
}

function cleanRelationshipArray(value) {
  if (!Array.isArray(value)) return value;
  return value.filter(item => !isDirtyRelationshipValue(item));
}

function relationshipArraysDiffer(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  if (before.length !== after.length) return true;
  return before.some((item, index) => item !== after[index]);
}

function createDirtyRelationshipValueCleanupPreview(records) {
  const changes = [];

  records.forEach(record => {
    const fieldChanges = {};

    ROOT_RELATIONSHIP_FIELDS.forEach(field => {
      if (!Array.isArray(record[field])) return;

      const before = record[field];
      const after = cleanRelationshipArray(before);

      if (!relationshipArraysDiffer(before, after)) return;

      fieldChanges[field] = {
        before,
        after,
        removed: before.filter(item => isDirtyRelationshipValue(item)).map(describeRelationshipValue)
      };
    });

    if (Object.keys(fieldChanges).length > 0) {
      changes.push({
        record: createRecordSummary(record),
        changes: fieldChanges
      });
    }
  });

  return {
    count: changes.length,
    changes
  };
}

async function applyDirtyRelationshipValueCleanup(collection) {
  const records = await collection.find({}, {
    projection: {
      _id: 0,
      id: 1,
      parentId: 1,
      children: 1,
      info: 1
    }
  }).toArray();

  const preview = createDirtyRelationshipValueCleanupPreview(records);

  if (preview.changes.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, preview };
  }

  const operations = preview.changes.map(change => {
    const setFields = {};

    ROOT_RELATIONSHIP_FIELDS.forEach(field => {
      const fieldChange = change.changes[field];
      if (fieldChange) {
        setFields[field] = fieldChange.after;
      }
    });

    return {
      updateOne: {
        filter: { id: change.record.id },
        update: { $set: setFields }
      }
    };
  });

  const result = await collection.bulkWrite(operations);

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    preview
  };
}


function createStaleChildReferenceCleanupPreview(records) {
  const recordsById = new Map(records.filter(record => record.id).map(record => [record.id, record]));
  const changes = [];

  records.forEach(record => {
    if (!Array.isArray(record.children)) return;

    const before = record.children;
    const staleChildIds = before.filter(childId =>
      !isDirtyRelationshipValue(childId) && !recordsById.has(childId)
    );

    if (!staleChildIds.length) return;

    const after = before.filter(childId =>
      isDirtyRelationshipValue(childId) || recordsById.has(childId)
    );

    changes.push({
      record: createRecordSummary(record),
      children: {
        before,
        after,
        removed: staleChildIds
      }
    });
  });

  return {
    count: changes.length,
    removedReferenceCount: changes.reduce((total, change) => total + change.children.removed.length, 0),
    changes
  };
}

async function applyStaleChildReferenceCleanup(collection) {
  const records = await collection.find({}, {
    projection: {
      _id: 0,
      id: 1,
      parentId: 1,
      children: 1,
      info: 1
    }
  }).toArray();

  const preview = createStaleChildReferenceCleanupPreview(records);

  if (preview.changes.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, preview };
  }

  const operations = preview.changes.map(change => ({
    updateOne: {
      filter: { id: change.record.id },
      update: { $set: { children: change.children.after } }
    }
  }));

  const result = await collection.bulkWrite(operations);

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    preview
  };
}


function createHistoricalInfoRelationshipCleanupPreview(records) {
  const changes = [];

  records.forEach(record => {
    if (!record.info || typeof record.info !== 'object') return;

    const hasInfoParentId = Object.prototype.hasOwnProperty.call(record.info, 'parentId');
    const hasInfoChildren = Object.prototype.hasOwnProperty.call(record.info, 'children');

    if (!hasInfoParentId && !hasInfoChildren) return;

    const removedInfoFields = {};
    if (hasInfoParentId) removedInfoFields.parentId = record.info.parentId;
    if (hasInfoChildren) removedInfoFields.children = record.info.children;

    changes.push({
      record: createRecordSummary(record),
      rootRelationshipFields: {
        parentId: Array.isArray(record.parentId) ? record.parentId : record.parentId,
        children: Array.isArray(record.children) ? record.children : record.children
      },
      infoRelationshipFieldsToRemove: removedInfoFields
    });
  });

  return {
    count: changes.length,
    removedFieldCount: changes.reduce((total, change) => total + Object.keys(change.infoRelationshipFieldsToRemove).length, 0),
    changes
  };
}

async function applyHistoricalInfoRelationshipCleanup(collection) {
  const records = await collection.find({}, {
    projection: {
      _id: 0,
      id: 1,
      parentId: 1,
      children: 1,
      info: 1
    }
  }).toArray();

  const preview = createHistoricalInfoRelationshipCleanupPreview(records);

  if (preview.changes.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, preview };
  }

  const operations = preview.changes.map(change => ({
    updateOne: {
      filter: { id: change.record.id },
      update: {
        $unset: Object.fromEntries(
          Object.keys(change.infoRelationshipFieldsToRemove).map(field => [`info.${field}`, ''])
        )
      }
    }
  }));

  const result = await collection.bulkWrite(operations);

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    preview
  };
}


function createReciprocalRelationshipRepairPreview(records) {
  const recordsById = new Map(records.filter(record => record.id).map(record => [record.id, record]));
  const addChildReferenceChanges = [];
  const addParentReferenceChanges = [];
  const seenAddChild = new Set();
  const seenAddParent = new Set();

  records.forEach(child => {
    if (!child.id || !Array.isArray(child.parentId)) return;

    child.parentId.forEach(parentId => {
      if (isDirtyRelationshipValue(parentId)) return;
      const parent = recordsById.get(parentId);
      if (!parent || !parent.id) return;

      const parentChildren = Array.isArray(parent.children) ? parent.children : [];
      if (parentChildren.includes(child.id)) return;

      const key = `${parent.id}::${child.id}`;
      if (seenAddChild.has(key)) return;
      seenAddChild.add(key);

      addChildReferenceChanges.push({
        actionKey: `add-child-to-parent::${parent.id}::${child.id}`,
        direction: 'add-child-to-parent',
        parent: createRecordSummary(parent),
        child: createRecordSummary(child),
        addActionLabel: 'Add child ID to parent.children',
        removeActionLabel: 'Remove parent ID from child.parentId',
        explanation: 'The child already lists this parent, but the parent does not list this child.',
        children: {
          before: parentChildren,
          after: Array.from(new Set([...parentChildren, child.id])),
          add: child.id
        },
        parentId: {
          before: child.parentId,
          afterIfRemoved: child.parentId.filter(id => id !== parent.id),
          remove: parent.id
        }
      });
    });
  });

  records.forEach(parent => {
    if (!parent.id || !Array.isArray(parent.children)) return;

    parent.children.forEach(childId => {
      if (isDirtyRelationshipValue(childId)) return;
      const child = recordsById.get(childId);
      if (!child || !child.id) return;

      const childParentIds = Array.isArray(child.parentId) ? child.parentId : [];
      if (childParentIds.includes(parent.id)) return;

      const key = `${child.id}::${parent.id}`;
      if (seenAddParent.has(key)) return;
      seenAddParent.add(key);

      addParentReferenceChanges.push({
        actionKey: `add-parent-to-child::${parent.id}::${child.id}`,
        direction: 'add-parent-to-child',
        parent: createRecordSummary(parent),
        child: createRecordSummary(child),
        addActionLabel: 'Add parent ID to child.parentId',
        removeActionLabel: 'Remove child ID from parent.children',
        explanation: 'The parent already lists this child, but the child does not list this parent.',
        parentId: {
          before: childParentIds,
          after: Array.from(new Set([...childParentIds, parent.id])),
          add: parent.id
        },
        children: {
          before: parent.children,
          afterIfRemoved: parent.children.filter(id => id !== child.id),
          remove: child.id
        }
      });
    });
  });

  return {
    count: addChildReferenceChanges.length + addParentReferenceChanges.length,
    addChildReferenceCount: addChildReferenceChanges.length,
    addParentReferenceCount: addParentReferenceChanges.length,
    addChildReferenceChanges,
    addParentReferenceChanges
  };
}

function findReciprocalRelationshipChange(preview, actionKey) {
  const allChanges = [
    ...(preview.addChildReferenceChanges || []),
    ...(preview.addParentReferenceChanges || [])
  ];

  return allChanges.find(change => change.actionKey === actionKey);
}

function buildReviewedReciprocalRelationshipOperations(preview, requestedActions) {
  if (!Array.isArray(requestedActions)) {
    throw new Error('Expected actions to be an array.');
  }

  const operations = [];
  const seen = new Set();
  const appliedActions = [];

  requestedActions.forEach(action => {
    const actionKey = action?.actionKey;
    const resolution = action?.resolution;

    if (!actionKey || !resolution) return;
    if (!['add-reciprocal', 'remove-asserted'].includes(resolution)) {
      throw new Error(`Unsupported reciprocal relationship resolution: ${resolution}`);
    }

    const dedupeKey = `${actionKey}::${resolution}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const change = findReciprocalRelationshipChange(preview, actionKey);
    if (!change) {
      throw new Error(`Could not find reciprocal relationship change for actionKey: ${actionKey}`);
    }

    if (change.direction === 'add-child-to-parent') {
      if (resolution === 'add-reciprocal') {
        operations.push({
          updateOne: {
            filter: { id: change.parent.id },
            update: { $addToSet: { children: change.child.id } }
          }
        });
      } else {
        operations.push({
          updateOne: {
            filter: { id: change.child.id },
            update: { $pull: { parentId: change.parent.id } }
          }
        });
      }
    }

    if (change.direction === 'add-parent-to-child') {
      if (resolution === 'add-reciprocal') {
        operations.push({
          updateOne: {
            filter: { id: change.child.id },
            update: { $addToSet: { parentId: change.parent.id } }
          }
        });
      } else {
        operations.push({
          updateOne: {
            filter: { id: change.parent.id },
            update: { $pull: { children: change.child.id } }
          }
        });
      }
    }

    appliedActions.push({
      actionKey,
      resolution,
      direction: change.direction,
      parent: change.parent,
      child: change.child
    });
  });

  return { operations, appliedActions };
}

async function applyReviewedReciprocalRelationshipActions(collection, requestedActions) {
  const records = await collection.find({}, {
    projection: {
      _id: 0,
      id: 1,
      parentId: 1,
      children: 1,
      info: 1
    }
  }).toArray();

  const preview = createReciprocalRelationshipRepairPreview(records);
  const { operations, appliedActions } = buildReviewedReciprocalRelationshipOperations(preview, requestedActions);

  if (operations.length === 0) {
    return {
      matchedCount: 0,
      modifiedCount: 0,
      requestedCount: Array.isArray(requestedActions) ? requestedActions.length : 0,
      appliedActions,
      preview
    };
  }

  const result = await collection.bulkWrite(operations);

  return {
    matchedCount: result.matchedCount,
    modifiedCount: result.modifiedCount,
    requestedCount: Array.isArray(requestedActions) ? requestedActions.length : 0,
    appliedActions,
    preview
  };
}

function registerIdAndLabelGroups(record, recordsById, idGroups, duplicateLabelGroups, issues) {
  if (!record.id) {
    issues.recordsMissingId.push(createRecordSummary(record));
  } else {
    if (!idGroups.has(record.id)) idGroups.set(record.id, []);
    idGroups.get(record.id).push(record);

    // First one wins for lookup purposes; duplicate IDs are reported separately.
    if (!recordsById.has(record.id)) {
      recordsById.set(record.id, record);
    }
  }

  const labelKey = normaliseLabelForIntegrity(record.info?.label);
  if (!labelKey) return;

  const typeKey = normaliseLabelForIntegrity(record.info?.type || 'unknown');
  const groupKey = `${typeKey}::${labelKey}`;

  if (!duplicateLabelGroups.has(groupKey)) {
    duplicateLabelGroups.set(groupKey, {
      label: record.info?.label || '',
      type: record.info?.type || 'unknown',
      records: []
    });
  }

  duplicateLabelGroups.get(groupKey).records.push(createRecordSummary(record));
}

function registerHistoricalInfoRelationshipFields(record, issues) {
  if (!record.info) return;

  const hasInfoParentId = Object.prototype.hasOwnProperty.call(record.info, 'parentId');
  const hasInfoChildren = Object.prototype.hasOwnProperty.call(record.info, 'children');

  if (hasInfoParentId || hasInfoChildren) {
    issues.historicalInfoRelationshipFields.push({
      record: createRecordSummary(record),
      hasInfoParentId,
      hasInfoChildren
    });
  }
}

function registerRelationshipArrayShapeIssues(record, issues) {
  const parentIssue = relationshipArrayIssue(record, 'parentId');
  if (parentIssue?.valueType === 'missing') {
    issues.missingParentIdField.push(parentIssue);
  } else if (parentIssue) {
    issues.malformedParentId.push(parentIssue);
  }

  const childrenIssue = relationshipArrayIssue(record, 'children');
  if (childrenIssue?.valueType === 'missing') {
    issues.missingChildrenField.push(childrenIssue);
  } else if (childrenIssue) {
    issues.malformedChildren.push(childrenIssue);
  }
}

function registerDuplicateGroups(idGroups, duplicateLabelGroups, issues) {
  idGroups.forEach((group, id) => {
    if (group.length > 1) {
      issues.duplicateIds.push({
        id,
        count: group.length,
        records: group.map(createRecordSummary)
      });
    }
  });

  duplicateLabelGroups.forEach(group => {
    if (group.records.length > 1) {
      issues.duplicateLabelsByType.push({
        label: group.label,
        type: group.type,
        count: group.records.length,
        records: group.records
      });
    }
  });
}

function registerRelationshipConsistencyIssues(record, recordsById, issues) {
  const recordSummary = createRecordSummary(record);

  if (Array.isArray(record.parentId)) {
    record.parentId.forEach(parentId => {
      const parent = recordsById.get(parentId);
      if (!parent) {
        issues.parentIdsPointingNowhere.push({
          record: recordSummary,
          missingParentId: parentId
        });
        return;
      }

      if (!Array.isArray(parent.children) || !parent.children.includes(record.id)) {
        issues.childParentNotReciprocated.push({
          child: recordSummary,
          parent: createRecordSummary(parent),
          relationship: `${record.id} lists parent ${parentId}, but parent does not list child`
        });
      }
    });
  }

  if (Array.isArray(record.children)) {
    record.children.forEach(childId => {
      const child = recordsById.get(childId);
      if (!child) {
        issues.childrenIdsPointingNowhere.push({
          record: recordSummary,
          missingChildId: childId
        });
        return;
      }

      if (!Array.isArray(child.parentId) || !child.parentId.includes(record.id)) {
        issues.parentChildNotReciprocated.push({
          parent: recordSummary,
          child: createRecordSummary(child),
          relationship: `${record.id} lists child ${childId}, but child does not list parent`
        });
      }
    });
  }
}

function buildIntegrityReport(records) {
  const recordsById = new Map();
  const idGroups = new Map();
  const duplicateLabelGroups = new Map();
  const issues = createEmptyIntegrityIssues();

  records.forEach(record => {
    registerIdAndLabelGroups(record, recordsById, idGroups, duplicateLabelGroups, issues);
    registerHistoricalInfoRelationshipFields(record, issues);
    registerRelationshipArrayShapeIssues(record, issues);
  });

  registerDuplicateGroups(idGroups, duplicateLabelGroups, issues);

  records.forEach(record => {
    registerRelationshipConsistencyIssues(record, recordsById, issues);
  });

  const summary = Object.fromEntries(
    Object.entries(issues).map(([key, value]) => [key, value.length])
  );

  return {
    generatedAt: new Date().toISOString(),
    totalRecords: records.length,
    summary,
    groupedDiagnostics: createGroupedIntegrityDiagnostics(issues),
    cleanupPreviews: {
      dirtyRelationshipValues: createDirtyRelationshipValueCleanupPreview(records),
      staleChildReferences: createStaleChildReferenceCleanupPreview(records),
      historicalInfoRelationshipFields: createHistoricalInfoRelationshipCleanupPreview(records),
      reciprocalRelationships: createReciprocalRelationshipRepairPreview(records)
    },
    issues
  };
}


function createMissingParentReplacementPreview(records, missingParentId, replacementRecord) {
  const affectedRecords = records.filter(record =>
    Array.isArray(record.parentId) && record.parentId.includes(missingParentId)
  );

  const replacementChildren = Array.isArray(replacementRecord.children)
    ? replacementRecord.children
    : [];

  const affectedIds = affectedRecords
    .map(record => record.id)
    .filter(Boolean);

  const childIdsToAddToReplacement = affectedIds.filter(id => !replacementChildren.includes(id));
  const replacementChildrenAfter = Array.from(new Set([...replacementChildren, ...affectedIds]));

  const changes = affectedRecords.map(record => {
    const beforeParentId = Array.isArray(record.parentId) ? record.parentId : [];
    const afterParentId = Array.from(new Set(
      beforeParentId.map(parentId => parentId === missingParentId ? replacementRecord.id : parentId)
    ));

    return {
      record: createRecordSummary(record),
      parentId: {
        before: beforeParentId,
        after: afterParentId
      }
    };
  });

  return {
    missingParentId,
    replacement: createRecordSummary(replacementRecord),
    affectedCount: affectedRecords.length,
    childIdsToAddToReplacement,
    replacementChildren: {
      beforeCount: replacementChildren.length,
      afterCount: replacementChildrenAfter.length,
      before: replacementChildren,
      after: replacementChildrenAfter
    },
    changes
  };
}

async function fetchReferenceRecordsForRelationshipRepair(collection) {
  return collection.find({}, {
    projection: {
      _id: 0,
      id: 1,
      parentId: 1,
      children: 1,
      info: 1
    }
  }).toArray();
}

function validateMissingParentReplacementRequest(missingParentId, replacementId) {
  if (!missingParentId || !replacementId) {
    return 'Both missingParentId and replacementId are required.';
  }

  if (isDirtyRelationshipValue(missingParentId) || isDirtyRelationshipValue(replacementId)) {
    return 'Dirty relationship values cannot be used for missing-parent replacement.';
  }

  if (missingParentId === replacementId) {
    return 'The missing parent ID and replacement ID must be different.';
  }

  return null;
}

async function applyMissingParentReplacement(collection, missingParentId, replacementId) {
  const records = await fetchReferenceRecordsForRelationshipRepair(collection);
  const replacementRecord = records.find(record => record.id === replacementId);

  if (!replacementRecord) {
    const error = new Error('Replacement record not found.');
    error.statusCode = 404;
    throw error;
  }

  const oldRecordStillExists = records.some(record => record.id === missingParentId);
  if (oldRecordStillExists) {
    const error = new Error('The old parent ID still exists. Use a merge workflow instead of missing-parent replacement.');
    error.statusCode = 400;
    throw error;
  }

  const preview = createMissingParentReplacementPreview(records, missingParentId, replacementRecord);

  if (preview.affectedCount === 0) {
    const error = new Error('No records currently reference this missing parent ID.');
    error.statusCode = 400;
    throw error;
  }

  const childUpdateOperations = preview.changes.map(change => ({
    updateOne: {
      filter: { id: change.record.id },
      update: { $set: { parentId: change.parentId.after } }
    }
  }));

  const operations = [...childUpdateOperations];

  if (preview.childIdsToAddToReplacement.length > 0) {
    operations.push({
      updateOne: {
        filter: { id: replacementId },
        update: { $addToSet: { children: { $each: preview.childIdsToAddToReplacement } } }
      }
    });
  }

  const writeResult = operations.length > 0
    ? await collection.bulkWrite(operations)
    : { matchedCount: 0, modifiedCount: 0 };

  return {
    oldRecordStillExists,
    preview,
    matchedCount: writeResult.matchedCount || 0,
    modifiedCount: writeResult.modifiedCount || 0
  };
}

function createReplacementCandidateSummary(result) {
  const item = result.item || result;

  return {
    id: item.id || null,
    label: item.info?.label || null,
    type: item.info?.type || null,
    birth: item.info?.birth || null,
    death: item.info?.death || null,
    date: item.info?.date || null,
    score: typeof result.score === 'number' ? result.score : null
  };
}

// Read-only integrity report. This route does not write, repair, merge, or delete anything.
app.get('/api/reference/integrity-report', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const records = await collection.find({}, {
      projection: {
        _id: 0,
        id: 1,
        parentId: 1,
        children: 1,
        info: 1
      }
    }).toArray();

    res.json(buildIntegrityReport(records));
  } catch (err) {
    console.error('Error building integrity report:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Preview-only endpoint for dirty relationship values. This does not write anything.
app.get('/api/reference/dirty-relationship-values/preview', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const records = await collection.find({}, {
      projection: {
        _id: 0,
        id: 1,
        parentId: 1,
        children: 1,
        info: 1
      }
    }).toArray();

    res.json(createDirtyRelationshipValueCleanupPreview(records));
  } catch (err) {
    console.error('Error previewing dirty relationship value cleanup:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Narrow cleanup endpoint: removes only null / undefined / empty-string relationship values.
// It does not repair missing IDs, merge records, or touch any info fields.
app.post('/api/reference/dirty-relationship-values/clean', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const result = await applyDirtyRelationshipValueCleanup(collection);

    res.json({
      success: true,
      message: result.modifiedCount === 0
        ? 'No dirty relationship values needed cleaning.'
        : `Cleaned dirty relationship values in ${result.modifiedCount} record${result.modifiedCount === 1 ? '' : 's'}.`,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      preview: result.preview
    });
  } catch (err) {
    console.error('Error cleaning dirty relationship values:', err);
    res.status(500).json({ error: err.toString() });
  }
});


// Preview-only endpoint for stale child references. This does not write anything.
app.get('/api/reference/stale-child-references/preview', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const records = await fetchReferenceRecordsForRelationshipRepair(collection);

    res.json(createStaleChildReferenceCleanupPreview(records));
  } catch (err) {
    console.error('Error previewing stale child reference cleanup:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Narrow cleanup endpoint: removes only children IDs that point to no existing record.
// It does not touch parentId arrays, relationship direction, duplicates, or info fields.
app.post('/api/reference/stale-child-references/clean', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const result = await applyStaleChildReferenceCleanup(collection);

    res.json({
      success: true,
      message: result.modifiedCount === 0
        ? 'No stale child references needed cleaning.'
        : `Removed ${result.preview.removedReferenceCount} stale child reference${result.preview.removedReferenceCount === 1 ? '' : 's'} from ${result.modifiedCount} record${result.modifiedCount === 1 ? '' : 's'}.`,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      preview: result.preview
    });
  } catch (err) {
    console.error('Error cleaning stale child references:', err);
    res.status(500).json({ error: err.toString() });
  }
});




// Preview-only endpoint for historical info.parentId / info.children cleanup. This does not write anything.
app.get('/api/reference/historical-info-relationships/preview', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const records = await fetchReferenceRecordsForRelationshipRepair(collection);

    res.json(createHistoricalInfoRelationshipCleanupPreview(records));
  } catch (err) {
    console.error('Error previewing historical info relationship cleanup:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Narrow cleanup endpoint: removes only info.parentId and info.children shadow fields.
// It does not alter root-level parentId / children arrays or any other info fields.
app.post('/api/reference/historical-info-relationships/clean', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const result = await applyHistoricalInfoRelationshipCleanup(collection);

    res.json({
      success: true,
      message: result.modifiedCount === 0
        ? 'No historical info relationship fields needed cleaning.'
        : `Removed ${result.preview.removedFieldCount} historical info relationship field${result.preview.removedFieldCount === 1 ? '' : 's'} from ${result.modifiedCount} record${result.modifiedCount === 1 ? '' : 's'}.`,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      preview: result.preview
    });
  } catch (err) {
    console.error('Error cleaning historical info relationship fields:', err);
    res.status(500).json({ error: err.toString() });
  }
});


// Preview-only endpoint for reciprocal relationship repair. This does not write anything.
app.get('/api/reference/reciprocal-relationships/preview', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const records = await fetchReferenceRecordsForRelationshipRepair(collection);

    res.json(createReciprocalRelationshipRepairPreview(records));
  } catch (err) {
    console.error('Error previewing reciprocal relationship repair:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Reviewed repair endpoint: applies selected reciprocal relationship resolutions.
// Each selected row can either add the missing reciprocal ID or remove the asserted one-sided link.
app.post('/api/reference/reciprocal-relationships/apply-reviewed', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const result = await applyReviewedReciprocalRelationshipActions(collection, req.body?.actions || []);

    res.json({
      success: true,
      message: result.appliedActions.length === 0
        ? 'No reviewed reciprocal relationship actions were applied.'
        : `Applied ${result.appliedActions.length} reviewed reciprocal relationship action${result.appliedActions.length === 1 ? '' : 's'} across ${result.modifiedCount} record${result.modifiedCount === 1 ? '' : 's'}.`,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      appliedActions: result.appliedActions,
      preview: result.preview
    });
  } catch (err) {
    console.error('Error applying reviewed reciprocal relationship actions:', err);
    res.status(500).json({ error: err.toString() });
  }
});


// Candidate search for missing-parent replacement preview. This does not write anything.
app.get('/api/reference/missing-parent-replacement/candidates', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();

    if (!query) {
      return res.status(400).json({ error: 'A query parameter is required.' });
    }

    const collection = db.collection('reference');
    const documents = await collection.find({}, {
      projection: {
        _id: 0,
        id: 1,
        parentId: 1,
        children: 1,
        info: 1
      }
    }).toArray();

    const options = {
      keys: ['info.label', 'info.label_jp', 'info.altLabel', 'info.altLabels'],
      threshold: 0.35,
      distance: 120,
      includeScore: true,
    };

    const fuse = new Fuse(documents, options);
    const results = fuse.search(query)
      .slice(0, 20)
      .map(createReplacementCandidateSummary);

    res.json({ query, results });
  } catch (err) {
    console.error('Error searching missing-parent replacement candidates:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Preview missing-parent replacement. This does not write anything.
app.get('/api/reference/missing-parent-replacement/preview', async (req, res) => {
  try {
    const missingParentId = String(req.query.missingParentId || '').trim();
    const replacementId = String(req.query.replacementId || '').trim();

    const validationError = validateMissingParentReplacementRequest(missingParentId, replacementId);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const collection = db.collection('reference');
    const records = await fetchReferenceRecordsForRelationshipRepair(collection);
    const replacementRecord = records.find(record => record.id === replacementId);

    if (!replacementRecord) {
      return res.status(404).json({ error: 'Replacement record not found.' });
    }

    const oldRecordStillExists = records.some(record => record.id === missingParentId);
    const preview = createMissingParentReplacementPreview(records, missingParentId, replacementRecord);

    res.json({
      oldRecordStillExists,
      preview
    });
  } catch (err) {
    console.error('Error previewing missing-parent replacement:', err);
    res.status(500).json({ error: err.toString() });
  }
});




// Apply a reviewed missing-parent replacement.
// This is intentionally narrow: it only replaces one missing parent ID in affected child parentId arrays
// and adds those child IDs to the chosen replacement parent's children array.
app.post('/api/reference/missing-parent-replacement/apply', async (req, res) => {
  try {
    const missingParentId = String(req.body?.missingParentId || '').trim();
    const replacementId = String(req.body?.replacementId || '').trim();

    const validationError = validateMissingParentReplacementRequest(missingParentId, replacementId);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const collection = db.collection('reference');
    const result = await applyMissingParentReplacement(collection, missingParentId, replacementId);

    res.json({
      success: true,
      message: `Applied missing-parent replacement for ${result.preview.affectedCount} affected record${result.preview.affectedCount === 1 ? '' : 's'}.`,
      ...result
    });
  } catch (err) {
    console.error('Error applying missing-parent replacement:', err);
    res.status(err.statusCode || 500).json({ error: err.toString() });
  }
});


//search for full record of selected duplicates
app.get('/api/reference/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const collection = db.collection('reference');
    const document = await collection.findOne({ id });

    if (!document) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json(document);
  } catch (err) {
    console.error("Error fetching record:", err);
    res.status(500).json({ error: err.toString() });
  }
});

// Delete selected duplicates
app.delete('/api/reference/delete-duplicates', async (req, res) => {
  try {
      const { ids } = req.body;
      if (!ids || !Array.isArray(ids)) {
          return res.status(400).json({ message: 'Invalid request, no IDs provided.' });
      }

      const result = await db.collection('reference').deleteMany({ id: { $in: ids } });
      if (result.deletedCount === 0) {
          return res.status(404).json({ message: 'No matching records found to delete.' });
      }

      res.json({ success: true, message: `${result.deletedCount} records deleted.` });
  } catch (err) {
      console.error('Error deleting duplicates:', err);
      res.status(500).json({ message: 'Internal server error' });
  }
});

// Endpoint to check the validity of parent and child IDs
app.get('/api/reference/validate/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const collection = db.collection('reference');
    const document = await collection.findOne({ id });

    if (!document) {
      return res.json({ valid: false, label: null });
    }

    res.json({ valid: true, label: document.info.label });
  } catch (err) {
    console.error("Error validating ID:", err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Query all types
app.get('/api/reference/label/all/:label', async (req, res) => {
  try {
      const label = req.params.label;
      const collection = db.collection('reference');
      const documents = await collection.find({}).toArray(); // Fetch all documents

      const options = {
          keys: ['info.label'],
          threshold: 0.3,
          distance: 100,
          includeScore: true,
      };

      const fuse = new Fuse(documents, options);
      const results = fuse.search(label);

      const matchedItems = results.map(result => {
          return {
              id: result.item.id, // Include the id
              info: result.item.info
          };
      });

      res.json(matchedItems);
  } catch (err) {
      res.status(500).json({ error: err.toString() });
  }
});

// Update an existing record
app.put('/api/reference/update/:id', async (req, res) => {
  try {
      const id = req.params.id;
      const updatedInfo = req.body.info;
      const collection = db.collection('reference');

      if (!updatedInfo || typeof updatedInfo !== 'object' || Array.isArray(updatedInfo)) {
          return res.status(400).json({ message: 'Invalid request: info object is required.' });
      }

      const existingRecord = await collection.findOne({ id });

      if (!existingRecord) {
          return res.status(404).json({ message: 'Record not found.' });
      }

      const mergedInfo = normaliseInfo({
          ...(existingRecord.info || {}),
          ...updatedInfo
      });

      const result = await collection.updateOne({ id }, { $set: { info: mergedInfo } });

      if (result.matchedCount === 1) {
          res.json({ message: result.modifiedCount === 1 ? 'Record updated successfully.' : 'Record found; no changes were needed.' });
      } else {
          res.status(404).json({ message: 'Record not found.' });
      }
  } catch (err) {
      res.status(500).json({ error: err.toString() });
  }
});




// Endpoint to fetch a single example record of a specific type
app.get('/api/reference/type/:type', async (req, res) => {
  try {
      const type = req.params.type;
      const collection = db.collection('reference');
      const record = await collection.findOne({ "info.type": type });

      if (record) {
          res.json(record);
      } else {
          res.status(404).json({ message: 'No record found for this type.' });
      }
  } catch (err) {
      console.error("Error fetching record by type:", err);
      res.status(500).json({ error: err.toString() });
  }
});


// Endpoint to add a new record with parent validation and child addition
app.post('/api/reference/new', async (req, res) => {
  const session = client.startSession();
  
  try {
      const newRecord = req.body;
      const collection = db.collection('reference');

      newRecord.parentId = normaliseRelationshipArray(newRecord.parentId);
      newRecord.children = normaliseRelationshipArray(newRecord.children);
      newRecord.info = normaliseInfo(newRecord.info || {});
      
      // Start a transaction
      session.startTransaction();
      
      // Validate parent IDs
      if (newRecord.parentId && newRecord.parentId.length > 0) {
          const parentIds = newRecord.parentId;
          const existingParents = await collection.find({ id: { $in: parentIds } }).toArray();
          
          if (existingParents.length !== parentIds.length) {
              throw new Error('One or more parent IDs do not exist.');
          }
      }

      // Generate a new UUID for the record
      const recordId = uuidv4();
      newRecord.id = recordId;

      // Insert the new record
      const result = await collection.insertOne(newRecord);

      if (result.acknowledged) {
          // Update the parent's children arrays
          if (newRecord.parentId && newRecord.parentId.length > 0) {
              await collection.updateMany(
                  { id: { $in: newRecord.parentId } },
                  { $addToSet: { children: recordId } }
              );
          }

          await session.commitTransaction();
          res.json({ message: 'Record added successfully.', id: newRecord.id });
      } else {
          throw new Error('Failed to add the record.');
      }
  } catch (err) {
      await session.abortTransaction();
      console.error('Error adding new record:', err);
      res.status(500).json({ error: err.toString() });
  } finally {
      session.endSession();
  }
});




app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
