const Fuse = require('fuse.js');
const express = require('express');
const { MongoClient } = require('mongodb');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { promises: fsp } = fs;
const { v4: uuidv4 } = require('uuid');

let GoogleCloudStorage = null;
try {
  ({ Storage: GoogleCloudStorage } = require('@google-cloud/storage'));
} catch (err) {
  // Optional dependency for the image queue cloud-finalise step.
  // The app can still run without it; cloud upload routes return a setup error.
  GoogleCloudStorage = null;
}

require('dotenv').config();

// Connection URL
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri); // https://www.mongodb.com/community/forums/t/argument-of-type-usenewurlparser-boolean-useunifiedtopology-boolean-is-not-assignable-to-parameter-of-type/169033/3


const app = express();
const port = 3000;

app.use(cors());
app.use(express.json({ limit: '12mb' }));

// Serve static files from the 'public' directory
app.use(express.static('public'));


const dbName = 'philosophyDiagrams';
let db;
let latestDraftCapture = null;

const IMAGE_CANDIDATE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_CANDIDATE_PREVIEW_DIR = path.join(__dirname, 'public', '_image-candidate-preview');
const IMAGE_CLOUD_DEFAULT_PREFIX = 'reference-images';
const SERPAPI_IMAGE_CANDIDATE_LIMIT = 5;

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


function uniqueRelationshipArray(value) {
  return [...new Set(normaliseRelationshipArray(value))];
}

function getArrayDiff(before = [], after = []) {
  const beforeSet = new Set(uniqueRelationshipArray(before));
  const afterSet = new Set(uniqueRelationshipArray(after));
  return {
    added: [...afterSet].filter(id => !beforeSet.has(id)),
    removed: [...beforeSet].filter(id => !afterSet.has(id))
  };
}

async function findMissingRelationshipTargets(collection, ids = []) {
  const uniqueIds = uniqueRelationshipArray(ids);
  if (!uniqueIds.length) return [];

  const existing = await collection
    .find({ id: { $in: uniqueIds } }, { projection: { id: 1 } })
    .toArray();

  const existingSet = new Set(existing.map(record => record.id).filter(Boolean));
  return uniqueIds.filter(id => !existingSet.has(id));
}

function summariseRelationshipSync(diff = {}) {
  return {
    addedParentIds: diff.addedParentIds || [],
    removedParentIds: diff.removedParentIds || [],
    addedChildIds: diff.addedChildIds || [],
    removedChildIds: diff.removedChildIds || [],
    changedCount:
      (diff.addedParentIds || []).length +
      (diff.removedParentIds || []).length +
      (diff.addedChildIds || []).length +
      (diff.removedChildIds || []).length
  };
}

async function applyReciprocalRelationshipChanges(collection, recordId, before = {}, after = {}) {
  const parentDiff = getArrayDiff(before.parentId, after.parentId);
  const childDiff = getArrayDiff(before.children, after.children);

  const summary = summariseRelationshipSync({
    addedParentIds: parentDiff.added,
    removedParentIds: parentDiff.removed,
    addedChildIds: childDiff.added,
    removedChildIds: childDiff.removed
  });

  if (!summary.changedCount) return summary;

  if (parentDiff.added.length) {
    await collection.updateMany(
      { id: { $in: parentDiff.added } },
      { $addToSet: { children: recordId } }
    );
  }

  if (parentDiff.removed.length) {
    await collection.updateMany(
      { id: { $in: parentDiff.removed } },
      { $pull: { children: recordId } }
    );
  }

  if (childDiff.added.length) {
    await collection.updateMany(
      { id: { $in: childDiff.added } },
      { $addToSet: { parentId: recordId } }
    );
  }

  if (childDiff.removed.length) {
    await collection.updateMany(
      { id: { $in: childDiff.removed } },
      { $pull: { parentId: recordId } }
    );
  }

  return summary;
}


