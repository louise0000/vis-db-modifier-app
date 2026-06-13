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