function normaliseImportComparableLabel(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[’'`]/g, '')
    .replace(/[-–—_:;,.!?/\\|"“”‘’()（）]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasMeaningfulImportValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== '';
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildImportTypeColorDefaults(documents = []) {
  const countsByType = new Map();

  documents.forEach(document => {
    const type = String(document?.info?.type || '').trim();
    const color = String(document?.info?.color || '').trim();
    if (!type || !color) return;

    if (!countsByType.has(type)) countsByType.set(type, new Map());
    const colorCounts = countsByType.get(type);
    colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
  });

  const defaults = {};
  countsByType.forEach((colorCounts, type) => {
    const ranked = [...colorCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (ranked[0]) defaults[type] = ranked[0][0];
  });

  return defaults;
}

function applyImportTypeDefaultColor(info = {}, typeColorDefaults = {}) {
  const nextInfo = normaliseInfo(info || {});
  const type = String(nextInfo.type || '').trim();

  if (!hasMeaningfulImportValue(nextInfo.color) && type && typeColorDefaults[type]) {
    nextInfo.color = typeColorDefaults[type];
  }

  return nextInfo;
}

function appendUniqueImportText(existing = '', incoming = '') {
  const oldText = String(existing || '').trim();
  const newText = String(incoming || '').trim();
  if (!newText) return oldText;
  if (!oldText) return newText;
  if (oldText.includes(newText)) return oldText;
  if (newText.includes(oldText)) return newText;
  return `${oldText}\n\n${newText}`;
}

function mergeImportedInfo(existingInfo = {}, incomingInfo = {}) {
  const preferredExisting = new Set(['label', 'label_jp', 'birth', 'death']);
  const appendFields = new Set(['note', 'note_jp', 'article']);
  const keys = [...new Set([...Object.keys(existingInfo || {}), ...Object.keys(incomingInfo || {})])];
  const merged = {};

  keys.forEach(key => {
    const existing = existingInfo?.[key];
    const incoming = incomingInfo?.[key];

    if (appendFields.has(key)) {
      merged[key] = appendUniqueImportText(existing, incoming);
      return;
    }

    if (preferredExisting.has(key)) {
      merged[key] = hasMeaningfulImportValue(existing) ? existing : incoming;
      return;
    }

    // Conservative default: fill gaps from incoming CSV, but preserve existing data.
    merged[key] = hasMeaningfulImportValue(existing) ? existing : incoming;
  });

  Object.keys(merged).forEach(key => {
    if (merged[key] === undefined) delete merged[key];
  });

  return normaliseInfo(merged);
}

function buildReferenceImportFuse(documents = []) {
  return new Fuse(documents, {
    keys: ['info.label', 'info.label_jp', 'id'],
    threshold: 0.32,
    ignoreLocation: true,
    distance: 100,
    includeScore: true,
  });
}

function tokeniseImportComparableLabel(value = '') {
  return normaliseImportComparableLabel(value)
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function hasImportTokenAffinity(query = '', labels = []) {
  const queryTokens = tokeniseImportComparableLabel(query).filter(token => token.length >= 3);
  if (!queryTokens.length) return false;

  const labelTokens = labels.flatMap(label => tokeniseImportComparableLabel(label));
  if (!labelTokens.length) return false;

  return queryTokens.some(queryToken => labelTokens.some(labelToken => {
    if (queryToken === labelToken) return true;
    if (queryToken.length >= 5 && labelToken.startsWith(queryToken)) return true;
    if (labelToken.length >= 5 && queryToken.startsWith(labelToken)) return true;
    return false;
  }));
}

function isAcceptableImportSearchCandidate(candidate = {}, query = '') {
  if (candidate.exactMatch) return true;

  const wanted = normaliseImportComparableLabel(query);
  const compactLength = wanted.replace(/\s+/g, '').length;
  if (compactLength <= 4) return false;

  const labels = [candidate.info?.label, candidate.info?.label_jp].filter(Boolean);
  if (!hasImportTokenAffinity(query, labels)) return false;

  const score = typeof candidate.score === 'number' ? candidate.score : 1;
  const queryTokens = tokeniseImportComparableLabel(query);
  const maxScore = queryTokens.length <= 1 ? 0.16 : 0.24;
  return score <= maxScore;
}

function mapImportSearchCandidate(result, query = '') {
  const item = result.item || result;
  const info = item.info || {};
  const wanted = normaliseImportComparableLabel(query);
  const labels = [info.label, info.label_jp].filter(Boolean).map(normaliseImportComparableLabel);

  return {
    id: item.id,
    info,
    parentId: normaliseRelationshipArray(item.parentId),
    children: normaliseRelationshipArray(item.children),
    score: typeof result.score === 'number' ? result.score : null,
    exactMatch: Boolean(wanted && labels.includes(wanted))
  };
}

function searchImportCandidates(fuse, queries = [], limit = 5) {
  const resultMap = new Map();

  queries.filter(Boolean).forEach(query => {
    const safeQuery = String(query || '').trim();
    fuse.search(safeQuery, { limit: Math.max(limit * 8, 20) }).forEach(result => {
      const candidate = mapImportSearchCandidate(result, safeQuery);
      if (!isAcceptableImportSearchCandidate(candidate, safeQuery)) return;
      const previous = resultMap.get(candidate.id);
      if (!previous || candidate.exactMatch || (candidate.score ?? 1) < (previous.score ?? 1)) {
        resultMap.set(candidate.id, candidate);
      }
    });
  });

  return [...resultMap.values()]
    .sort((a, b) => Number(b.exactMatch) - Number(a.exactMatch) || (a.score ?? 1) - (b.score ?? 1))
    .slice(0, limit);
}

function slugifyImageCandidateLabel(label = '') {
  const slug = String(label || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

  return slug || 'image-candidate';
}

function getImageExtensionFromContentType(contentType = '') {
  const lower = String(contentType || '').toLowerCase();
  if (lower.includes('png')) return 'png';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('svg')) return 'svg';
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  return 'img';
}

function isBlockedImageCandidateHost(hostname = '') {
  const lower = String(hostname || '').toLowerCase();
  return lower === 'localhost'
    || lower === '0.0.0.0'
    || lower === '::1'
    || lower.startsWith('127.');
}

function safeJoinUrlParts(...parts) {
  return parts
    .map(part => String(part || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function buildImageKitDeliveryUrl(objectName) {
  const endpoint = String(process.env.IMAGEKIT_URL_ENDPOINT || '').trim().replace(/\/+$/g, '');
  const pathPrefix = String(process.env.IMAGEKIT_URL_PATH_PREFIX || '').trim();

  if (!endpoint) return '';

  return `${endpoint}/${safeJoinUrlParts(pathPrefix, objectName)}`;
}

function getImageQueueCloudConfigStatus() {
  const bucket = String(process.env.GCS_IMAGE_BUCKET || process.env.GCS_BUCKET_NAME || '').trim();
  const imageKitEndpoint = String(process.env.IMAGEKIT_URL_ENDPOINT || '').trim();

  return {
    hasGoogleStoragePackage: Boolean(GoogleCloudStorage),
    hasBucket: Boolean(bucket),
    hasImageKitEndpoint: Boolean(imageKitEndpoint),
    bucket,
    gcsImagePrefix: String(process.env.GCS_IMAGE_PREFIX || IMAGE_CLOUD_DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '') || IMAGE_CLOUD_DEFAULT_PREFIX,
    imageKitUrlEndpoint: imageKitEndpoint,
    imageKitUrlPathPrefix: String(process.env.IMAGEKIT_URL_PATH_PREFIX || '').trim()
  };
}

function getLocalImageCandidatePreviewPath(previewUrl = '') {
  const rawPreviewUrl = String(previewUrl || '').trim();
  const prefix = '/_image-candidate-preview/';

  if (!rawPreviewUrl.startsWith(prefix)) {
    return null;
  }

  const filename = path.basename(rawPreviewUrl.slice(prefix.length));
  if (!filename) return null;

  const filePath = path.resolve(IMAGE_CANDIDATE_PREVIEW_DIR, filename);
  const previewDir = path.resolve(IMAGE_CANDIDATE_PREVIEW_DIR);

  if (!filePath.startsWith(`${previewDir}${path.sep}`)) {
    return null;
  }

  return { filename, filePath };
}

function getSerpApiKey() {
  return String(process.env.SERPAPI_API_KEY || process.env.SERPAPI_KEY || '').trim();
}

function normaliseSerpApiImageCandidate(item = {}, index = 0, query = '') {
  const imageUrl = String(item.original || item.image || item.link || '').trim();
  if (!/^https?:\/\//i.test(imageUrl)) return null;

  return {
    imageUrl,
    originalUrl: imageUrl,
    thumbnailUrl: String(item.thumbnail || '').trim(),
    sourcePageUrl: String(item.link || '').trim(),
    title: String(item.title || '').trim(),
    source: String(item.source || '').trim(),
    originalWidth: item.original_width || null,
    originalHeight: item.original_height || null,
    position: item.position || index + 1,
    provider: 'serpapi-google-images',
    query
  };
}

function dedupeImageCandidates(candidates = []) {
  const seen = new Set();
  return candidates.filter(candidate => {
    if (!candidate?.imageUrl) return false;
    if (seen.has(candidate.imageUrl)) return false;
    seen.add(candidate.imageUrl);
    return true;
  });
}


function normaliseSourceMeta(sourceMeta = null) {
  if (!sourceMeta || typeof sourceMeta !== 'object' || Array.isArray(sourceMeta)) {
    return null;
  }

  const safeObject = value => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value }
      : {}
  );

  const nextSourceMeta = {
    source: typeof sourceMeta.source === 'string' ? sourceMeta.source : 'unknown-draft-source',
    capturedAt: typeof sourceMeta.capturedAt === 'string' ? sourceMeta.capturedAt : '',
    acceptedAt: typeof sourceMeta.acceptedAt === 'string' ? sourceMeta.acceptedAt : new Date().toISOString(),
    proposedType: typeof sourceMeta.proposedType === 'string' ? sourceMeta.proposedType : '',
    mappedFields: safeObject(sourceMeta.mappedFields),
    unmappedFields: safeObject(sourceMeta.unmappedFields),
    raw: safeObject(sourceMeta.raw),
    note: typeof sourceMeta.note === 'string' ? sourceMeta.note : ''
  };

  const hasMeaningfulData = nextSourceMeta.source
    || nextSourceMeta.capturedAt
    || nextSourceMeta.proposedType
    || Object.keys(nextSourceMeta.mappedFields).length
    || Object.keys(nextSourceMeta.unmappedFields).length
    || Object.keys(nextSourceMeta.raw).length;

  return hasMeaningfulData ? nextSourceMeta : null;
}

function normaliseDraftCapturePayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Draft capture payload must be a JSON object.');
  }

  const draftRecord = payload.draftRecord || payload.draft || payload;
  if (!draftRecord || typeof draftRecord !== 'object' || Array.isArray(draftRecord)) {
    throw new Error('Draft capture needs a draft-record object.');
  }

  const proposedInfo = draftRecord.proposedInfo || draftRecord.info || {};
  const proposedType = draftRecord.proposedType || proposedInfo.type || draftRecord.type;
  const raw = draftRecord.sourceMeta?.raw || draftRecord.raw || {};
  const proposedLabel = proposedInfo.label || raw.title;

  if (!proposedType) {
    throw new Error('Draft capture needs proposedType, proposedInfo.type, or info.type.');
  }

  if (!proposedLabel) {
    throw new Error('Draft capture needs proposedInfo.label, info.label, or sourceMeta.raw.title.');
  }

  return draftRecord;
}

client.connect().then(() => {
  db = client.db(dbName);
  console.log('Connected to MongoDB');
}).catch(err => console.error(err));

// Route to serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Local draft capture bridge for future browser extension / translator workflows.
// The browser-side tool can POST a draft object here while the modifier app is running,
// then the Add Single Record UI can pull the latest capture into the existing review flow.
app.post('/api/draft-capture', (req, res) => {
  try {
    const draftRecord = normaliseDraftCapturePayload(req.body);
    latestDraftCapture = {
      receivedAt: new Date().toISOString(),
      draftRecord
    };

    res.json({
      message: 'Draft capture received.',
      latest: latestDraftCapture
    });
  } catch (err) {
    console.error('Error receiving draft capture:', err);
    res.status(400).json({ error: err.toString() });
  }
});

app.get('/api/draft-capture/latest', (req, res) => {
  if (!latestDraftCapture) {
    res.status(404).json({ message: 'No draft capture has been received yet.' });
    return;
  }

  res.json(latestDraftCapture);
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
      keys: ['info.label', 'info.label_jp', 'id'],
      threshold: 0.3,
      ignoreLocation: true,
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
          label_jp: result.item.info.label_jp || '',
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
      keys: ['info.label', 'info.label_jp', 'id'],
      threshold: 0.3,
      ignoreLocation: true,
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
        label_jp: artwork.info.label_jp || '',
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
        label_jp: artwork.info.label_jp || '',
        date: artwork.info.date || null,
        type: artwork.info.type || null
      };
    });

    res.json(matchedItems);
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

// General reciprocal relationship connector.
// Any record type may be the parent and any record type may be a child.
// This is intentionally reciprocal, unlike direct relationship-array editing in the edit screen.
app.post('/api/reference/connect', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const parentId = typeof req.body?.parentId === 'string' ? req.body.parentId.trim() : '';
    const childIds = [...new Set(
      (Array.isArray(req.body?.childIds) ? req.body.childIds : [])
        .filter(id => typeof id === 'string')
        .map(id => id.trim())
        .filter(Boolean)
    )];

    if (!parentId) {
      return res.status(400).json({ message: 'A parentId is required.' });
    }

    if (childIds.length === 0) {
      return res.status(400).json({ message: 'At least one childId is required.' });
    }

    if (childIds.includes(parentId)) {
      return res.status(400).json({ message: 'A record cannot be connected as its own child.' });
    }

    // Validate the whole selection before writing anything.
    const requestedIds = [parentId, ...childIds];
    const existingRecords = await collection.find(
      { id: { $in: requestedIds } },
      { projection: { id: 1 } }
    ).toArray();
    const existingIds = new Set(existingRecords.map(record => record.id));

    if (!existingIds.has(parentId)) {
      return res.status(404).json({ message: 'Selected parent record was not found.' });
    }

    const missingChildIds = childIds.filter(id => !existingIds.has(id));
    if (missingChildIds.length > 0) {
      return res.status(400).json({
        message: 'One or more selected child records were not found.',
        missingChildIds
      });
    }

    const childUpdate = await collection.updateMany(
      { id: { $in: childIds } },
      { $addToSet: { parentId } }
    );

    const parentUpdate = await collection.updateOne(
      { id: parentId },
      { $addToSet: { children: { $each: childIds } } }
    );

    res.json({
      success: true,
      parentId,
      childIds,
      childrenMatched: childUpdate.matchedCount,
      childrenModified: childUpdate.modifiedCount,
      parentMatched: parentUpdate.matchedCount,
      parentModified: parentUpdate.modifiedCount
    });
  } catch (err) {
    console.error('Error connecting reference records:', err);
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

// Random records for the image queue: currently used to find artist/theorist
// records that do not yet have a usable image URL. This route is deliberately
// read-only and returns only lightweight record data for queueing.
app.get('/api/reference/image-queue/random-missing-images', async (req, res) => {
  try {
    const collection = db.collection('reference');
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 5)) : 5;
    const types = String(req.query.types || 'artist,theorist')
      .split(',')
      .map(type => type.trim())
      .filter(Boolean);
    const excludedIds = String(req.query.exclude || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

    const match = {
      'info.type': { $in: types.length ? types : ['artist', 'theorist'] },
      $and: [
        {
          $or: [
            { 'info.imgURL': { $exists: false } },
            { 'info.imgURL': null },
            { 'info.imgURL': '' }
          ]
        },
        {
          $or: [
            { 'info.image': { $exists: false } },
            { 'info.image': null },
            { 'info.image': '' }
          ]
        }
      ]
    };

    if (excludedIds.length) {
      match.id = { $nin: excludedIds };
    }

    const records = await collection.aggregate([
      { $match: match },
      { $sample: { size: limit } },
      {
        $project: {
          _id: 0,
          id: 1,
          info: 1
        }
      }
    ]).toArray();

    res.json(records);
  } catch (err) {
    console.error('Error fetching random image queue records:', err);
    res.status(500).json({ error: err.toString() });
  }
});

app.post('/api/reference/image-queue/serpapi-image-candidates', async (req, res) => {
  try {
    const apiKey = getSerpApiKey();
    const query = String(req.body?.query || '').trim();
    const rawLimit = Number.parseInt(req.body?.limit, 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(rawLimit, SERPAPI_IMAGE_CANDIDATE_LIMIT))
      : SERPAPI_IMAGE_CANDIDATE_LIMIT;

    if (!apiKey) {
      return res.status(503).json({ error: 'Set SERPAPI_API_KEY in .env before fetching image candidates.' });
    }

    if (!query) {
      return res.status(400).json({ error: 'query is required.' });
    }

    const params = new URLSearchParams({
      engine: 'google_images',
      q: query,
      api_key: apiKey,
      ijn: '0',
      hl: String(process.env.SERPAPI_GOOGLE_HL || 'en').trim() || 'en',
      gl: String(process.env.SERPAPI_GOOGLE_GL || 'uk').trim() || 'uk',
      safe: String(process.env.SERPAPI_GOOGLE_SAFE || 'active').trim() || 'active',
      output: 'json'
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response;
    try {
      response = await fetch(`https://serpapi.com/search?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
    } finally {
      clearTimeout(timeout);
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (jsonError) {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.error || `SerpApi request failed with status ${response.status}.`;
      return res.status(response.status).json({ error: message });
    }

    if (payload?.error) {
      return res.status(502).json({ error: String(payload.error) });
    }

    const rawResults = Array.isArray(payload?.images_results)
      ? payload.images_results
      : (Array.isArray(payload?.image_results) ? payload.image_results : []);

    const candidates = dedupeImageCandidates(
      rawResults
        .map((item, index) => normaliseSerpApiImageCandidate(item, index, query))
        .filter(Boolean)
        .filter(candidate => !candidate.unsafe)
    ).slice(0, limit);

    res.json({
      success: true,
      query,
      provider: 'serpapi-google-images',
      rawCount: rawResults.length,
      count: candidates.length,
      candidates,
      searchMetadata: {
        id: payload?.search_metadata?.id || '',
        status: payload?.search_metadata?.status || '',
        googleImagesUrl: payload?.search_metadata?.google_images_url || '',
        totalTimeTaken: payload?.search_metadata?.total_time_taken || null
      }
    });
  } catch (err) {
    console.error('Error fetching SerpApi image candidates:', err);
    const message = err.name === 'AbortError'
      ? 'SerpApi image candidate request timed out.'
      : err.toString();
    res.status(500).json({ error: message });
  }
});


// Validate and download one selected image candidate into a local temp preview folder.
// This is intentionally non-destructive: it does not upload to cloud storage and does
// not write imgURL/sourceMeta back to MongoDB.
app.post('/api/reference/image-queue/validate-image-candidate', async (req, res) => {
  try {
    const imageUrl = String(req.body?.imageUrl || '').trim();
    const recordId = String(req.body?.recordId || '').trim();
    const label = String(req.body?.label || '').trim();

    if (!imageUrl) {
      return res.status(400).json({ error: 'imageUrl is required.' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(imageUrl);
    } catch (err) {
      return res.status(400).json({ error: 'imageUrl must be a valid URL.' });
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return res.status(400).json({ error: 'Only http/https image URLs can be downloaded.' });
    }

    if (isBlockedImageCandidateHost(parsedUrl.hostname)) {
      return res.status(400).json({ error: 'Localhost/private preview URLs are not accepted for this download step.' });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch(parsedUrl.toString(), {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ModifierImageQueue/0.1; local research tool)'
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return res.status(502).json({ error: `Image request failed with status ${response.status}.` });
    }

    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim();
    if (!contentType.toLowerCase().startsWith('image/')) {
      return res.status(415).json({ error: `URL did not return an image content type (${contentType || 'unknown'}).` });
    }

    const announcedLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (Number.isFinite(announcedLength) && announcedLength > IMAGE_CANDIDATE_MAX_BYTES) {
      return res.status(413).json({ error: 'Image is larger than the 8 MB local preview limit.' });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length > IMAGE_CANDIDATE_MAX_BYTES) {
      return res.status(413).json({ error: 'Image is larger than the 8 MB local preview limit.' });
    }

    if (buffer.length < 128) {
      return res.status(422).json({ error: 'Downloaded file is too small to be a plausible image.' });
    }

    await fsp.mkdir(IMAGE_CANDIDATE_PREVIEW_DIR, { recursive: true });

    const ext = getImageExtensionFromContentType(contentType);
    const recordPart = recordId ? recordId.slice(0, 8) : uuidv4().slice(0, 8);
    const filename = `${slugifyImageCandidateLabel(label)}-${recordPart}-${Date.now()}-${uuidv4().slice(0, 8)}.${ext}`;
    const filePath = path.join(IMAGE_CANDIDATE_PREVIEW_DIR, filename);

    await fsp.writeFile(filePath, buffer);

    res.json({
      success: true,
      originalUrl: imageUrl,
      finalUrl: response.url || imageUrl,
      previewUrl: `/_image-candidate-preview/${filename}`,
      filename,
      contentType,
      sizeBytes: buffer.length,
      storage: 'local-temp-preview',
      savedAt: new Date().toISOString(),
      note: 'Downloaded for local preview only. No cloud upload and no database write.'
    });
  } catch (err) {
    console.error('Error validating/downloading image candidate:', err);
    const message = err.name === 'AbortError'
      ? 'Image request timed out.'
      : err.toString();
    res.status(500).json({ error: message });
  }
});


app.get('/api/reference/image-queue/cloud-config', (req, res) => {
  const status = getImageQueueCloudConfigStatus();
  res.json({
    ...status,
    ready: status.hasGoogleStoragePackage && status.hasBucket && status.hasImageKitEndpoint,
    installHint: status.hasGoogleStoragePackage ? '' : 'Run: npm install @google-cloud/storage',
    credentialHint: process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? 'GOOGLE_APPLICATION_CREDENTIALS is set.'
      : 'Set GOOGLE_APPLICATION_CREDENTIALS to a local service-account JSON path, or use your existing gcloud auth setup.'
  });
});


// Upload a previously validated local image candidate to Google Cloud Storage
// without writing to MongoDB. This is used by the Add Single Record/browser-capture
// flow, where the record does not exist yet: the returned ImageKit URL is written
// into the form and saved with the new record later.
app.post('/api/reference/image-queue/upload-local-image-candidate', async (req, res) => {
  try {
    const selectedImageCandidateUrl = String(req.body?.selectedImageCandidateUrl || '').trim();
    const selectedDownload = req.body?.selectedImageCandidateDownload || {};
    const selectedMeta = req.body?.selectedImageCandidateMeta && typeof req.body.selectedImageCandidateMeta === 'object'
      ? req.body.selectedImageCandidateMeta
      : {};
    const previewUrl = String(selectedDownload?.previewUrl || '').trim();
    const label = String(req.body?.label || 'draft-image').trim() || 'draft-image';
    const type = String(req.body?.type || 'draft').trim() || 'draft';

    if (!selectedImageCandidateUrl) {
      return res.status(400).json({ error: 'selectedImageCandidateUrl is required.' });
    }

    const config = getImageQueueCloudConfigStatus();
    if (!config.hasGoogleStoragePackage) {
      return res.status(503).json({ error: 'Google Cloud Storage package is not installed. Run: npm install @google-cloud/storage' });
    }

    if (!config.hasBucket) {
      return res.status(503).json({ error: 'Set GCS_IMAGE_BUCKET or GCS_BUCKET_NAME in .env before uploading images.' });
    }

    if (!config.hasImageKitEndpoint) {
      return res.status(503).json({ error: 'Set IMAGEKIT_URL_ENDPOINT in .env before saving an ImageKit delivery URL.' });
    }

    const localPreview = getLocalImageCandidatePreviewPath(previewUrl);
    if (!localPreview) {
      return res.status(400).json({ error: 'selectedImageCandidateDownload.previewUrl must point to a local _image-candidate-preview file.' });
    }

    try {
      await fsp.access(localPreview.filePath, fs.constants.R_OK);
    } catch (err) {
      return res.status(404).json({ error: 'Local preview file was not found. Validate/download the image again before uploading.' });
    }

    const ext = path.extname(localPreview.filename).replace(/^\./, '') || 'jpg';
    const objectName = safeJoinUrlParts(
      config.gcsImagePrefix,
      type,
      `${slugifyImageCandidateLabel(label)}-${uuidv4()}.${ext}`
    );

    const storage = new GoogleCloudStorage();
    const bucket = storage.bucket(config.bucket);
    const contentType = String(selectedDownload?.contentType || '').trim() || undefined;

    await bucket.upload(localPreview.filePath, {
      destination: objectName,
      metadata: {
        contentType,
        metadata: {
          sourceUrl: selectedImageCandidateUrl,
          recordLabel: label,
          draftUpload: 'true'
        }
      }
    });

    const deliveryUrl = buildImageKitDeliveryUrl(objectName);
    const savedAt = new Date().toISOString();
    const imageSource = {
      method: selectedMeta?.provider === 'browser-capture'
        ? 'browser-capture-image-candidate'
        : 'local-image-candidate-upload',
      provider: selectedMeta?.provider || 'manual',
      selectedAt: savedAt,
      originalImageUrl: selectedImageCandidateUrl,
      downloadedFinalUrl: selectedDownload?.finalUrl || selectedImageCandidateUrl,
      sourcePageUrl: selectedMeta?.sourcePageUrl || '',
      source: selectedMeta?.source || '',
      title: selectedMeta?.title || '',
      searchQuery: selectedMeta?.query || '',
      thumbnailUrl: selectedMeta?.thumbnailUrl || '',
      sourceField: selectedMeta?.sourceField || '',
      originalWidth: selectedMeta?.originalWidth || null,
      originalHeight: selectedMeta?.originalHeight || null,
      localPreviewUrl: previewUrl,
      gcsBucket: config.bucket,
      gcsObjectName: objectName,
      imageKitUrl: deliveryUrl,
      contentType: contentType || '',
      sizeBytes: selectedDownload?.sizeBytes || null
    };

    res.json({
      success: true,
      imgURL: deliveryUrl,
      gcsBucket: config.bucket,
      gcsObjectName: objectName,
      imageSource
    });
  } catch (err) {
    console.error('Error uploading local image candidate:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Upload a browser-selected local file directly to Google Cloud Storage. This is used
// by Add Single Record and Search/Edit Records as a GUI bridge from a local file to
// the app's cloud image URL field. It accepts base64 JSON to avoid adding multipart
// middleware to this small local maintenance app.
app.post('/api/reference/image-queue/upload-file', async (req, res) => {
  try {
    const fileName = String(req.body?.fileName || 'uploaded-image').trim();
    const contentType = String(req.body?.contentType || '').split(';')[0].trim();
    const base64Data = String(req.body?.base64Data || '').trim();
    const recordId = String(req.body?.recordId || '').trim();
    const label = String(req.body?.label || recordId || 'uploaded-image').trim() || 'uploaded-image';
    const type = String(req.body?.type || 'manual-upload').trim() || 'manual-upload';
    const writeToRecord = Boolean(req.body?.writeToRecord);

    if (!contentType.toLowerCase().startsWith('image/')) {
      return res.status(415).json({ error: 'Uploaded file must have an image/* content type.' });
    }

    if (!base64Data) {
      return res.status(400).json({ error: 'base64Data is required.' });
    }

    let buffer;
    try {
      buffer = Buffer.from(base64Data, 'base64');
    } catch (err) {
      return res.status(400).json({ error: 'base64Data could not be decoded.' });
    }

    if (!buffer.length || buffer.length < 128) {
      return res.status(422).json({ error: 'Uploaded file is too small to be a plausible image.' });
    }

    if (buffer.length > IMAGE_CANDIDATE_MAX_BYTES) {
      return res.status(413).json({ error: 'Uploaded image is larger than the 8 MB limit.' });
    }

    const config = getImageQueueCloudConfigStatus();
    if (!config.hasGoogleStoragePackage) {
      return res.status(503).json({ error: 'Google Cloud Storage package is not installed. Run: npm install @google-cloud/storage' });
    }

    if (!config.hasBucket) {
      return res.status(503).json({ error: 'Set GCS_IMAGE_BUCKET or GCS_BUCKET_NAME in .env before uploading images.' });
    }

    if (!config.hasImageKitEndpoint) {
      return res.status(503).json({ error: 'Set IMAGEKIT_URL_ENDPOINT in .env before saving an ImageKit delivery URL.' });
    }

    let record = null;
    if (writeToRecord) {
      if (!recordId) {
        return res.status(400).json({ error: 'recordId is required when writeToRecord is true.' });
      }
      record = await db.collection('reference').findOne({ id: recordId });
      if (!record) {
        return res.status(404).json({ error: 'Record not found.' });
      }
    }

    const ext = getImageExtensionFromContentType(contentType) || path.extname(fileName).replace(/^\./, '') || 'jpg';
    const objectName = safeJoinUrlParts(
      config.gcsImagePrefix,
      type,
      `${slugifyImageCandidateLabel(label)}-${recordId || uuidv4()}.${ext}`
    );

    const storage = new GoogleCloudStorage();
    const bucket = storage.bucket(config.bucket);
    await bucket.file(objectName).save(buffer, {
      metadata: {
        contentType,
        metadata: {
          sourceUrl: 'local-file-upload',
          originalFileName: fileName,
          recordId: recordId || '',
          recordLabel: label
        }
      }
    });

    const deliveryUrl = buildImageKitDeliveryUrl(objectName);
    const savedAt = new Date().toISOString();
    const imageSource = {
      method: 'local-file-upload',
      provider: 'local-file',
      selectedAt: savedAt,
      originalFileName: fileName,
      originalImageUrl: 'local-file-upload',
      downloadedFinalUrl: '',
      sourcePageUrl: '',
      source: 'local-file-upload',
      title: fileName,
      searchQuery: '',
      thumbnailUrl: '',
      gcsBucket: config.bucket,
      gcsObjectName: objectName,
      imageKitUrl: deliveryUrl,
      contentType,
      sizeBytes: buffer.length
    };

    if (writeToRecord && record) {
      const previousSourceMeta = record.sourceMeta && typeof record.sourceMeta === 'object' && !Array.isArray(record.sourceMeta)
        ? record.sourceMeta
        : {};
      await db.collection('reference').updateOne(
        { id: recordId },
        {
          $set: {
            'info.imgURL': deliveryUrl,
            sourceMeta: {
              ...previousSourceMeta,
              imageSource
            }
          }
        }
      );
    }

    res.json({
      success: true,
      recordId,
      imgURL: deliveryUrl,
      gcsBucket: config.bucket,
      gcsObjectName: objectName,
      imageSource
    });
  } catch (err) {
    console.error('Error uploading local file image:', err);
    res.status(500).json({ error: err.toString() });
  }
});


// Upload a previously validated local image candidate to Google Cloud Storage,
// construct the corresponding ImageKit delivery URL, and save it as info.imgURL.
app.post('/api/reference/image-queue/finalise-image-candidate', async (req, res) => {
  try {
    const recordId = String(req.body?.recordId || '').trim();
    const selectedImageCandidateUrl = String(req.body?.selectedImageCandidateUrl || '').trim();
    const selectedDownload = req.body?.selectedImageCandidateDownload || {};
    const selectedMeta = req.body?.selectedImageCandidateMeta && typeof req.body.selectedImageCandidateMeta === 'object'
      ? req.body.selectedImageCandidateMeta
      : {};
    const previewUrl = String(selectedDownload?.previewUrl || '').trim();

    if (!recordId) {
      return res.status(400).json({ error: 'recordId is required.' });
    }

    if (!selectedImageCandidateUrl) {
      return res.status(400).json({ error: 'selectedImageCandidateUrl is required.' });
    }

    const config = getImageQueueCloudConfigStatus();
    if (!config.hasGoogleStoragePackage) {
      return res.status(503).json({ error: 'Google Cloud Storage package is not installed. Run: npm install @google-cloud/storage' });
    }

    if (!config.hasBucket) {
      return res.status(503).json({ error: 'Set GCS_IMAGE_BUCKET or GCS_BUCKET_NAME in .env before uploading images.' });
    }

    if (!config.hasImageKitEndpoint) {
      return res.status(503).json({ error: 'Set IMAGEKIT_URL_ENDPOINT in .env before saving an ImageKit delivery URL.' });
    }

    const localPreview = getLocalImageCandidatePreviewPath(previewUrl);
    if (!localPreview) {
      return res.status(400).json({ error: 'selectedImageCandidateDownload.previewUrl must point to a local _image-candidate-preview file.' });
    }

    try {
      await fsp.access(localPreview.filePath, fs.constants.R_OK);
    } catch (err) {
      return res.status(404).json({ error: 'Local preview file was not found. Validate/download the image again before uploading.' });
    }

    const collection = db.collection('reference');
    const record = await collection.findOne({ id: recordId });
    if (!record) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    const info = record.info || {};
    const label = String(info.label || req.body?.label || recordId || 'image').trim();
    const type = String(info.type || 'record').trim();
    const ext = path.extname(localPreview.filename).replace(/^\./, '') || 'jpg';
    const objectName = safeJoinUrlParts(
      config.gcsImagePrefix,
      type,
      `${slugifyImageCandidateLabel(label)}-${recordId}.${ext}`
    );

    const storage = new GoogleCloudStorage();
    const bucket = storage.bucket(config.bucket);
    const contentType = String(selectedDownload?.contentType || '').trim() || undefined;

    await bucket.upload(localPreview.filePath, {
      destination: objectName,
      metadata: {
        contentType,
        metadata: {
          sourceUrl: selectedImageCandidateUrl,
          recordId,
          recordLabel: label
        }
      }
    });

    const deliveryUrl = buildImageKitDeliveryUrl(objectName);
    const savedAt = new Date().toISOString();
    const previousSourceMeta = record.sourceMeta && typeof record.sourceMeta === 'object' && !Array.isArray(record.sourceMeta)
      ? record.sourceMeta
      : {};

    const imageSource = {
      method: selectedMeta?.provider === 'serpapi-google-images'
        ? 'serpapi-google-image-candidate'
        : 'manual-image-candidate',
      provider: selectedMeta?.provider || 'manual',
      selectedAt: savedAt,
      originalImageUrl: selectedImageCandidateUrl,
      downloadedFinalUrl: selectedDownload?.finalUrl || selectedImageCandidateUrl,
      sourcePageUrl: selectedMeta?.sourcePageUrl || '',
      source: selectedMeta?.source || '',
      title: selectedMeta?.title || '',
      searchQuery: selectedMeta?.query || '',
      thumbnailUrl: selectedMeta?.thumbnailUrl || '',
      originalWidth: selectedMeta?.originalWidth || null,
      originalHeight: selectedMeta?.originalHeight || null,
      localPreviewUrl: previewUrl,
      gcsBucket: config.bucket,
      gcsObjectName: objectName,
      imageKitUrl: deliveryUrl,
      contentType: contentType || '',
      sizeBytes: selectedDownload?.sizeBytes || null
    };

    await collection.updateOne(
      { id: recordId },
      {
        $set: {
          'info.imgURL': deliveryUrl,
          sourceMeta: {
            ...previousSourceMeta,
            imageSource
          }
        }
      }
    );

    res.json({
      success: true,
      recordId,
      imgURL: deliveryUrl,
      gcsBucket: config.bucket,
      gcsObjectName: objectName,
      imageSource
    });
  } catch (err) {
    console.error('Error finalising image candidate:', err);
    res.status(500).json({ error: err.toString() });
  }
});


function hasReferenceImage(info = {}) {
  return ['imgURL', 'imgUrl', 'imageURL', 'imageUrl', 'image_url', 'image']
    .some(key => String(info?.[key] || '').trim());
}

function getReferenceLabel(document = {}) {
  return String(document?.info?.label || document?.label || document?.id || '').trim();
}

function summariseBatchReferenceRecord(document = {}, documentsById = new Map()) {
  const info = document.info || {};
  const parentIds = normaliseRelationshipArray(document.parentId);
  const childIds = normaliseRelationshipArray(document.children);

  return {
    id: document.id,
    info,
    parentId: parentIds,
    children: childIds,
    parentLabels: parentIds.map(parentId => getReferenceLabel(documentsById.get(parentId))).filter(Boolean),
    childLabels: childIds.map(childId => getReferenceLabel(documentsById.get(childId))).filter(Boolean),
    hasImage: hasReferenceImage(info)
  };
}

function getReferenceBatchChildIds(document = {}, childIdsByParentId = new Map()) {
  const explicitChildren = normaliseRelationshipArray(document.children);
  const reverseChildren = childIdsByParentId.get(document.id) || [];
  return [...new Set([...explicitChildren, ...reverseChildren])].filter(Boolean);
}


function getBatchRecordTypeFilter(value = '') {
  return String(value || '')
    .split(',')
    .map(type => type.trim())
    .filter(Boolean);
}

function summariseBatchCuration(document = {}) {
  const curationId = document.curationId || String(document._id || '');
  const includedNodes = Array.isArray(document.includedNodes) ? document.includedNodes : [];
  return {
    source: 'curation',
    id: curationId,
    curationId,
    name: document.name || document.title || curationId,
    description: document.description || '',
    createdAt: document.createdAt || '',
    updatedAt: document.updatedAt || document.savedAt || document.modifiedAt || '',
    includedCount: includedNodes.length,
    info: {
      label: document.name || document.title || curationId,
      type: 'curation',
      note: document.description || ''
    }
  };
}

function summariseBatchRootReference(document = {}) {
  return {
    source: 'reference',
    id: document.id,
    info: document.info || {},
    parentId: normaliseRelationshipArray(document.parentId),
    children: normaliseRelationshipArray(document.children)
  };
}


function normaliseCurationNodeId(node = {}) {
  return String(node?.id || node?.info?.id || '').trim();
}

function normaliseCurationConnection(connection = {}, fallbackType = 'custom') {
  const source = String(connection?.source || '').trim();
  const target = String(connection?.target || '').trim();
  if (!source || !target) return null;
  return {
    source,
    target,
    type: String(connection?.type || fallbackType || 'custom').trim() || 'custom'
  };
}

function addUniqueCurationConnection(map, connection) {
  if (!connection?.source || !connection?.target) return;
  const key = `${connection.type || 'database'}::${connection.source}::${connection.target}`;
  if (!map.has(key)) map.set(key, connection);
}

function buildDatabaseCurationConnections(records = [], includedIds = []) {
  const includedSet = new Set(includedIds.map(id => String(id || '').trim()).filter(Boolean));
  const connectionMap = new Map();

  records.forEach(record => {
    const id = String(record?.id || '').trim();
    if (!id || !includedSet.has(id)) return;

    normaliseRelationshipArray(record.children).forEach(childId => {
      if (childId !== id && includedSet.has(childId)) {
        addUniqueCurationConnection(connectionMap, { source: id, target: childId, type: 'database' });
      }
    });

    normaliseRelationshipArray(record.parentId).forEach(parentId => {
      if (parentId !== id && includedSet.has(parentId)) {
        addUniqueCurationConnection(connectionMap, { source: parentId, target: id, type: 'database' });
      }
    });
  });

  return [...connectionMap.values()].sort((a, b) => (
    `${a.source}|${a.target}`.localeCompare(`${b.source}|${b.target}`)
  ));
}

function getCustomCurationConnections(curation = {}) {
  const customMap = new Map();

  (Array.isArray(curation.customConnections) ? curation.customConnections : [])
    .map(connection => normaliseCurationConnection(connection, 'custom'))
    .filter(Boolean)
    .forEach(connection => addUniqueCurationConnection(customMap, connection));

  (Array.isArray(curation.curationConnections) ? curation.curationConnections : [])
    .map(connection => normaliseCurationConnection(connection, 'database'))
    .filter(connection => connection && connection.type === 'custom')
    .forEach(connection => addUniqueCurationConnection(customMap, connection));

  return [...customMap.values()];
}

async function buildCurationConnectionSnapshot(referenceCollection, includedIds = [], existingCuration = {}) {
  const orderedIds = [...new Set(includedIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (!orderedIds.length) return { databaseConnections: [], customConnections: [], curationConnections: [] };

  const records = await referenceCollection.find(
    { id: { $in: orderedIds } },
    { projection: { id: 1, parentId: 1, children: 1 } }
  ).toArray();

  const databaseConnections = buildDatabaseCurationConnections(records, orderedIds);
  const includedSet = new Set(orderedIds);
  const customConnections = getCustomCurationConnections(existingCuration).filter(connection => (
    includedSet.has(connection.source) && includedSet.has(connection.target)
  ));
  const curationConnections = [...databaseConnections, ...customConnections];

  return { databaseConnections, customConnections, curationConnections };
}

function summariseDeleteImpactRecord(document = {}) {
  const info = document.info || {};
  return {
    id: document.id,
    label: info.label || document.id,
    label_jp: info.label_jp || '',
    type: info.type || ''
  };
}

function curationContainsAnyDeletedId(curation = {}, deletedIds = new Set()) {
  const nodes = Array.isArray(curation.includedNodes) ? curation.includedNodes : [];
  const connections = [
    ...(Array.isArray(curation.curationConnections) ? curation.curationConnections : []),
    ...(Array.isArray(curation.customConnections) ? curation.customConnections : [])
  ];

  return nodes.some(node => deletedIds.has(normaliseCurationNodeId(node)))
    || connections.some(connection => deletedIds.has(String(connection?.source || '').trim()) || deletedIds.has(String(connection?.target || '').trim()));
}

function cleanCurationAfterRecordDeletion(curation = {}, deletedIds = new Set()) {
  const includedNodes = (Array.isArray(curation.includedNodes) ? curation.includedNodes : [])
    .filter(node => !deletedIds.has(normaliseCurationNodeId(node)));

  const curationConnections = (Array.isArray(curation.curationConnections) ? curation.curationConnections : [])
    .filter(connection => (
      !deletedIds.has(String(connection?.source || '').trim())
      && !deletedIds.has(String(connection?.target || '').trim())
    ));

  const customConnections = (Array.isArray(curation.customConnections) ? curation.customConnections : [])
    .filter(connection => (
      !deletedIds.has(String(connection?.source || '').trim())
      && !deletedIds.has(String(connection?.target || '').trim())
    ));

  return { includedNodes, curationConnections, customConnections };
}

// Fast-ish typed source search for Batch Records. This keeps the UI from
// always fuzzy-searching every reference record when the user knows they only
// want paradigms / people / books, and it also introduces saved curations as a
// selection source rather than an editable data source.
app.get('/api/batch-records/root-search', async (req, res) => {
  try {
    const source = String(req.query.source || 'reference') === 'curation' ? 'curation' : 'reference';
    const query = String(req.query.query || '').trim();
    const typeFilter = getBatchRecordTypeFilter(req.query.types || '');

    if (!query) {
      return res.status(400).json({ message: 'Search query is required.' });
    }

    if (source === 'curation') {
      const collection = db.collection('curation');
      const documents = await collection
        .find({}, {
          projection: {
            curationId: 1,
            name: 1,
            title: 1,
            description: 1,
            includedNodes: 1,
            createdAt: 1,
            updatedAt: 1,
            savedAt: 1,
            modifiedAt: 1
          }
        })
        .toArray();

      const exactMatches = documents.filter(document => String(document.curationId || '') === query);
      const fuse = new Fuse(documents, {
        keys: ['name', 'title', 'description', 'curationId'],
        threshold: 0.34,
        ignoreLocation: true,
        distance: 100,
        includeScore: true
      });
      const fuzzyMatches = fuse.search(query).map(result => result.item);
      const seen = new Set();
      const results = [...exactMatches, ...fuzzyMatches]
        .filter(document => {
          const id = document.curationId || String(document._id || '');
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, 40)
        .map(summariseBatchCuration);

      return res.json({ source, results });
    }

    const collection = db.collection('reference');
    const mongoFilter = typeFilter.length ? { 'info.type': { $in: typeFilter } } : {};
    const documents = await collection.find(mongoFilter).toArray();
    const exactMatches = documents.filter(document => String(document.id || '') === query);
    const fuse = new Fuse(documents, {
      keys: ['info.label', 'info.label_jp', 'id'],
      threshold: 0.3,
      ignoreLocation: true,
      distance: 100,
      includeScore: true
    });
    const fuzzyMatches = fuse.search(query).map(result => result.item);
    const seen = new Set();
    const results = [...exactMatches, ...fuzzyMatches]
      .filter(document => {
        const id = document.id;
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, 40)
      .map(summariseBatchRootReference);

    res.json({ source, typeFilter, results });
  } catch (err) {
    console.error('Error searching batch roots:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Load canonical reference records from a saved curation. The curation is only a
// selection source: durable edits still target the reference collection.
app.get('/api/batch-records/curation-cluster/:id', async (req, res) => {
  try {
    const curationId = String(req.params.id || '').trim();
    const missingImagesOnly = String(req.query.missingImagesOnly || '') === 'true';
    const typeFilter = getBatchRecordTypeFilter(req.query.types || '');

    if (!curationId) {
      return res.status(400).json({ message: 'Curation id is required.' });
    }

    const curationCollection = db.collection('curation');
    const referenceCollection = db.collection('reference');
    const curation = await curationCollection.findOne({ curationId });

    if (!curation) {
      return res.status(404).json({ message: 'Curation not found.' });
    }

    const includedNodes = Array.isArray(curation.includedNodes) ? curation.includedNodes : [];
    const orderedIds = [...new Set(
      includedNodes
        .map(node => String(node?.id || node?.info?.id || '').trim())
        .filter(Boolean)
    )];

    const documents = orderedIds.length
      ? await referenceCollection.find({ id: { $in: orderedIds } }).toArray()
      : [];
    const allRelationshipDocs = await referenceCollection.find({}).toArray();
    const documentsById = new Map(allRelationshipDocs.map(document => [document.id, document]).filter(([id]) => id));
    const loadedById = new Map(documents.map(document => [document.id, document]).filter(([id]) => id));
    const missingReferenceIds = orderedIds.filter(id => !loadedById.has(id));

    const records = orderedIds
      .map((id, index) => ({ document: loadedById.get(id), index }))
      .filter(({ document }) => document)
      .filter(({ document }) => {
        const info = document.info || {};
        if (typeFilter.length && !typeFilter.includes(String(info.type || '').trim())) return false;
        if (missingImagesOnly && hasReferenceImage(info)) return false;
        return true;
      })
      .map(({ document, index }) => ({
        ...summariseBatchReferenceRecord(document, documentsById),
        depth: 0,
        curationOrder: index,
        sourceCurationId: curationId
      }));

    res.json({
      source: 'curation',
      curation: summariseBatchCuration(curation),
      typeFilter,
      missingImagesOnly,
      records,
      summary: {
        curationId,
        includedNodeCount: orderedIds.length,
        returnedCount: records.length,
        missingReferenceIds
      }
    });
  } catch (err) {
    console.error('Error loading curation batch records:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Read-only cluster loader for the Batch Records workbench.
// It deliberately performs no writes: it only resolves root children/descendants
// from both sides of the reference relationship contract.
app.get('/api/reference/batch-records/cluster/:id', async (req, res) => {
  try {
    const rootId = String(req.params.id || '').trim();
    const depth = String(req.query.depth || 'recursive') === 'direct' ? 'direct' : 'recursive';
    const includeRoot = String(req.query.includeRoot || '') === 'true';
    const missingImagesOnly = String(req.query.missingImagesOnly || '') === 'true';
    const typeFilter = String(req.query.types || '')
      .split(',')
      .map(type => type.trim())
      .filter(Boolean);

    if (!rootId) {
      return res.status(400).json({ message: 'Root record id is required.' });
    }

    const collection = db.collection('reference');
    const documents = await collection.find({}).toArray();
    const documentsById = new Map(documents.map(document => [document.id, document]).filter(([id]) => id));
    const root = documentsById.get(rootId);

    if (!root) {
      return res.status(404).json({ message: 'Root record not found.' });
    }

    const childIdsByParentId = new Map();
    documents.forEach(document => {
      normaliseRelationshipArray(document.parentId).forEach(parentId => {
        if (!childIdsByParentId.has(parentId)) childIdsByParentId.set(parentId, []);
        childIdsByParentId.get(parentId).push(document.id);
      });
    });

    const visited = new Set();
    const queue = getReferenceBatchChildIds(root, childIdsByParentId)
      .map(childId => ({ id: childId, depth: 1 }));
    const discovered = [];
    const missingRelationshipTargets = [];

    while (queue.length) {
      const current = queue.shift();
      if (!current?.id || visited.has(current.id)) continue;
      visited.add(current.id);

      const document = documentsById.get(current.id);
      if (!document) {
        missingRelationshipTargets.push(current.id);
        continue;
      }

      discovered.push({ document, depth: current.depth });

      if (depth === 'recursive') {
        getReferenceBatchChildIds(document, childIdsByParentId).forEach(childId => {
          if (!visited.has(childId)) queue.push({ id: childId, depth: current.depth + 1 });
        });
      }
    }

    let scopedRecords = discovered;
    if (includeRoot) {
      scopedRecords = [{ document: root, depth: 0 }, ...scopedRecords];
    }

    const filteredRecords = scopedRecords.filter(({ document }) => {
      const info = document.info || {};
      if (typeFilter.length && !typeFilter.includes(String(info.type || '').trim())) return false;
      if (missingImagesOnly && hasReferenceImage(info)) return false;
      return true;
    });

    const records = filteredRecords
      .map(({ document, depth: recordDepth }) => ({
        ...summariseBatchReferenceRecord(document, documentsById),
        depth: recordDepth
      }))
      .sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        return getReferenceLabel(a).localeCompare(getReferenceLabel(b));
      });

    res.json({
      root: summariseBatchReferenceRecord(root, documentsById),
      depth,
      includeRoot,
      typeFilter,
      missingImagesOnly,
      records,
      summary: {
        rootId,
        discoveredCount: discovered.length,
        returnedCount: records.length,
        missingRelationshipTargets: [...new Set(missingRelationshipTargets)]
      }
    });
  } catch (err) {
    console.error('Error loading batch record cluster:', err);
    res.status(500).json({ error: err.toString() });
  }
});


// Reviewed repeated operation for Batch Records: add one parent to many selected
// records and update the parent's children array reciprocally.
app.post('/api/reference/batch-records/add-parent', async (req, res) => {
  try {
    const parentId = String(req.body?.parentId || '').trim();
    const recordIds = [...new Set(
      (Array.isArray(req.body?.recordIds) ? req.body.recordIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    )];

    if (!parentId) {
      return res.status(400).json({ message: 'parentId is required.' });
    }

    if (!recordIds.length) {
      return res.status(400).json({ message: 'At least one record id is required.' });
    }

    const collection = db.collection('reference');
    const parent = await collection.findOne({ id: parentId });

    if (!parent) {
      return res.status(404).json({ message: 'Parent record not found.' });
    }

    const records = await collection.find({ id: { $in: recordIds } }).toArray();
    const recordsById = new Map(records.map(document => [document.id, document]).filter(([id]) => id));
    const operations = [];
    const changedRecordIds = [];
    const rows = recordIds.map(id => {
      if (id === parentId) return { id, status: 'skipped-self-parent' };
      const record = recordsById.get(id);
      if (!record) return { id, status: 'missing-record' };
      const parentIds = normaliseRelationshipArray(record.parentId);
      if (parentIds.includes(parentId)) return { id, status: 'already-present' };
      const nextParentIds = [...parentIds, parentId];
      operations.push({
        updateOne: {
          filter: { id },
          update: { $set: { parentId: nextParentIds } }
        }
      });
      changedRecordIds.push(id);
      return { id, status: 'parent-added', parentId: nextParentIds };
    });

    const parentChildren = normaliseRelationshipArray(parent.children);
    const nextParentChildren = [...new Set([...parentChildren, ...changedRecordIds])];
    const parentChildrenChanged = nextParentChildren.length !== parentChildren.length;

    if (parentChildrenChanged) {
      operations.push({
        updateOne: {
          filter: { id: parentId },
          update: { $set: { children: nextParentChildren } }
        }
      });
    }

    if (operations.length) {
      await collection.bulkWrite(operations);
    }

    const allDocuments = await collection.find({}).toArray();
    const documentsById = new Map(allDocuments.map(document => [document.id, document]).filter(([id]) => id));
    const updatedRecords = changedRecordIds
      .map(id => documentsById.get(id))
      .filter(Boolean)
      .map(document => summariseBatchReferenceRecord(document, documentsById));

    res.json({
      message: `Batch parent add complete: ${changedRecordIds.length} record${changedRecordIds.length === 1 ? '' : 's'} changed${parentChildrenChanged ? '; parent children list updated' : ''}.`,
      rows,
      updatedRecords,
      parentChildrenChanged,
      summary: {
        requestedCount: recordIds.length,
        changedCount: changedRecordIds.length,
        noopCount: rows.filter(row => row.status === 'already-present').length,
        missingCount: rows.filter(row => row.status === 'missing-record').length,
        skippedSelfParentCount: rows.filter(row => row.status === 'skipped-self-parent').length
      }
    });
  } catch (err) {
    console.error('Error applying batch parent add:', err);
    res.status(500).json({ error: err.toString() });
  }
});


// Reviewed repeated operation for Batch Records: add one child to many selected
// records and update the child's parentId array reciprocally.
app.post('/api/reference/batch-records/add-child', async (req, res) => {
  try {
    const childId = String(req.body?.childId || '').trim();
    const recordIds = [...new Set(
      (Array.isArray(req.body?.recordIds) ? req.body.recordIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    )];

    if (!childId) {
      return res.status(400).json({ message: 'childId is required.' });
    }

    if (!recordIds.length) {
      return res.status(400).json({ message: 'At least one record id is required.' });
    }

    const collection = db.collection('reference');
    const child = await collection.findOne({ id: childId });

    if (!child) {
      return res.status(404).json({ message: 'Child record not found.' });
    }

    const records = await collection.find({ id: { $in: recordIds } }).toArray();
    const recordsById = new Map(records.map(document => [document.id, document]).filter(([id]) => id));
    const operations = [];
    const changedRecordIds = [];
    const rows = recordIds.map(id => {
      if (id === childId) return { id, status: 'skipped-self-child' };
      const record = recordsById.get(id);
      if (!record) return { id, status: 'missing-record' };
      const childIds = normaliseRelationshipArray(record.children);
      if (childIds.includes(childId)) return { id, status: 'already-present' };
      const nextChildIds = [...childIds, childId];
      operations.push({
        updateOne: {
          filter: { id },
          update: { $set: { children: nextChildIds } }
        }
      });
      changedRecordIds.push(id);
      return { id, status: 'child-added', children: nextChildIds };
    });

    const childParents = normaliseRelationshipArray(child.parentId);
    const nextChildParents = [...new Set([...childParents, ...changedRecordIds])];
    const childParentsChanged = nextChildParents.length !== childParents.length;

    if (childParentsChanged) {
      operations.push({
        updateOne: {
          filter: { id: childId },
          update: { $set: { parentId: nextChildParents } }
        }
      });
    }

    if (operations.length) {
      await collection.bulkWrite(operations);
    }

    const allDocuments = await collection.find({}).toArray();
    const documentsById = new Map(allDocuments.map(document => [document.id, document]).filter(([id]) => id));
    const updatedRecordIds = [...new Set([...changedRecordIds, childId])];
    const updatedRecords = updatedRecordIds
      .map(id => documentsById.get(id))
      .filter(Boolean)
      .map(document => summariseBatchReferenceRecord(document, documentsById));

    res.json({
      message: `Batch child add complete: ${changedRecordIds.length} record${changedRecordIds.length === 1 ? '' : 's'} changed${childParentsChanged ? '; child parent list updated' : ''}.`,
      rows,
      updatedRecords,
      childParentsChanged,
      summary: {
        requestedCount: recordIds.length,
        changedCount: changedRecordIds.length,
        noopCount: rows.filter(row => row.status === 'already-present').length,
        missingCount: rows.filter(row => row.status === 'missing-record').length,
        skippedSelfChildCount: rows.filter(row => row.status === 'skipped-self-child').length
      }
    });
  } catch (err) {
    console.error('Error applying batch child add:', err);
    res.status(500).json({ error: err.toString() });
  }
});

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

// Delete selected duplicates. Legacy endpoint, now with relationship/curation cleanup.
app.delete('/api/reference/delete-duplicates', async (req, res) => {
  try {
      const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(id => String(id || '').trim()).filter(Boolean))];
      if (!ids.length) {
          return res.status(400).json({ message: 'Invalid request, no IDs provided.' });
      }

      const deletedIdSet = new Set(ids);
      const referenceCollection = db.collection('reference');
      const curationCollection = db.collection('curation');

      await referenceCollection.updateMany(
          { id: { $nin: ids } },
          { $pull: { parentId: { $in: ids }, children: { $in: ids } } }
      );

      const affectedCurations = await curationCollection.find({
          $or: [
              { 'includedNodes.id': { $in: ids } },
              { 'curationConnections.source': { $in: ids } },
              { 'curationConnections.target': { $in: ids } },
              { 'customConnections.source': { $in: ids } },
              { 'customConnections.target': { $in: ids } }
          ]
      }).toArray();

      let cleanedCurationCount = 0;
      for (const curation of affectedCurations) {
          if (!curationContainsAnyDeletedId(curation, deletedIdSet)) continue;
          const cleaned = cleanCurationAfterRecordDeletion(curation, deletedIdSet);
          await curationCollection.updateOne(
              { _id: curation._id },
              { $set: { ...cleaned, updatedAt: new Date().toISOString() } }
          );
          cleanedCurationCount += 1;
      }

      const result = await referenceCollection.deleteMany({ id: { $in: ids } });
      if (result.deletedCount === 0) {
          return res.status(404).json({ message: 'No matching records found to delete.' });
      }

      res.json({
          success: true,
          message: `${result.deletedCount} records deleted; cleaned ${cleanedCurationCount} saved curation${cleanedCurationCount === 1 ? '' : 's'}.`
      });
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
          keys: ['info.label', 'info.label_jp', 'id'],
          threshold: 0.3,
          ignoreLocation: true,
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


const CSV_IMPORT_MAX_ROWS = 500;

function normaliseImportResolutionEntries(entries = []) {
  if (!Array.isArray(entries)) return new Map();
  const map = new Map();
  entries.forEach(entry => {
    const label = String(entry?.label || '').trim();
    const resolution = String(entry?.resolution || '').trim();
    if (label && !map.has(label)) map.set(label, resolution);
  });
  return map;
}

function validateImportRelationshipReview(row, labelsField, resolutionsField, kind) {
  const labels = [...new Set(
    (Array.isArray(row?.[labelsField]) ? row[labelsField] : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )];
  const resolutions = normaliseImportResolutionEntries(row?.[resolutionsField]);

  for (const label of labels) {
    const resolution = String(resolutions.get(label) || '').trim();
    if (!resolution) {
      return `${kind} relationship “${label}” is unresolved for ${row.candidateKey}.`;
    }
    if (resolution === 'none') continue;
    if (resolution.startsWith('existing:') && resolution.slice('existing:'.length).trim()) continue;
    if (resolution.startsWith('batch:') && resolution.slice('batch:'.length).trim()) continue;
    return `${kind} relationship “${label}” has an invalid resolution for ${row.candidateKey}.`;
  }

  return '';
}

// CSV import review preview. No writes are performed here.
app.post('/api/reference/import-review/preview', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      return res.status(400).json({ message: 'rows array is required.' });
    }
    if (rows.length > CSV_IMPORT_MAX_ROWS) {
      return res.status(413).json({
        message: `CSV import accepts at most ${CSV_IMPORT_MAX_ROWS} rows per batch; received ${rows.length}. Split the CSV into smaller batches.`
      });
    }

    const collection = db.collection('reference');
    const documents = await collection.find({}).toArray();
    const fuse = buildReferenceImportFuse(documents);
    const existingIds = new Set(documents.map(document => document.id).filter(Boolean));
    const typeColorDefaults = buildImportTypeColorDefaults(documents);

    const previewRows = rows.map(row => {
      const originalInfo = normaliseInfo(row.info || {});
      const info = applyImportTypeDefaultColor(originalInfo, typeColorDefaults);
      const labelQueries = [info.label, info.label_jp].filter(Boolean);
      const duplicateCandidates = searchImportCandidates(fuse, labelQueries, 5);
      const parentLabels = Array.isArray(row.parentLabels) ? row.parentLabels.map(String).map(value => value.trim()).filter(Boolean) : [];
      const childLabels = Array.isArray(row.childLabels) ? row.childLabels.map(String).map(value => value.trim()).filter(Boolean) : [];
      const parentMatches = {};
      const childMatches = {};

      parentLabels.forEach(parentLabel => {
        parentMatches[parentLabel] = searchImportCandidates(fuse, [parentLabel], 5);
      });

      childLabels.forEach(childLabel => {
        childMatches[childLabel] = searchImportCandidates(fuse, [childLabel], 5);
      });

      const parentIds = normaliseRelationshipArray(row.parentIds);
      const childIds = normaliseRelationshipArray(row.childIds || row.children);

      return {
        candidateKey: row.candidateKey,
        rowNumber: row.rowNumber,
        duplicateCandidates,
        parentMatches,
        childMatches,
        autoColor: !hasMeaningfulImportValue(originalInfo.color) && hasMeaningfulImportValue(info.color) ? info.color : '',
        validExplicitParentIds: parentIds.filter(id => existingIds.has(id)),
        missingExplicitParentIds: parentIds.filter(id => !existingIds.has(id)),
        validExplicitChildIds: childIds.filter(id => existingIds.has(id)),
        missingExplicitChildIds: childIds.filter(id => !existingIds.has(id))
      };
    });

    res.json({ rows: previewRows, total: previewRows.length });
  } catch (err) {
    console.error('Error previewing CSV import:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Commit reviewed CSV candidates. Duplicate choices are explicit; fuzzy matches are never auto-merged.
app.post('/api/reference/import-review/commit', async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      return res.status(400).json({ message: 'rows array is required.' });
    }
    if (rows.length > CSV_IMPORT_MAX_ROWS) {
      return res.status(413).json({
        message: `CSV import accepts at most ${CSV_IMPORT_MAX_ROWS} rows per batch; received ${rows.length}. Split the CSV into smaller batches.`
      });
    }

    const collection = db.collection('reference');
    const typeColorDocuments = await collection.find(
      { 'info.type': { $exists: true }, 'info.color': { $exists: true } },
      { projection: { 'info.type': 1, 'info.color': 1 } }
    ).toArray();
    const typeColorDefaults = buildImportTypeColorDefaults(typeColorDocuments);
    const allowedDecisions = new Set(['create', 'merge', 'skip']);
    const candidateKeys = new Set();

    for (const row of rows) {
      if (!row?.candidateKey || candidateKeys.has(row.candidateKey)) {
        return res.status(400).json({ message: 'Every row needs a unique candidateKey.' });
      }
      candidateKeys.add(row.candidateKey);
      if (!allowedDecisions.has(row.decision)) {
        return res.status(400).json({ message: `Unresolved or invalid decision for ${row.candidateKey}.` });
      }
      if (row.decision === 'merge' && !row.mergeTargetId) {
        return res.status(400).json({ message: `Merge target is required for ${row.candidateKey}.` });
      }

      if (row.decision !== 'skip') {
        const parentReviewError = validateImportRelationshipReview(row, 'parentLabels', 'parentResolutions', 'Parent');
        if (parentReviewError) return res.status(400).json({ message: parentReviewError });
        const childReviewError = validateImportRelationshipReview(row, 'childLabels', 'childResolutions', 'Child');
        if (childReviewError) return res.status(400).json({ message: childReviewError });
      }
    }

    // Validate reviewed relationship targets before any write occurs.
    const acceptedCandidateKeys = new Set(rows.filter(row => row.decision !== 'skip').map(row => row.candidateKey));
    const reviewedExistingIds = new Set();
    for (const row of rows.filter(item => item.decision !== 'skip')) {
      const resolutionEntries = [
        ...(Array.isArray(row.parentResolutions) ? row.parentResolutions : []),
        ...(Array.isArray(row.childResolutions) ? row.childResolutions : [])
      ];
      for (const entry of resolutionEntries) {
        const resolution = String(entry?.resolution || '').trim();
        if (resolution.startsWith('existing:')) {
          reviewedExistingIds.add(resolution.slice('existing:'.length).trim());
        }
        if (resolution.startsWith('batch:')) {
          const targetKey = resolution.slice('batch:'.length).trim();
          if (!acceptedCandidateKeys.has(targetKey)) {
            return res.status(400).json({
              message: `Reviewed relationship target ${targetKey} is missing or skipped; resolve it again before committing.`
            });
          }
        }
      }
    }

    if (reviewedExistingIds.size) {
      const reviewedExistingRecords = await collection.find(
        { id: { $in: [...reviewedExistingIds] } },
        { projection: { id: 1 } }
      ).toArray();
      const foundReviewedIds = new Set(reviewedExistingRecords.map(record => record.id));
      const missingReviewedId = [...reviewedExistingIds].find(id => !foundReviewedIds.has(id));
      if (missingReviewedId) {
        return res.status(400).json({ message: `Reviewed relationship target not found: ${missingReviewedId}` });
      }
    }

    const mergeTargetIds = [...new Set(rows.filter(row => row.decision === 'merge').map(row => String(row.mergeTargetId).trim()).filter(Boolean))];
    const mergeTargets = mergeTargetIds.length
      ? await collection.find({ id: { $in: mergeTargetIds } }).toArray()
      : [];
    const mergeTargetMap = new Map(mergeTargets.map(record => [record.id, record]));
    const missingMergeTarget = mergeTargetIds.find(id => !mergeTargetMap.has(id));
    if (missingMergeTarget) {
      return res.status(400).json({ message: `Merge target not found: ${missingMergeTarget}` });
    }

    const resultByKey = new Map();
    const importedAt = new Date().toISOString();
    let created = 0;
    let merged = 0;
    let skipped = 0;

    // First pass: create/merge records so every accepted row has a durable UUID.
    for (const row of rows) {
      if (row.decision === 'skip') {
        resultByKey.set(row.candidateKey, { status: 'skipped', id: null });
        skipped += 1;
        continue;
      }

      const incomingInfo = applyImportTypeDefaultColor(row.info || {}, typeColorDefaults);

      if (row.decision === 'create') {
        const id = uuidv4();
        await collection.insertOne({
          id,
          info: incomingInfo,
          parentId: [],
          children: [],
          createdAt: importedAt
        });
        resultByKey.set(row.candidateKey, { status: 'created', id });
        created += 1;
        continue;
      }

      const target = mergeTargetMap.get(String(row.mergeTargetId).trim());
      const mergedInfo = applyImportTypeDefaultColor(mergeImportedInfo(target.info || {}, incomingInfo), typeColorDefaults);
      await collection.updateOne(
        { id: target.id },
        { $set: { info: mergedInfo } }
      );
      // Keep the in-memory target current so multiple CSV rows merged into the
      // same existing record accumulate rather than overwriting one another.
      target.info = mergedInfo;
      mergeTargetMap.set(target.id, target);
      resultByKey.set(row.candidateKey, { status: 'merged', id: target.id });
      merged += 1;
    }

    // Validate explicit relationship IDs against the post-create database.
    const explicitRelationshipIds = [...new Set(rows.flatMap(row => [
      ...normaliseRelationshipArray(row.parentIds),
      ...normaliseRelationshipArray(row.childIds || row.children)
    ]))];
    const explicitExistingRecords = explicitRelationshipIds.length
      ? await collection.find({ id: { $in: explicitRelationshipIds } }, { projection: { id: 1 } }).toArray()
      : [];
    const explicitExistingIds = new Set(explicitExistingRecords.map(record => record.id));

    // Second pass: resolve relationships after new UUIDs exist.
    for (const row of rows) {
      const result = resultByKey.get(row.candidateKey);
      if (!result?.id) continue;

      const parentIds = new Set(
        normaliseRelationshipArray(row.parentIds).filter(id => explicitExistingIds.has(id))
      );

      const batchParentKeys = Array.isArray(row.batchParentKeys) ? row.batchParentKeys : [];
      batchParentKeys.forEach(parentKey => {
        const parentResult = resultByKey.get(parentKey);
        if (parentResult?.id && parentResult.id !== result.id) parentIds.add(parentResult.id);
      });

      if (parentIds.size) {
        const parentIdList = [...parentIds].filter(id => id !== result.id);
        if (parentIdList.length) {
          await collection.updateOne(
            { id: result.id },
            { $addToSet: { parentId: { $each: parentIdList } } }
          );
          await collection.updateMany(
            { id: { $in: parentIdList } },
            { $addToSet: { children: result.id } }
          );
        }
      }

      const childIds = new Set(
        normaliseRelationshipArray(row.childIds || row.children)
          .filter(id => explicitExistingIds.has(id) && id !== result.id)
      );

      const batchChildKeys = Array.isArray(row.batchChildKeys) ? row.batchChildKeys : [];
      batchChildKeys.forEach(childKey => {
        const childResult = resultByKey.get(childKey);
        if (childResult?.id && childResult.id !== result.id) childIds.add(childResult.id);
      });

      const childIdList = [...childIds].filter(id => id !== result.id);
      if (childIdList.length) {
        await collection.updateOne(
          { id: result.id },
          { $addToSet: { children: { $each: childIdList } } }
        );
        await collection.updateMany(
          { id: { $in: childIdList } },
          { $addToSet: { parentId: result.id } }
        );
      }
    }

    res.json({
      success: true,
      summary: { created, merged, skipped },
      rows: rows.map(row => ({ candidateKey: row.candidateKey, ...resultByKey.get(row.candidateKey) }))
    });
  } catch (err) {
    console.error('Error committing CSV import:', err);
    res.status(500).json({ error: err.toString() });
  }
});


// Create an unarranged saved curation from canonical reference records.
// The modifier app only creates the selection shell; visual positions remain the
// responsibility of the vis app.
app.post('/api/curations/from-records', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    const source = String(req.body?.source || 'modifier').trim();
    const recordIds = [...new Set(
      (Array.isArray(req.body?.recordIds) ? req.body.recordIds : [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    )];

    if (!name) {
      return res.status(400).json({ message: 'Curation name is required.' });
    }
    if (!recordIds.length) {
      return res.status(400).json({ message: 'At least one reference record id is required.' });
    }

    const referenceCollection = db.collection('reference');
    const curationCollection = db.collection('curation');

    const duplicate = await curationCollection.findOne({
      name: { $regex: `^${escapeRegExp(name)}$`, $options: 'i' }
    });
    if (duplicate) {
      return res.status(409).json({
        message: 'A saved curation with this name already exists.',
        curationId: duplicate.curationId || String(duplicate._id || '')
      });
    }

    const records = await referenceCollection.find(
      { id: { $in: recordIds } },
      { projection: { id: 1, parentId: 1, children: 1, 'info.color': 1 } }
    ).toArray();
    const foundIds = new Set(records.map(record => record.id).filter(Boolean));
    const missingRecordIds = recordIds.filter(id => !foundIds.has(id));
    const recordById = new Map(records.map(record => [record.id, record]));

    const includedNodes = recordIds
      .filter(id => foundIds.has(id))
      .map(id => {
        const record = recordById.get(id) || {};
        const color = String(record?.info?.color || '').trim();
        return color
          ? { id, position: {}, color }
          : { id, position: {} };
      });

    if (!includedNodes.length) {
      return res.status(400).json({ message: 'None of the supplied record ids exist in the reference database.' });
    }

    const includedIds = includedNodes.map(node => node.id).filter(Boolean);
    const { databaseConnections, curationConnections } = await buildCurationConnectionSnapshot(
      referenceCollection,
      includedIds
    );

    const now = new Date().toISOString();
    const curation = {
      curationId: uuidv4(),
      name,
      description,
      includedNodes,
      customConnections: [],
      curationConnections,
      curationSubtypes: [],
      visualSettings: {
        linkColour: '#999999',
        linkStrokeWidth: 3
      },
      importedCurationSources: [],
      sourceMeta: {
        createdBy: 'modifier-app',
        source,
        recordCount: includedNodes.length,
        missingRecordIds
      },
      createdAt: now,
      updatedAt: now
    };

    await curationCollection.insertOne(curation);

    res.status(201).json({
      success: true,
      curationId: curation.curationId,
      name: curation.name,
      includedCount: includedNodes.length,
      connectionCount: curationConnections.length,
      databaseConnectionCount: databaseConnections.length,
      missingRecordIds
    });
  } catch (err) {
    console.error('Error creating curation from records:', err);
    res.status(500).json({ error: err.toString() });
  }
});


// Rebuild saved curation connection overlay from canonical reference relationships.
// This repairs modifier-created curations whose includedNodes were correct but
// whose curationConnections were empty.
app.post('/api/curations/:curationId/rebuild-connections', async (req, res) => {
  try {
    const curationId = String(req.params.curationId || '').trim();
    if (!curationId) {
      return res.status(400).json({ message: 'curationId is required.' });
    }

    const referenceCollection = db.collection('reference');
    const curationCollection = db.collection('curation');
    const curation = await curationCollection.findOne({ curationId });

    if (!curation) {
      return res.status(404).json({ message: 'Saved curation not found.' });
    }

    const includedIds = (Array.isArray(curation.includedNodes) ? curation.includedNodes : [])
      .map(normaliseCurationNodeId)
      .filter(Boolean);

    const { databaseConnections, customConnections, curationConnections } = await buildCurationConnectionSnapshot(
      referenceCollection,
      includedIds,
      curation
    );

    const now = new Date().toISOString();
    await curationCollection.updateOne(
      { curationId },
      {
        $set: {
          curationConnections,
          customConnections,
          updatedAt: now,
          'sourceMeta.lastConnectionRebuildAt': now,
          'sourceMeta.lastConnectionRebuildDatabaseCount': databaseConnections.length,
          'sourceMeta.lastConnectionRebuildCustomCount': customConnections.length
        }
      }
    );

    res.json({
      success: true,
      curationId,
      includedCount: includedIds.length,
      databaseConnectionCount: databaseConnections.length,
      customConnectionCount: customConnections.length,
      curationConnectionCount: curationConnections.length,
      message: `Rebuilt ${databaseConnections.length} database connection${databaseConnections.length === 1 ? '' : 's'} for “${curation.name || curationId}”.`
    });
  } catch (err) {
    console.error('Error rebuilding curation connections:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Preview delete impact before removing canonical records.
app.post('/api/reference/delete-impact', async (req, res) => {
  try {
    const ids = [...new Set(
      (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    )];

    if (!ids.length) {
      return res.status(400).json({ message: 'At least one record id is required.' });
    }

    const deletedIdSet = new Set(ids);
    const referenceCollection = db.collection('reference');
    const curationCollection = db.collection('curation');

    const records = await referenceCollection.find({ id: { $in: ids } }).toArray();
    const foundIdSet = new Set(records.map(record => record.id).filter(Boolean));
    const missingIds = ids.filter(id => !foundIdSet.has(id));

    const relationshipReferences = await referenceCollection.find({
      id: { $nin: ids },
      $or: [
        { parentId: { $in: ids } },
        { children: { $in: ids } }
      ]
    }).toArray();

    const affectedCurations = await curationCollection.find({
      $or: [
        { 'includedNodes.id': { $in: ids } },
        { 'curationConnections.source': { $in: ids } },
        { 'curationConnections.target': { $in: ids } },
        { 'customConnections.source': { $in: ids } },
        { 'customConnections.target': { $in: ids } }
      ]
    }).toArray();

    const curationSummaries = affectedCurations
      .filter(curation => curationContainsAnyDeletedId(curation, deletedIdSet))
      .map(curation => ({
        curationId: curation.curationId || String(curation._id || ''),
        name: curation.name || curation.title || curation.curationId || String(curation._id || ''),
        includedNodeHits: (Array.isArray(curation.includedNodes) ? curation.includedNodes : [])
          .filter(node => deletedIdSet.has(normaliseCurationNodeId(node))).length,
        connectionHits: [
          ...(Array.isArray(curation.curationConnections) ? curation.curationConnections : []),
          ...(Array.isArray(curation.customConnections) ? curation.customConnections : [])
        ].filter(connection => deletedIdSet.has(String(connection?.source || '').trim()) || deletedIdSet.has(String(connection?.target || '').trim())).length
      }));

    res.json({
      success: true,
      requestedIds: ids,
      records: records.map(summariseDeleteImpactRecord),
      missingIds,
      relationshipReferences: relationshipReferences.map(document => ({
        ...summariseDeleteImpactRecord(document),
        parentHits: normaliseRelationshipArray(document.parentId).filter(id => deletedIdSet.has(id)),
        childHits: normaliseRelationshipArray(document.children).filter(id => deletedIdSet.has(id))
      })),
      curations: curationSummaries,
      summary: {
        requestedCount: ids.length,
        foundCount: records.length,
        missingCount: missingIds.length,
        relationshipReferenceCount: relationshipReferences.length,
        affectedCurationCount: curationSummaries.length
      }
    });
  } catch (err) {
    console.error('Error previewing delete impact:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Reviewed delete that can clean relationships and saved curation overlays.
app.post('/api/reference/delete-reviewed', async (req, res) => {
  try {
    const ids = [...new Set(
      (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map(id => String(id || '').trim())
        .filter(Boolean)
    )];
    const cleanupRelationships = req.body?.cleanupRelationships !== false;
    const cleanupCurations = req.body?.cleanupCurations !== false;

    if (!ids.length) {
      return res.status(400).json({ message: 'At least one record id is required.' });
    }

    const deletedIdSet = new Set(ids);
    const referenceCollection = db.collection('reference');
    const curationCollection = db.collection('curation');

    const records = await referenceCollection.find({ id: { $in: ids } }).toArray();
    if (!records.length) {
      return res.status(404).json({ message: 'No matching records found to delete.' });
    }

    let relationshipCleanup = { matchedCount: 0, modifiedCount: 0 };
    if (cleanupRelationships) {
      relationshipCleanup = await referenceCollection.updateMany(
        { id: { $nin: ids } },
        {
          $pull: {
            parentId: { $in: ids },
            children: { $in: ids }
          }
        }
      );
    }

    let cleanedCurations = [];
    if (cleanupCurations) {
      const affectedCurations = await curationCollection.find({
        $or: [
          { 'includedNodes.id': { $in: ids } },
          { 'curationConnections.source': { $in: ids } },
          { 'curationConnections.target': { $in: ids } },
          { 'customConnections.source': { $in: ids } },
          { 'customConnections.target': { $in: ids } }
        ]
      }).toArray();

      for (const curation of affectedCurations) {
        if (!curationContainsAnyDeletedId(curation, deletedIdSet)) continue;
        const cleaned = cleanCurationAfterRecordDeletion(curation, deletedIdSet);
        await curationCollection.updateOne(
          { _id: curation._id },
          {
            $set: {
              ...cleaned,
              updatedAt: new Date().toISOString()
            }
          }
        );
        cleanedCurations.push({
          curationId: curation.curationId || String(curation._id || ''),
          name: curation.name || curation.title || curation.curationId || String(curation._id || ''),
          includedCount: cleaned.includedNodes.length,
          connectionCount: cleaned.curationConnections.length
        });
      }
    }

    const deleteResult = await referenceCollection.deleteMany({ id: { $in: ids } });

    res.json({
      success: true,
      deletedCount: deleteResult.deletedCount,
      deletedRecords: records.map(summariseDeleteImpactRecord),
      relationshipCleanup: {
        matchedCount: relationshipCleanup.matchedCount || 0,
        modifiedCount: relationshipCleanup.modifiedCount || 0
      },
      cleanedCurations,
      message: `Deleted ${deleteResult.deletedCount} record${deleteResult.deletedCount === 1 ? '' : 's'}${cleanupCurations ? `; cleaned ${cleanedCurations.length} saved curation${cleanedCurations.length === 1 ? '' : 's'}` : ''}.`
    });
  } catch (err) {
    console.error('Error applying reviewed delete:', err);
    res.status(500).json({ error: err.toString() });
  }
});

// Update an existing record. Parent/child arrays are optional root-level edits.
// When syncRelationships is true, reciprocal links are also added/removed.
app.put('/api/reference/update/:id', async (req, res) => {
  try {
      const id = req.params.id;
      const updatedInfo = req.body.info;
      const collection = db.collection('reference');
      const syncRelationships = req.body.syncRelationships === true;

      if (!updatedInfo || typeof updatedInfo !== 'object' || Array.isArray(updatedInfo)) {
          return res.status(400).json({ message: 'Invalid request: info object is required.' });
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'parentId') && !Array.isArray(req.body.parentId)) {
          return res.status(400).json({ message: 'Invalid request: parentId must be an array.' });
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'children') && !Array.isArray(req.body.children)) {
          return res.status(400).json({ message: 'Invalid request: children must be an array.' });
      }

      const existingRecord = await collection.findOne({ id });

      if (!existingRecord) {
          return res.status(404).json({ message: 'Record not found.' });
      }

      const mergedInfo = normaliseInfo({
          ...(existingRecord.info || {}),
          ...updatedInfo
      });

      const beforeRelationships = {
          parentId: uniqueRelationshipArray(existingRecord.parentId),
          children: uniqueRelationshipArray(existingRecord.children)
      };

      const setFields = { info: mergedInfo };

      if (Object.prototype.hasOwnProperty.call(req.body, 'parentId')) {
          setFields.parentId = uniqueRelationshipArray(req.body.parentId);
      }

      if (Object.prototype.hasOwnProperty.call(req.body, 'children')) {
          setFields.children = uniqueRelationshipArray(req.body.children);
      }

      const afterRelationships = {
          parentId: Object.prototype.hasOwnProperty.call(setFields, 'parentId') ? setFields.parentId : beforeRelationships.parentId,
          children: Object.prototype.hasOwnProperty.call(setFields, 'children') ? setFields.children : beforeRelationships.children
      };

      if (afterRelationships.parentId.includes(id) || afterRelationships.children.includes(id)) {
          return res.status(400).json({ message: 'A record cannot be its own parent or child.' });
      }

      const missingRelationshipTargets = await findMissingRelationshipTargets(
          collection,
          [...afterRelationships.parentId, ...afterRelationships.children]
      );

      if (missingRelationshipTargets.length) {
          return res.status(400).json({
              message: `Relationship target ID${missingRelationshipTargets.length === 1 ? '' : 's'} not found: ${missingRelationshipTargets.join(', ')}`,
              missingRelationshipTargets
          });
      }

      const relationshipDiff = summariseRelationshipSync({
          addedParentIds: getArrayDiff(beforeRelationships.parentId, afterRelationships.parentId).added,
          removedParentIds: getArrayDiff(beforeRelationships.parentId, afterRelationships.parentId).removed,
          addedChildIds: getArrayDiff(beforeRelationships.children, afterRelationships.children).added,
          removedChildIds: getArrayDiff(beforeRelationships.children, afterRelationships.children).removed
      });

      const result = await collection.updateOne({ id }, { $set: setFields });

      let reciprocalSync = summariseRelationshipSync();
      if (syncRelationships && relationshipDiff.changedCount) {
          reciprocalSync = await applyReciprocalRelationshipChanges(
              collection,
              id,
              beforeRelationships,
              afterRelationships
          );
      }

      if (result.matchedCount === 1) {
          const updatedRecord = await collection.findOne({ id });
          const documents = await collection.find({}).toArray();
          const documentsById = new Map(documents.map(document => [document.id, document]).filter(([recordId]) => recordId));
          res.json({
              message: result.modifiedCount === 1 ? 'Record updated successfully.' : 'Record found; no changes were needed.',
              record: summariseBatchReferenceRecord(updatedRecord, documentsById),
              relationshipDiff,
              reciprocalSyncApplied: syncRelationships,
              reciprocalSync
          });
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


// Endpoint to add a new record. Parent/child IDs are validated.
// By default, reciprocal links are added to the related records.
app.post('/api/reference/new', async (req, res) => {
  const session = client.startSession();
  
  try {
      const newRecord = { ...(req.body || {}) };
      const collection = db.collection('reference');
      const syncRelationships = newRecord.syncRelationships !== false;
      delete newRecord.syncRelationships;

      newRecord.parentId = uniqueRelationshipArray(newRecord.parentId);
      newRecord.children = uniqueRelationshipArray(newRecord.children);
      newRecord.info = normaliseInfo(newRecord.info || {});

      const sourceMeta = normaliseSourceMeta(newRecord.sourceMeta);
      if (sourceMeta) {
          newRecord.sourceMeta = sourceMeta;
      } else {
          delete newRecord.sourceMeta;
      }
      
      // Start a transaction
      session.startTransaction();
      
      const missingRelationshipTargets = await findMissingRelationshipTargets(
          collection,
          [...newRecord.parentId, ...newRecord.children]
      );

      if (missingRelationshipTargets.length) {
          throw new Error(`Relationship target ID${missingRelationshipTargets.length === 1 ? '' : 's'} not found: ${missingRelationshipTargets.join(', ')}`);
      }

      // Generate a new UUID for the record
      const recordId = uuidv4();
      newRecord.id = recordId;

      if (newRecord.parentId.includes(recordId) || newRecord.children.includes(recordId)) {
          throw new Error('A record cannot be its own parent or child.');
      }

      // Insert the new record
      const result = await collection.insertOne(newRecord);

      if (result.acknowledged) {
          let reciprocalSync = summariseRelationshipSync();
          if (syncRelationships) {
              reciprocalSync = await applyReciprocalRelationshipChanges(
                  collection,
                  recordId,
                  { parentId: [], children: [] },
                  { parentId: newRecord.parentId, children: newRecord.children }
              );
          }

          await session.commitTransaction();
          res.json({
              message: 'Record added successfully.',
              id: newRecord.id,
              reciprocalSyncApplied: syncRelationships,
              reciprocalSync
          });
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
