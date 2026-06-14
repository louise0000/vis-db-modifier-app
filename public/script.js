// Define the baseURL at the top of your script or before it's used
const baseURL = `${window.location.protocol}//${window.location.host}`;

// Root relationship fields belong at the document root, not inside info.
// Keeping this explicit helps avoid accidental schema drift during manual edits/imports.
const ROOT_RELATIONSHIP_FIELDS = new Set(['parentId', 'children']);
const MULTILINE_INFO_FIELDS = new Set(['note', 'note_jp', 'article']);

function ensureJapaneseNoteField(info = {}) {
    const nextInfo = { ...info };
    if (!Object.prototype.hasOwnProperty.call(nextInfo, 'note_jp')) {
        nextInfo.note_jp = '';
    }
    return nextInfo;
}

function getInfoEntriesWithJapaneseNote(info = {}) {
    const nextInfo = ensureJapaneseNoteField(info);
    const entries = Object.entries(nextInfo).filter(([key]) => {
        return key !== '_id' && key !== 'id' && !ROOT_RELATIONSHIP_FIELDS.has(key);
    });

    const noteIndex = entries.findIndex(([key]) => key === 'note');
    const noteJpIndex = entries.findIndex(([key]) => key === 'note_jp');

    // Keep note_jp beside note when the source/template did not already place it there.
    if (noteIndex !== -1 && noteJpIndex !== -1 && noteJpIndex !== noteIndex + 1) {
        const [noteJpEntry] = entries.splice(noteJpIndex, 1);
        entries.splice(noteIndex + 1, 0, noteJpEntry);
    }

    return entries;
}

function formatValueForEditor(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
}

function parseRootArrayField(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function parseEditedInfoValue(value, originalValue) {
    const rawValue = String(value ?? '');

    if (Array.isArray(originalValue)) {
        return parseRootArrayField(rawValue);
    }

    if (typeof originalValue === 'number') {
        const numericValue = Number(rawValue);
        return Number.isNaN(numericValue) ? rawValue : numericValue;
    }

    if (typeof originalValue === 'boolean') {
        return rawValue === 'true';
    }

    if (originalValue && typeof originalValue === 'object') {
        try {
            return JSON.parse(rawValue);
        } catch (error) {
            console.warn('Keeping edited object-like field as text because JSON parsing failed.');
            return rawValue;
        }
    }

    return rawValue;
}

function appendFormField(container, key, value) {
    const label = document.createElement('label');
    label.textContent = key.charAt(0).toUpperCase() + key.slice(1) + ':';

    const input = MULTILINE_INFO_FIELDS.has(key)
        ? document.createElement('textarea')
        : document.createElement('input');

    if (input.tagName === 'INPUT') {
        input.type = 'text';
    }

    input.name = key;
    input.value = formatValueForEditor(value);

    container.appendChild(label);
    container.appendChild(input);
    container.appendChild(document.createElement('br'));
}


// Draft-record bridge for future capture/import workflows.
// Incoming data can prefill the existing Add Single Record form for human review.
// If the user saves the draft, source metadata is preserved at root-level sourceMeta,
// not mixed into info.
const testDraftRecord = {
    proposedType: 'artworkBook',
    proposedInfo: {
        label: 'Test Imported Book',
        type: 'artworkBook',
        date: '2026',
        article: '',
        note: 'Imported draft note',
        note_jp: ''
    },
    sourceMeta: {
        source: 'manual-test',
        capturedAt: new Date().toISOString(),
        raw: {
            publisher: 'Imaginary Press',
            isbn: '000-0-00-000000-0',
            pages: '321',
            url: 'https://example.com/test-book'
        }
    },
    duplicateWarnings: []
};

const draftExampleRecords = {
    book: testDraftRecord,
    'wikipedia-person': {
        proposedType: 'theorist',
        proposedInfo: {
            label: 'Test Wikipedia Person',
            type: 'theorist',
            birth: '1901',
            death: '1999',
            note: 'Imported person draft note from a Wikipedia/Wikidata-style source.',
            note_jp: ''
        },
        sourceMeta: {
            source: 'wikipedia-person-test',
            capturedAt: new Date().toISOString(),
            raw: {
                title: 'Test Wikipedia Person',
                wikidataQID: 'Q000000',
                wikipediaUrl: 'https://en.wikipedia.org/wiki/Test_Wikipedia_Person',
                description: 'Example biography page used to test person capture.',
                birth: '1901',
                death: '1999',
                imgURL: 'https://example.com/test-person.jpg'
            }
        },
        duplicateWarnings: []
    }
};

function getDraftExampleRecord(exampleKey = 'book') {
    return draftExampleRecords[exampleKey] || draftExampleRecords.book;
}

function getSelectedDraftExampleKey() {
    const selector = document.getElementById('draft-example-select');
    return selector?.value || 'book';
}

function getExampleDraftJsonText(exampleKey = 'book') {
    return JSON.stringify(getDraftExampleRecord(exampleKey), null, 2);
}

function normalisePastedDraftRecord(parsedDraft) {
    if (!parsedDraft || typeof parsedDraft !== 'object' || Array.isArray(parsedDraft)) {
        throw new Error('Draft JSON must be an object.');
    }

    const proposedInfo = parsedDraft.proposedInfo || parsedDraft.info || {};
    const proposedType = parsedDraft.proposedType || proposedInfo.type || parsedDraft.type;

    if (!proposedType) {
        throw new Error('Draft JSON needs proposedType, proposedInfo.type, or info.type.');
    }

    if (!proposedInfo.label && !parsedDraft.sourceMeta?.raw?.title && !parsedDraft.raw?.title) {
        throw new Error('Draft JSON needs proposedInfo.label, info.label, or sourceMeta.raw.title.');
    }

    const sourceMeta = parsedDraft.sourceMeta || {
        source: 'pasted-json',
        capturedAt: new Date().toISOString(),
        raw: parsedDraft.raw || {}
    };

    return {
        proposedType,
        proposedInfo: {
            ...proposedInfo,
            type: proposedType
        },
        proposedParentId: Array.isArray(parsedDraft.proposedParentId) ? parsedDraft.proposedParentId : [],
        proposedChildren: Array.isArray(parsedDraft.proposedChildren) ? parsedDraft.proposedChildren : [],
        sourceMeta,
        duplicateWarnings: Array.isArray(parsedDraft.duplicateWarnings) ? parsedDraft.duplicateWarnings : []
    };
}

async function loadDraftFromJsonInput() {
    const input = document.getElementById('draft-json-input');
    if (!input) return;

    const rawText = input.value.trim();
    if (!rawText) {
        alert('Paste draft JSON first.');
        return;
    }

    try {
        const parsed = JSON.parse(rawText);
        const draftRecord = normalisePastedDraftRecord(parsed);
        await loadDraftRecordIntoAddForm(draftRecord);
    } catch (error) {
        console.error('Error loading pasted draft JSON:', error);
        alert(`Could not load draft JSON: ${error.message}`);
    }
}

function setBrowserCaptureStatus(message, isError = false) {
    const status = document.getElementById('browser-capture-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('browser-capture-status-error', Boolean(isError));
}

async function loadLatestBrowserCapture() {
    try {
        setBrowserCaptureStatus('Checking latest browser capture...');
        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/draft-capture/latest`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || data.error || 'No browser capture available.');
        }

        const draftRecord = normalisePastedDraftRecord(data.draftRecord || data.draft || data);
        if (draftRecord.sourceMeta && !draftRecord.sourceMeta.capturedAt && data.receivedAt) {
            draftRecord.sourceMeta.capturedAt = data.receivedAt;
        }
        await loadDraftRecordIntoAddForm(draftRecord);
        setBrowserCaptureStatus(`Loaded browser capture received at ${data.receivedAt || 'unknown time'}.`);
    } catch (error) {
        console.error('Error loading latest browser capture:', error);
        setBrowserCaptureStatus(error.message, true);
        alert(`Could not load latest browser capture: ${error.message}`);
    }
}

let currentDraftRecord = null;
let currentDraftSourceFieldMapping = { mappedFields: {}, unmappedFields: {} };
let currentDraftDuplicateCandidates = [];
let currentDraftDuplicateReviewAcknowledged = false;


function clearDraftSourceMetadata() {
    currentDraftRecord = null;
    currentDraftSourceFieldMapping = { mappedFields: {}, unmappedFields: {} };
    currentDraftDuplicateCandidates = [];
    currentDraftDuplicateReviewAcknowledged = false;
    const panel = document.getElementById('draft-source-metadata');
    if (!panel) return;
    panel.innerHTML = '';
    panel.style.display = 'none';
}

function getSourceFieldMapping(draftRecord = {}, templateRecord = {}) {
    const rawFields = draftRecord.sourceMeta?.raw || {};
    const templateInfoKeys = new Set(Object.keys(templateRecord.info || {}));
    const proposedInfoKeys = new Set(Object.keys(draftRecord.proposedInfo || {}));
    const mappedFields = {};
    const unmappedFields = {};

    Object.entries(rawFields).forEach(([key, value]) => {
        if (templateInfoKeys.has(key) || proposedInfoKeys.has(key)) {
            mappedFields[key] = value;
        } else {
            unmappedFields[key] = value;
        }
    });

    return { mappedFields, unmappedFields };
}

function appendDraftMetadataList(panel, headingText, fields, className) {
    if (!Object.keys(fields).length) return;

    const heading = document.createElement('h5');
    heading.textContent = headingText;
    panel.appendChild(heading);

    const rawList = document.createElement('dl');
    rawList.classList.add('draft-source-raw-list', className);

    Object.entries(fields).forEach(([key, value]) => {
        const term = document.createElement('dt');
        term.textContent = key;
        const description = document.createElement('dd');
        description.textContent = formatValueForEditor(value);
        rawList.appendChild(term);
        rawList.appendChild(description);
    });

    panel.appendChild(rawList);
}

function objectHasDisplayableFields(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
}

function renderRootSourceMetaPanel(container, sourceMeta = {}) {
    if (!objectHasDisplayableFields(sourceMeta)) return;

    const panel = document.createElement('div');
    panel.classList.add('edit-source-metadata');

    const heading = document.createElement('h4');
    heading.textContent = 'Saved Source Metadata';
    panel.appendChild(heading);

    const help = document.createElement('p');
    help.classList.add('draft-source-help-text');
    help.textContent = 'Read-only provenance saved at the record root. These fields are not part of editable info, so ordinary edits will not overwrite them.';
    panel.appendChild(help);

    const summaryFields = {};
    ['source', 'capturedAt', 'acceptedAt', 'proposedType', 'note'].forEach(key => {
        if (sourceMeta[key]) summaryFields[key] = sourceMeta[key];
    });

    appendDraftMetadataList(panel, 'Source summary', summaryFields, 'draft-source-mapped-list');
    appendDraftMetadataList(panel, 'Mapped fields saved into info', sourceMeta.mappedFields || {}, 'draft-source-mapped-list');
    appendDraftMetadataList(panel, 'Unmapped fields preserved only in sourceMeta', sourceMeta.unmappedFields || {}, 'draft-source-unmapped-list');
    appendDraftMetadataList(panel, 'Raw captured data', sourceMeta.raw || {}, 'draft-source-raw-captured-list');

    container.appendChild(panel);
}

async function fetchFullRecordForEdit(recordSummary = {}) {
    const id = recordSummary.id || recordSummary.info?.id;
    if (!id) return recordSummary;

    try {
        const response = await fetch(`${baseURL}/api/reference/${encodeURIComponent(id)}`);
        const fullRecord = await response.json();
        if (!response.ok) throw new Error(fullRecord.error || 'Could not fetch full record.');
        return fullRecord;
    } catch (error) {
        console.warn('Using search-result summary because full edit record fetch failed:', error);
        return recordSummary;
    }
}


function getDraftProposedLabel(draftRecord = {}) {
    return (draftRecord.proposedInfo?.label || draftRecord.sourceMeta?.raw?.title || '').trim();
}

function getDraftProposedType(draftRecord = {}) {
    return (draftRecord.proposedType || draftRecord.proposedInfo?.type || '').trim();
}

function stripTrailingDisambiguation(label = '') {
    let cleanLabel = String(label || '').trim();
    let previous = '';

    // Wikipedia and IMDb often append disambiguation: Stuart Hall (cultural theorist).
    // For duplicate warnings, compare both the literal label and the plain base label.
    while (cleanLabel && cleanLabel !== previous) {
        previous = cleanLabel;
        cleanLabel = cleanLabel.replace(/\s*[(（][^()（）]+[)）]\s*$/u, '').trim();
    }

    return cleanLabel;
}

function normaliseDuplicateLabel(label = '') {
    const stripped = stripTrailingDisambiguation(label);

    return String(stripped || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[’'`]/g, '')
        .replace(/[-–—_:;,.!?/\\|"“”‘’]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function getDraftDuplicateSearchLabels(draftRecord = {}) {
    const raw = draftRecord.sourceMeta?.raw || {};
    const info = draftRecord.proposedInfo || {};
    const labels = [
        getDraftProposedLabel(draftRecord),
        info.label,
        info.label_jp,
        raw.title,
        raw.pageTitle,
        raw.displayTitle,
        raw.englishTitle,
        raw.originalTitle,
        raw.japaneseWikipediaTitle
    ];

    const expanded = [];
    labels.forEach(label => {
        if (!label) return;
        expanded.push(String(label).trim());
        const stripped = stripTrailingDisambiguation(label);
        if (stripped && stripped !== label) expanded.push(stripped);
    });

    return [...new Set(expanded.filter(Boolean))];
}

function formatDraftDuplicateCandidate(candidate = {}) {
    const info = candidate.info || {};
    const label = info.label || '(untitled)';
    const type = info.type ? ` [${info.type}]` : '';
    const date = info.date || info.birth || info.death
        ? ` (${[info.date, info.birth, info.death].filter(Boolean).join('–')})`
        : '';
    const id = candidate.id ? ` — ${candidate.id.slice(0, 8)}…${candidate.id.slice(-4)}` : '';
    return `${label}${date}${type}${id}`;
}

function isMeaningfulDraftDuplicate(candidate = {}, draftRecord = {}) {
    const info = candidate.info || {};
    const candidateType = (info.type || '').trim().toLowerCase();
    const draftType = getDraftProposedType(draftRecord).toLowerCase();
    const typeCompatible = !draftType || !candidateType || draftType === candidateType;

    const candidateLabels = [info.label, info.label_jp]
        .filter(Boolean)
        .map(normaliseDuplicateLabel)
        .filter(Boolean);
    const draftLabels = getDraftDuplicateSearchLabels(draftRecord)
        .map(normaliseDuplicateLabel)
        .filter(Boolean);

    if (!candidateLabels.length || !draftLabels.length) return false;

    // Exact normalised matches should warn even if the type is not identical; this
    // catches browser imports where a person may be manually retyped later.
    if (candidateLabels.some(candidateLabel => draftLabels.includes(candidateLabel))) {
        return true;
    }

    if (!typeCompatible) return false;

    // Keep partial matching conservative. This catches e.g. Wikipedia
    // disambiguation leftovers, but avoids turning every broad Fuse result into a
    // duplicate warning.
    return candidateLabels.some(candidateLabel => draftLabels.some(draftLabel => {
        if (candidateLabel.length < 5 || draftLabel.length < 5) return false;
        return candidateLabel.includes(draftLabel) || draftLabel.includes(candidateLabel);
    }));
}

function appendDraftDuplicatePreflight(panel, candidates = []) {
    const existing = panel.querySelector('.draft-duplicate-preflight');
    if (existing) existing.remove();

    const section = document.createElement('div');
    section.classList.add('draft-duplicate-preflight');

    const heading = document.createElement('h5');
    heading.textContent = 'Possible existing records';
    section.appendChild(heading);

    if (!candidates.length) {
        const message = document.createElement('p');
        message.classList.add('draft-source-help-text');
        message.textContent = 'No obvious existing record found for this draft label/type.';
        section.appendChild(message);
        panel.appendChild(section);
        return;
    }

    const help = document.createElement('p');
    help.classList.add('draft-source-help-text');
    help.textContent = 'Review these before saving. This does not block saving, but it warns you if the incoming draft may already exist.';
    section.appendChild(help);

    const list = document.createElement('ul');
    list.classList.add('draft-duplicate-list');
    candidates.forEach(candidate => {
        const item = document.createElement('li');
        item.textContent = formatDraftDuplicateCandidate(candidate);
        list.appendChild(item);
    });
    section.appendChild(list);

    const acknowledgementLabel = document.createElement('label');
    acknowledgementLabel.classList.add('draft-duplicate-acknowledgement');
    const acknowledgement = document.createElement('input');
    acknowledgement.type = 'checkbox';
    acknowledgement.checked = currentDraftDuplicateReviewAcknowledged;
    acknowledgement.addEventListener('change', () => {
        currentDraftDuplicateReviewAcknowledged = acknowledgement.checked;
    });
    acknowledgementLabel.appendChild(acknowledgement);
    acknowledgementLabel.appendChild(document.createTextNode(' I reviewed these possible duplicates.'));
    section.appendChild(acknowledgementLabel);

    panel.appendChild(section);
}

async function runDraftDuplicatePreflight(draftRecord = {}) {
    const panel = document.getElementById('draft-source-metadata');
    if (!panel) return [];

    const labels = getDraftDuplicateSearchLabels(draftRecord);
    currentDraftDuplicateCandidates = [];
    currentDraftDuplicateReviewAcknowledged = false;

    if (!labels.length) {
        appendDraftDuplicatePreflight(panel, []);
        return [];
    }

    try {
        const resultMap = new Map();

        for (const label of labels) {
            const response = await fetch(`${baseURL}/api/reference/label/all/${encodeURIComponent(label)}`);
            const results = await response.json();
            if (!response.ok) throw new Error(results.error || 'Duplicate preflight failed.');

            if (Array.isArray(results)) {
                results.forEach(candidate => {
                    const key = candidate.id || candidate.info?.id || candidate.info?.label;
                    if (key && !resultMap.has(key)) resultMap.set(key, candidate);
                });
            }
        }

        currentDraftDuplicateCandidates = [...resultMap.values()]
            .filter(candidate => isMeaningfulDraftDuplicate(candidate, draftRecord))
            .slice(0, 8);
        appendDraftDuplicatePreflight(panel, currentDraftDuplicateCandidates);
        return currentDraftDuplicateCandidates;
    } catch (error) {
        console.error('Error running draft duplicate preflight:', error);
        const section = document.createElement('div');
        section.classList.add('draft-duplicate-preflight');
        const heading = document.createElement('h5');
        heading.textContent = 'Possible existing records';
        const message = document.createElement('p');
        message.classList.add('draft-source-help-text');
        message.textContent = 'Duplicate preflight could not run. You can still review manually before saving.';
        section.appendChild(heading);
        section.appendChild(message);
        panel.appendChild(section);
        return [];
    }
}

function renderDraftSourceMetadata(draftRecord = {}, templateRecord = {}) {
    const panel = document.getElementById('draft-source-metadata');
    if (!panel) return;

    const sourceMeta = draftRecord.sourceMeta || {};
    const duplicateWarnings = Array.isArray(draftRecord.duplicateWarnings)
        ? draftRecord.duplicateWarnings
        : [];
    const { mappedFields, unmappedFields } = getSourceFieldMapping(draftRecord, templateRecord);
    const rawFields = sourceMeta.raw && typeof sourceMeta.raw === 'object' ? sourceMeta.raw : {};
    const hasSourceSummary = Boolean(sourceMeta.source || sourceMeta.capturedAt);
    const hasSourceMetadata = hasSourceSummary || Object.keys(rawFields).length > 0;

    // Keep the active draft available until submit so its provenance can be
    // attached to the new root-level record as sourceMeta.
    currentDraftRecord = draftRecord;
    currentDraftSourceFieldMapping = { mappedFields, unmappedFields };

    if (!Object.keys(mappedFields).length && !Object.keys(unmappedFields).length && !duplicateWarnings.length && !hasSourceMetadata) {
        clearDraftSourceMetadata();
        return;
    }

    panel.innerHTML = '';

    const heading = document.createElement('h4');
    heading.textContent = 'Imported Source Metadata';
    panel.appendChild(heading);

    const help = document.createElement('p');
    help.classList.add('draft-source-help-text');
    help.textContent = 'Mapped fields have been prefilled into the editable form. Unmapped fields are preserved as root-level sourceMeta if this draft is saved, but they are not mixed into info.';
    panel.appendChild(help);

    if (sourceMeta.source || sourceMeta.capturedAt) {
        const sourceSummary = document.createElement('p');
        sourceSummary.classList.add('draft-source-summary');
        sourceSummary.textContent = [sourceMeta.source, sourceMeta.capturedAt].filter(Boolean).join(' / ');
        panel.appendChild(sourceSummary);
    }

    appendDraftMetadataList(panel, 'Mapped into editable form', mappedFields, 'draft-source-mapped-list');
    appendDraftMetadataList(panel, 'Unmapped source fields', unmappedFields, 'draft-source-unmapped-list');

    if (duplicateWarnings.length) {
        const warningHeading = document.createElement('h5');
        warningHeading.textContent = 'Duplicate warnings';
        panel.appendChild(warningHeading);

        const warningList = document.createElement('ul');
        duplicateWarnings.forEach(warning => {
            const item = document.createElement('li');
            item.textContent = formatValueForEditor(warning);
            warningList.appendChild(item);
        });
        panel.appendChild(warningList);
    }

    panel.style.display = 'block';
}

function createDraftTemplateRecord(templateRecord = {}, draftRecord = {}) {
    const templateInfo = templateRecord.info || {};
    const proposedInfo = { ...(draftRecord.proposedInfo || {}) };
    const rawFields = draftRecord.sourceMeta?.raw || {};
    const proposedType = draftRecord.proposedType || proposedInfo.type || templateInfo.type || '';

    // If source metadata contains a field already known to this record type
    // (for example artworkBook.pages), treat it as mapped data and prefill it.
    // Unknown source fields stay read-only in Imported Source Metadata.
    Object.entries(rawFields).forEach(([key, value]) => {
        if (Object.prototype.hasOwnProperty.call(templateInfo, key) && proposedInfo[key] === undefined) {
            proposedInfo[key] = value;
        }
    });

    return {
        parentId: Array.isArray(draftRecord.proposedParentId) ? draftRecord.proposedParentId : [],
        children: Array.isArray(draftRecord.proposedChildren) ? draftRecord.proposedChildren : [],
        info: ensureJapaneseNoteField({
            ...templateInfo,
            ...proposedInfo,
            type: proposedType
        })
    };
}

function createPersistableDraftSourceMeta(draftRecord = {}, savedInfo = {}) {
    if (!draftRecord?.sourceMeta) return null;

    const sourceMeta = draftRecord.sourceMeta || {};
    const raw = sourceMeta.raw && typeof sourceMeta.raw === 'object' ? sourceMeta.raw : {};
    const hasRaw = Object.keys(raw).length > 0;
    const hasMapped = Object.keys(currentDraftSourceFieldMapping.mappedFields || {}).length > 0;
    const hasUnmapped = Object.keys(currentDraftSourceFieldMapping.unmappedFields || {}).length > 0;

    if (!sourceMeta.source && !sourceMeta.capturedAt && !hasRaw && !hasMapped && !hasUnmapped) {
        return null;
    }

    return {
        source: sourceMeta.source || 'unknown-draft-source',
        capturedAt: sourceMeta.capturedAt || '',
        acceptedAt: new Date().toISOString(),
        proposedType: draftRecord.proposedType || draftRecord.proposedInfo?.type || savedInfo.type || '',
        mappedFields: currentDraftSourceFieldMapping.mappedFields || {},
        unmappedFields: currentDraftSourceFieldMapping.unmappedFields || {},
        raw,
        note: 'Captured through modifier draft-record prefill bridge. Mapped fields were saved into info; unmapped fields are preserved here for provenance/review.'
    };
}


async function loadDraftRecordIntoAddForm(draftRecord) {
    const typeSelect = document.getElementById('type-select');
    const recordForm = document.getElementById('record-form');
    const selectedType = draftRecord.proposedType || draftRecord.proposedInfo?.type;

    if (!selectedType) {
        alert('Draft record does not specify a type.');
        return;
    }

    try {
        const response = await fetch(`${baseURL}/api/reference/type/${encodeURIComponent(selectedType)}`);
        const templateRecord = await response.json();

        if (!response.ok || !templateRecord?.info) {
            alert(`No template found for ${selectedType}.`);
            return;
        }

        typeSelect.value = selectedType;
        generateForm(createDraftTemplateRecord(templateRecord, draftRecord));
        renderDraftSourceMetadata(draftRecord, templateRecord);
        await runDraftDuplicatePreflight(draftRecord);
        recordForm.style.display = 'block';
    } catch (error) {
        console.error('Error loading draft record:', error);
        alert('Failed to load draft record.');
    }
}


// Function to render results
async function renderResults(data, resultElementId, multiple = false) {
    const container = document.getElementById(resultElementId);
    container.innerHTML = ''; // Clear previous results

    if (Array.isArray(data) && data.length > 0) {
        const selectElement = document.createElement('div'); // Using a div to simulate the select element
        selectElement.classList.add('custom-select');

        for (const item of data) {
            const label = item.label || item.info?.label || ''; // Handles the case for both the new and old data structure
            const id = item.id || item.info?.id; // Ensure we get the correct id
            const birth = item.info?.birth || '';
            const death = item.info?.death || '';
            const date = item.date || item.info?.date || '';
            const type = item.type || item.info?.type || '';
            const parentLabels = item.parentLabels || [];

            let formattedLabel = label;

            if (type === "theorist" || type === "artist") {
                if (birth && death) {
                    formattedLabel += ` <strong>${birth}–${death}</strong>`;
                } else if (birth && !death) {
                    formattedLabel += ` <strong>${birth}–</strong>`;
                }
            } else if (type === "artworkBook") {
                if (parentLabels.length > 0) {
                    const firstNonGhost = parentLabels[0];
                    const coAuthors = parentLabels.slice(1).filter(label => label); // Filter non-empty co-authors
                    formattedLabel = `<strong>${firstNonGhost}`;
                    if (coAuthors.length > 0) {
                        formattedLabel += ' & ' + coAuthors.join(' & ');
                    }
                    formattedLabel += `</strong>/ ${label} <strong>${date}</strong>`;
                } else if (date) {
                    formattedLabel = `${label} <strong>${date}</strong>`;
                }
            }

            // Create a custom option element with data-id
            const optionElement = document.createElement('div');
            optionElement.classList.add('custom-option');
            optionElement.dataset.id = id; // Assign the ID to the data-id attribute
            optionElement.innerHTML = formattedLabel;

            if (multiple) {
                optionElement.addEventListener('click', () => {
                    optionElement.classList.toggle('selected');
                });
            } else {
                optionElement.addEventListener('click', () => {
                    const allOptions = selectElement.querySelectorAll('.custom-option');
                    allOptions.forEach(opt => opt.classList.remove('selected'));
                    optionElement.classList.add('selected');
                });
            }

            selectElement.appendChild(optionElement);
        }

        container.appendChild(selectElement);
    } else {
        container.textContent = 'No matches found.';
    }
}

// Find Ghost Parents
async function isGhost(parentLabel) {
    const response = await fetch(`/api/check-author/${encodeURIComponent(parentLabel)}`);
    const result = await response.json();
    return !result.exists;
}

// Search 1: Theorist or Artist
document.getElementById('query-button-theorist-artist').addEventListener('click', async () => {
    const label = document.getElementById('query-theorist-artist').value.trim(); // Trim whitespace
    if (!label) {
      alert('Please enter a search term.');
      return;
    }
    
    const baseURL = `${window.location.protocol}//${window.location.host}`;
    const response = await fetch(`${baseURL}/api/reference/label/theorist-artist/${encodeURIComponent(label)}`);
    const data = await response.json();
    renderResults(data, 'result-theorist-artist', false); // Single selection
  });
  
  // Search 2: ArtworkBook
  document.getElementById('query-button-artworkbook').addEventListener('click', async () => {
    const label = document.getElementById('query-artworkbook').value.trim(); // Trim whitespace
    if (!label) {
      alert('Please enter a search term.');
      return;
    }
    
    const baseURL = `${window.location.protocol}//${window.location.host}`;
    const response = await fetch(`${baseURL}/api/reference/label/artworkbook/${encodeURIComponent(label)}`);
    const data = await response.json();
    renderResults(data, 'result-artworkbook', true); // Multiple selection
  });
  
  // Search for All Orphans
document.getElementById('query-button-orphans').addEventListener('click', async () => {
    const baseURL = `${window.location.protocol}//${window.location.host}`;
    const response = await fetch(`${baseURL}/api/reference/orphans`);
    const data = await response.json();
    renderResults(data, 'result-artworkbook', true);
  });

// Function to capture selections and trigger the database update
document.getElementById('confirm-selection').addEventListener('click', async () => {
    const selectedTheoristArtist = document.querySelector('#result-theorist-artist .custom-option.selected');
    const selectedArtworkBooks = document.querySelectorAll('#result-artworkbook .custom-option.selected');
  
    if (selectedTheoristArtist && selectedArtworkBooks.length > 0) {
        const parentId = selectedTheoristArtist.dataset.id; // Get the id of the selected theorist/artist
        const artworkIds = Array.from(selectedArtworkBooks).map(artwork => artwork.dataset.id); // Get the ids of the selected artworkBooks
        
        // Log the captured IDs for debugging
        console.log("Parent ID:", parentId);
        console.log("Artwork IDs:", artworkIds);

        if (!parentId || artworkIds.includes(undefined)) {
            alert('There was an error capturing the selected IDs. Please try again.');
            return;
        }
  
        // Update parentId in selected artworkBook records
        const parentUpdateResponse = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/add-parent`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ parentId, artworkIds })
        });
  
        // Update children in selected theorist/artist record
        const childrenUpdateResponse = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/add-children`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ parentId, childrenIds: artworkIds })
        });
  
        // Log the responses to debug
        console.log('Parent Update Response:', await parentUpdateResponse.json());
        console.log('Children Update Response:', await childrenUpdateResponse.json());
  
        alert('Relationships updated successfully!');
    } else {
        alert('Please select both a theorist/artist and one or more artworkBooks.');
    }
});

// ========== Duplicates ======

//search for duplicates
document.getElementById('check-duplicates').addEventListener('click', async () => {
    const response = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/duplicates`);
    const data = await response.json();
    renderResults(data, 'duplicate-results', false); // Single selection for now

    // Attach the event listeners for investigating duplicates
    attachDuplicateInvestigationListener('duplicate-results');
});

// Function to load and render all duplicate entries for a selected label
async function loadDuplicateEntries(label, resultElementId) {
    try {
        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/duplicates/${encodeURIComponent(label)}`);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        renderResults(data, resultElementId, true); // Multiple selection for comparing

        // Attach comparison listeners only after results are rendered
        attachComparisonListener(resultElementId);
    } catch (error) {
        console.error('Error loading duplicate entries:', error);
        alert('There was an issue loading duplicate entries. Please check the console for details.');
    }
}

// function to open sub results page
function attachDuplicateInvestigationListener(resultElementId) {
    const container = document.getElementById(resultElementId);
    const options = container.querySelectorAll('.custom-option');

    options.forEach(optionElement => {
        optionElement.addEventListener('click', async () => {
            const label = optionElement.textContent;
            await loadDuplicateEntriesAndAttachListener(label, 'duplicate-entry-details');
        });
    });
}

async function compareSelectedDuplicates(selectedIds) {
    try {
        const [firstId, secondId] = selectedIds;
        const response1 = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/${firstId}`);
        const response2 = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/${secondId}`);

        if (response1.status === 404 || response2.status === 404) {
            throw new Error(`One or both records could not be found.`);
        }

        const data1 = await response1.json();
        const data2 = await response2.json();

        // Display the two records side by side for comparison
        displayComparison(data1, data2);
    } catch (error) {
        if (error.message.includes('One or both records could not be found.')) {
            // Handle specific error for missing records
            alert('One or both records could not be found. Please check the IDs and try again.');
        } else {
            // Log other unexpected errors to the console
            console.error('Error comparing duplicates:', error);
            alert('There was an issue comparing the selected duplicates. Please check the console for details.');
        }
    }
}

async function displayComparison(data1, data2) {
    const container = document.getElementById('duplicate-entry-details');
    container.innerHTML = ''; // Clear previous content

    // Clear any previous event listeners on the compare button
    const compareButton = document.getElementById('compare-duplicates');
    if (compareButton) {
        compareButton.replaceWith(compareButton.cloneNode(true));
    }

    // Create a flex container for the comparison
    const flexContainer = document.createElement('div');
    flexContainer.classList.add('flex-container');

    // Add the comparison records to the flex container
    for (const data of [data1, data2]) {
        const wrapperDiv = document.createElement('div');
        wrapperDiv.classList.add('comparison-wrapper');
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = data.id; // Store the ID in the checkbox value

        // Add event listener to enable/disable the delete button based on selection
        checkbox.addEventListener('change', () => {
            const selectedCheckboxes = document.querySelectorAll('.comparison-wrapper input[type="checkbox"]:checked');
            const deleteButton = document.getElementById('delete-selected');
            deleteButton.disabled = selectedCheckboxes.length === 0; // Enable only if at least one checkbox is selected
        });

        // Await the formatted HTML
        const formattedHtml = await createFormattedHtml(data);

        // Only append if formattedHtml is a valid Node
        if (formattedHtml instanceof Node) {
            wrapperDiv.appendChild(checkbox);
            wrapperDiv.appendChild(formattedHtml);
            flexContainer.appendChild(wrapperDiv);
        } else {
            console.error('Formatted HTML is not a valid Node:', formattedHtml);
        }
    }

    // Append the flex container to the main container
    container.appendChild(flexContainer);

    // Remove any old delete button and add a fresh one
    let deleteButton = document.getElementById('delete-selected');
    if (deleteButton) {
        deleteButton.remove();
    }

    deleteButton = document.createElement('button');
    deleteButton.id = 'delete-selected';
    deleteButton.textContent = 'Delete Selected';
    deleteButton.disabled = true; // Disabled by default

    deleteButton.addEventListener('click', async () => {
        const selectedCheckboxes = document.querySelectorAll('.comparison-wrapper input[type="checkbox"]:checked');
        const selectedIds = Array.from(selectedCheckboxes).map(cb => cb.value);
        
        if (confirm('Do you really want to delete the selected duplicate(s)?')) {
            await deleteSelectedDuplicates(selectedIds);
            // Refresh the duplicates list and UI
            await refreshDuplicatesList();
        }
    });

    container.appendChild(deleteButton);
}

async function createFormattedHtml(data) {
    const ulElement = document.createElement('ul');
    
    const { label, label_jp, color, type, date, note, imgUrl } = data.info;

    const fields = {
        Label: label,
        "Label JP": label_jp,
        Color: color,
        Type: type,
        Date: date,
        Note: note,
        "Image URL": imgUrl,
    };

    for (const [key, value] of Object.entries(fields)) {
        const li = document.createElement('li');
        const innerUl = document.createElement('ul');
        const innerLiKey = document.createElement('li');
        const innerLiValue = document.createElement('li');

        innerLiKey.innerHTML = `<strong>${key}:</strong>`;
        innerLiValue.innerHTML = value;

        innerUl.appendChild(innerLiKey);
        innerUl.appendChild(innerLiValue);
        li.appendChild(innerUl);
        ulElement.appendChild(li);
    }

    if (data.parentId && data.parentId.length > 0) {
        for (let i = 0; i < data.parentId.length; i++) {
            const parentId = data.parentId[i];
            const parentLi = document.createElement('li');
            const parentList = document.createElement('ul');
            const parentTextLi = document.createElement('li');

            if (i === 0) {
                const parentHeaderLi = document.createElement('li');
                parentHeaderLi.innerHTML = `<strong>Parent ID:</strong>`;
                parentList.appendChild(parentHeaderLi);
            } else {
                const emptyHeaderLi = document.createElement('li');
                parentList.appendChild(emptyHeaderLi);
            }

            const parentText = await checkParent(parentId);
            parentTextLi.innerHTML = parentText;

            parentList.appendChild(parentTextLi);
            parentLi.appendChild(parentList);
            ulElement.appendChild(parentLi);
        }
    }

    if (data.children && data.children.length > 0) {
        for (let i = 0; i < data.children.length; i++) {
            const childId = data.children[i];
            const childLi = document.createElement('li');
            const childList = document.createElement('ul');
            const childTextLi = document.createElement('li');

            if (i === 0) {
                const childHeaderLi = document.createElement('li');
                childHeaderLi.innerHTML = `<strong>Children:</strong>`;
                childList.appendChild(childHeaderLi);
            } else {
                const emptyHeaderLi = document.createElement('li');
                childList.appendChild(emptyHeaderLi);
            }

            const childText = await checkParent(childId);
            childTextLi.innerHTML = childText;

            childList.appendChild(childTextLi);
            childLi.appendChild(childList);
            ulElement.appendChild(childLi);
        }
    }

    return ulElement;
}

// Helper function to truncate strings to a specified length
function truncate(str, length) {
    return str.length > length ? str.substring(0, length) + '...' : str;
}

async function checkParent(id) {
    try {
        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/validate/${encodeURIComponent(id)}`);

        if (response.status === 404) {
            return `Invalid Parent (ID: ${id.substring(0, 5)}...)`;
        }

        const data = await response.json();
        
        // If data.label is not found or is null, it should be considered invalid
        if (!data.label || data.label === 'Unknown Label') {
            return `Invalid Parent (ID: ${id.substring(0, 5)}...)`;
        }

        // If the label exists and is valid, return it as a valid parent
        return `Valid Parent: ${data.label.substring(0, 5)}... (ID: ${id.substring(0, 5)}...)`;
    } catch (error) {
        console.error(`Error fetching parent with ID ${id}:`, error);
        return `Invalid Parent (ID: ${id.substring(0, 5)}...)`;
    }
}

// Helper function to check if a parent or child exists in the database
async function checkParentOrChildValidity(id) {
    try {
        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/validate/${id}`);
        if (!response.ok) throw new Error('Record not found');
        const data = await response.json();
        return { valid: data.valid, label: data.label };
    } catch (error) {
        return { valid: false };
    }
}

// Function to attach event listeners for comparison
function attachComparisonListener(resultElementId) {
    const container = document.getElementById(resultElementId);
    const options = container.querySelectorAll('.custom-option');
    const compareButton = document.getElementById('compare-duplicates');

    // Clear previous selections
    selectedItems = [];

    options.forEach(optionElement => {
        const id = optionElement.dataset.id;

        optionElement.addEventListener('click', async () => {
            if (!optionElement.classList.contains('selected')) {
                selectedItems.push(id);
                optionElement.classList.add('selected');
            } else {
                selectedItems = selectedItems.filter(item => item !== id);
                optionElement.classList.remove('selected');
            }

            // Enable/Disable compare button based on the number of selected items
            compareButton.disabled = selectedItems.length !== 2;

            if (selectedItems.length === 2) {
                compareButton.addEventListener('click', handleCompareClick);
            }
        });
    });
}

function handleCompareClick() {
    compareSelectedDuplicates(selectedItems);
}

async function loadDuplicateEntriesAndAttachListener(label, resultElementId) {
    await loadDuplicateEntries(label, resultElementId);
    attachComparisonListener(resultElementId);
}

async function deleteSelectedDuplicates(selectedIds) {
    try {
        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/delete-duplicates`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ids: selectedIds })
        });

        const result = await response.json();

        if (response.ok) {
            alert(result.message || 'Duplicates deleted successfully.');

            // Clear the duplicate-entry-details div
            const duplicateDetailsContainer = document.getElementById('duplicate-entry-details');
            duplicateDetailsContainer.innerHTML = '';

            // Reset the selectedItems array and disable the compare button
            selectedItems = [];
            const compareButton = document.getElementById('compare-duplicates');
            compareButton.disabled = true; // Disable the compare button

            // Remove the compare button event listener, then reattach it after the refresh
            compareButton.removeEventListener('click', handleCompareClick);

            // Refresh the duplicate results list
            await refreshDuplicatesList();
        } else {
            alert(result.message || 'There was an error deleting the duplicates.');
        }
    } catch (error) {
        console.error('Error deleting duplicates:', error);
        alert('There was an error deleting the duplicates.');
    }
}

async function refreshDuplicatesList() {
    const response = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/duplicates`);
    const data = await response.json();
    renderResults(data, 'duplicate-results', false); // Refresh duplicate list
    attachDuplicateInvestigationListener('duplicate-results'); // Re-attach listeners
}

// EDIT SECTION

// Search all types
document.getElementById('query-button-all').addEventListener('click', async () => {
    const label = document.getElementById('query-all').value.trim(); // Trim whitespace
    console.log("Search initiated with label:", label);
    if (!label) {
        alert('Please enter a search term.');
        return;
    }

    const baseURL = `${window.location.protocol}//${window.location.host}`;
    try {
        const response = await fetch(`${baseURL}/api/reference/label/all/${encodeURIComponent(label)}`);
        const data = await response.json();
        console.log("Search results:", data);
        renderEditableResults(data, 'result-all'); // Single selection
    } catch (error) {
        console.error("Error during search:", error);
    }
});

// Handle edit record display
async function handleEditRecord(data) {
    console.log("Editing record with ID:", data.id);
    const editSection = document.getElementById('edit-section');
    const editRecord = document.getElementById('edit-record');
    editRecord.innerHTML = ''; // Clear previous content

    const fullRecord = await fetchFullRecordForEdit(data);
    const recordId = fullRecord.id || data.id || fullRecord.info?.id;
    const originalInfo = fullRecord.info || data.info || {};
    const ulElement = document.createElement('ul');

    for (const [key, value] of getInfoEntriesWithJapaneseNote(originalInfo)) {
        const li = document.createElement('li');

        const strong = document.createElement('strong');
        strong.textContent = `${key}:`;

        const span = document.createElement('span');
        span.contentEditable = 'true';
        span.textContent = formatValueForEditor(value);

        if (MULTILINE_INFO_FIELDS.has(key)) {
            span.classList.add('edit-long-field');
        }

        li.appendChild(strong);
        li.appendChild(span);
        ulElement.appendChild(li);
    }

    editRecord.appendChild(ulElement);
    renderRootSourceMetaPanel(editRecord, fullRecord.sourceMeta);
    editSection.style.display = 'block';

    const saveButton = document.getElementById('save-edits');
    saveButton.style.display = 'block';
    saveButton.onclick = async () => {
        console.log("Save Changes clicked for record ID:", recordId);
        const updatedInfo = {};
        ulElement.querySelectorAll('li').forEach(li => {
            const key = li.querySelector('strong').textContent.replace(':', '');
            const value = li.querySelector('span').textContent;
            updatedInfo[key] = parseEditedInfoValue(value, originalInfo[key]);
        });

        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/update/${recordId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ info: updatedInfo })
        });

        const result = await response.json();
        alert(result.message || 'Record updated successfully.');

        // Hide the "result-all" div
        const resultDiv = document.getElementById('result-all');
        if (resultDiv) {
            resultDiv.style.display = 'none';
        }

        // Clear the search field
        const searchField = document.getElementById('query-all');
        if (searchField) {
            searchField.value = '';
        }

        // Hide the edit section and save button
        editSection.style.display = 'none';
        saveButton.style.display = 'none';

        // Reattach the event listener for the search button
        reattachSearchEventListener();
    };
}

function reattachSearchEventListener() {
    const searchButton = document.getElementById('query-button-all');
    const newSearchButton = searchButton.cloneNode(true);
    searchButton.parentNode.replaceChild(newSearchButton, searchButton);

    newSearchButton.addEventListener('click', async () => {
        const label = document.getElementById('query-all').value.trim(); // Trim whitespace
        console.log("Search initiated with label:", label);
        if (!label) {
            alert('Please enter a search term.');
            return;
        }

        const baseURL = `${window.location.protocol}//${window.location.host}`;
        try {
            const response = await fetch(`${baseURL}/api/reference/label/all/${encodeURIComponent(label)}`);
            const data = await response.json();
            console.log("Search results:", data);
            renderEditableResults(data, 'result-all'); // Single selection

            // Redisplay the result-all div after search
            const resultDiv = document.getElementById('result-all');
            if (resultDiv) {
                resultDiv.style.display = 'block';
            }

            // Hide the edit section until a new item is selected for editing
            const editSection = document.getElementById('edit-section');
            if (editSection) {
                editSection.style.display = 'none';
            }
        } catch (error) {
            console.error("Error during search:", error);
        }
    });
}

// Specialized function to render results for editing
async function renderEditableResults(data, resultElementId) {
    console.log("Rendering results for editing.");
    const container = document.getElementById(resultElementId);
    container.innerHTML = ''; // Clear previous results

    if (Array.isArray(data) && data.length > 0) {
        const selectElement = document.createElement('div'); // Using a div to simulate the select element
        selectElement.classList.add('custom-select');

        for (const item of data) {
            const label = item.label || item.info?.label || ''; // Handles the case for both the new and old data structure
            const id = item.id || item.info?.id; // Ensure we get the correct id
            const birth = item.info?.birth || '';
            const death = item.info?.death || '';
            const date = item.date || item.info?.date || '';
            const type = item.type || item.info?.type || '';
            const parentLabels = item.parentLabels || [];

            let formattedLabel = label;

            if (type === "theorist" || type === "artist") {
                if (birth && death) {
                    formattedLabel += ` <strong>${birth}–${death}</strong>`;
                } else if (birth && !death) {
                    formattedLabel += ` <strong>${birth}–</strong>`;
                }
            } else if (type === "artworkBook") {
                if (parentLabels.length > 0) {
                    const firstNonGhost = parentLabels[0];
                    const coAuthors = parentLabels.slice(1).filter(label => label); // Filter non-empty co-authors
                    formattedLabel = `<strong>${firstNonGhost}`;
                    if (coAuthors.length > 0) {
                        formattedLabel += ' & ' + coAuthors.join(' & ');
                    }
                    formattedLabel += `</strong>/ ${label} <strong>${date}</strong>`;
                } else if (date) {
                    formattedLabel = `${label} <strong>${date}</strong>`;
                }
            }

            // Create a custom option element with data-id
            const optionElement = document.createElement('div');
            optionElement.classList.add('custom-option');
            optionElement.dataset.id = id; // Assign the ID to the data-id attribute
            optionElement.innerHTML = formattedLabel;

            // Event listener to handle edit selection
            optionElement.addEventListener('click', () => {
                console.log("Record selected for editing:", item.id);
                const allOptions = selectElement.querySelectorAll('.custom-option');
                allOptions.forEach(opt => opt.classList.remove('selected'));
                optionElement.classList.add('selected');
                handleEditRecord(item); // Display the record for editing
            });

            selectElement.appendChild(optionElement);
        }

        container.appendChild(selectElement);
    } else {
        container.textContent = 'No matches found.';
    }
}

// ADD FUNCTIONs

document.addEventListener('DOMContentLoaded', async () => {
    const typeSelect = document.getElementById('type-select');

    // Fetch and populate the types in the dropdown on page load
    try {
        const response = await fetch(`${baseURL}/api/reference/types`);
        const types = await response.json();

        types.forEach(type => {
            const option = document.createElement('option');
            option.value = type;
            option.textContent = type.charAt(0).toUpperCase() + type.slice(1);
            typeSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Error fetching types:', error);
        alert('Failed to load types.');
    }

    // Handle type selection
    typeSelect.addEventListener('change', async () => {
        const selectedType = typeSelect.value;
        clearDraftSourceMetadata();

        if (selectedType) {
            try {
                const response = await fetch(`${baseURL}/api/reference/type/${encodeURIComponent(selectedType)}`);
                const record = await response.json();

                // Use the record's `info` property as the template
                const templateRecord = record?.info;

                if (templateRecord) {
                    generateForm(record); // Pass the full record, not just `info`
                    document.getElementById('record-form').style.display = 'block';
                } else {
                    alert('No template found for this type.');
                }
            } catch (error) {
                console.error('Error fetching template record:', error);
                alert('Failed to load template.');
            }
        } else {
            document.getElementById('record-form').style.display = 'none';
        }
    });

    const loadTestDraftButton = document.getElementById('load-test-draft');
    if (loadTestDraftButton) {
        loadTestDraftButton.addEventListener('click', () => {
            loadDraftRecordIntoAddForm(testDraftRecord);
        });
    }

    const draftJsonLoader = document.getElementById('draft-json-loader');
    const draftJsonInput = document.getElementById('draft-json-input');
    const toggleDraftJsonLoaderButton = document.getElementById('toggle-draft-json-loader');
    const loadPastedDraftButton = document.getElementById('load-pasted-draft');
    const fillExampleDraftJsonButton = document.getElementById('fill-example-draft-json');
    const clearDraftJsonButton = document.getElementById('clear-draft-json');
    const loadLatestBrowserCaptureButton = document.getElementById('load-latest-browser-capture');

    if (loadLatestBrowserCaptureButton) {
        loadLatestBrowserCaptureButton.addEventListener('click', () => {
            loadLatestBrowserCapture();
        });
    }

    if (toggleDraftJsonLoaderButton && draftJsonLoader) {
        toggleDraftJsonLoaderButton.addEventListener('click', () => {
            const isHidden = draftJsonLoader.style.display === 'none' || !draftJsonLoader.style.display;
            draftJsonLoader.style.display = isHidden ? 'block' : 'none';
        });
    }

    if (loadPastedDraftButton) {
        loadPastedDraftButton.addEventListener('click', () => {
            loadDraftFromJsonInput();
        });
    }

    if (fillExampleDraftJsonButton && draftJsonInput) {
        fillExampleDraftJsonButton.addEventListener('click', () => {
            draftJsonInput.value = getExampleDraftJsonText(getSelectedDraftExampleKey());
        });
    }

    if (clearDraftJsonButton && draftJsonInput) {
        clearDraftJsonButton.addEventListener('click', () => {
            draftJsonInput.value = '';
        });
    }

    // Handle form submission
    document.getElementById('new-record-form').addEventListener('submit', async (event) => {
        event.preventDefault();
    
        const formData = new FormData(event.target);
        const newRecord = {};
        const info = {};
    
        // Initialize empty arrays for parentId and children at the root level
        newRecord.parentId = [];
        newRecord.children = [];
    
        formData.forEach((value, key) => {
            if (ROOT_RELATIONSHIP_FIELDS.has(key)) {
                // parentId and children are root-level relationship arrays.
                // Do not also copy them into info, or new records drift into two schemas.
                newRecord[key] = parseRootArrayField(value);
            } else {
                info[key] = value;
            }
        });

        if (!info.type && typeSelect.value) {
            info.type = typeSelect.value;
        }

        newRecord.info = ensureJapaneseNoteField(info);

        const persistableSourceMeta = createPersistableDraftSourceMeta(currentDraftRecord, newRecord.info);
        if (persistableSourceMeta) {
            newRecord.sourceMeta = persistableSourceMeta;
        }

        if (currentDraftDuplicateCandidates.length && !currentDraftDuplicateReviewAcknowledged) {
            const shouldContinue = confirm(
                `This draft has ${currentDraftDuplicateCandidates.length} possible existing record(s). ` +
                'Review them in Imported Source Metadata before saving. Continue anyway?'
            );
            if (!shouldContinue) return;
        }
    
        try {
            const response = await fetch(`${baseURL}/api/reference/new`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(newRecord)
            });
    
            const result = await response.json();
            
            if (response.ok) {
                alert(result.message || 'Record added successfully.');
                // Reset the form and hide it
                event.target.reset();
                clearDraftSourceMetadata();
                document.getElementById('record-form').style.display = 'none';
            } else {
                alert(result.error || 'Failed to add record.');
            }
        } catch (error) {
            console.error('Error adding record:', error);
            alert('Failed to add record.');
        }
    });
    
    
    
    
});

function generateForm(template) {
    const formFields = document.getElementById('form-fields');
    formFields.innerHTML = ''; // Clear any previous fields

    for (const [key, value] of getInfoEntriesWithJapaneseNote(template.info || {})) {
        appendFormField(formFields, key, value);
    }

    // Generate input fields for `parentId` and `children` at the root level.
    // These fields are intentionally not copied into info during submit.
    if (template.parentId) {
        const label = document.createElement('label');
        label.innerHTML = `Parent ID <br/><span>(comma-separated):</span>`;
        const input = document.createElement('input');
        input.type = 'text';
        input.name = 'parentId'; // Root-level key
        input.value = template.parentId.join(', ');
        formFields.appendChild(label);
        formFields.appendChild(input);
        formFields.appendChild(document.createElement('br'));
    }

    if (template.children) {
        const label = document.createElement('label');
        label.innerHTML = `Children<br/><span>(comma-separated):</span>`;
        const input = document.createElement('input');
        input.type = 'text';
        input.name = 'children'; // Root-level key
        input.value = template.children.join(', ');
        formFields.appendChild(label);
        formFields.appendChild(input);
        formFields.appendChild(document.createElement('br'));
    }
}

// DELETE FUNCTIONS

document.getElementById('query-button-delete').addEventListener('click', async () => {
    const label = document.getElementById('query-delete').value.trim(); // Trim whitespace
    console.log("Search initiated with label:", label);
    if (!label) {
        alert('Please enter a search term.');
        return;
    }

    const baseURL = `${window.location.protocol}//${window.location.host}`;
    try {
        const response = await fetch(`${baseURL}/api/reference/label/all/${encodeURIComponent(label)}`);
        const data = await response.json();
        console.log("Search results:", data);
        renderDeletableResults(data, 'result-delete'); // Display results with checkboxes
    } catch (error) {
        console.error("Error during search:", error);
    }
});

function renderDeletableResults(data, resultElementId) {
    const container = document.getElementById(resultElementId);
    container.innerHTML = ''; // Clear previous results

    if (Array.isArray(data) && data.length > 0) {
        data.forEach(item => {
            const label = item.label || item.info?.label || ''; // Handles the case for both the new and old data structure
            const id = item.id || item.info?.id; // Ensure we get the correct id

            // Create a wrapper div
            const wrapperDiv = document.createElement('div');
            wrapperDiv.classList.add('delete-item-wrapper');

            // Create a checkbox
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = id;

            // Create a label for the record
            const labelElement = document.createElement('label');
            labelElement.textContent = `${label} (ID: ${id})`;

            wrapperDiv.appendChild(checkbox);
            wrapperDiv.appendChild(labelElement);

            container.appendChild(wrapperDiv);
        });

        // Show the delete button if results are found
        const deleteButton = document.getElementById('delete-selected-records');
        deleteButton.style.display = 'block';
    } else {
        container.textContent = 'No matches found.';
        const deleteButton = document.getElementById('delete-selected-records');
        deleteButton.style.display = 'none';
    }
}

document.getElementById('delete-selected-records').addEventListener('click', async () => {
    const selectedCheckboxes = document.querySelectorAll('#result-delete input[type="checkbox"]:checked');
    const selectedIds = Array.from(selectedCheckboxes).map(cb => cb.value);

    if (selectedIds.length === 0) {
        alert('Please select at least one record to delete.');
        return;
    }

    const confirmation = confirm('Do you really want to delete the selected record(s)?');
    if (!confirmation) return;

    try {
        const response = await fetch(`${baseURL}/api/reference/delete-duplicates`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ids: selectedIds })
        });

        const result = await response.json();
        alert(result.message || 'Records deleted successfully.');

        // Clear the results and hide the delete button
        document.getElementById('result-delete').innerHTML = '';
        document.getElementById('delete-selected-records').style.display = 'none';
    } catch (error) {
        console.error('Error deleting records:', error);
        alert('Failed to delete records.');
    }
});






// ========== Read-only integrity report ==========

function humaniseIntegrityKey(key) {
    return key
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, char => char.toUpperCase());
}

function appendIntegritySection(container, title, items) {
    const section = document.createElement('div');
    section.classList.add('integrity-section');

    const heading = document.createElement('h3');
    heading.textContent = `${title} (${items.length})`;
    section.appendChild(heading);

    if (!items.length) {
        const ok = document.createElement('p');
        ok.textContent = 'No issues found.';
        section.appendChild(ok);
    } else {
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(items, null, 2);
        section.appendChild(pre);
    }

    container.appendChild(section);
}

function appendGroupedIntegritySection(container, title, groups) {
    const section = document.createElement('div');
    section.classList.add('integrity-section', 'integrity-grouped-section');

    const heading = document.createElement('h3');
    heading.textContent = `${title} (${groups.length})`;
    section.appendChild(heading);

    if (!groups.length) {
        const ok = document.createElement('p');
        ok.textContent = 'No grouped issues found.';
        section.appendChild(ok);
        container.appendChild(section);
        return;
    }

    groups.forEach(group => {
        const groupBlock = document.createElement('details');
        groupBlock.classList.add('integrity-group');
        groupBlock.open = false;

        const summary = document.createElement('summary');
        summary.textContent = `${group.displayValue} — ${group.count} record${group.count === 1 ? '' : 's'} (${group.valueKind})`;
        groupBlock.appendChild(summary);

        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(group.records || [], null, 2);
        groupBlock.appendChild(pre);

        section.appendChild(groupBlock);
    });

    container.appendChild(section);
}

function createButton(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.classList.add(className);
    return button;
}

async function rerunIntegrityReport() {
    const response = await fetch(`${baseURL}/api/reference/integrity-report`);
    const report = await response.json();

    if (!response.ok) {
        throw new Error(report.error || 'Failed to run integrity report.');
    }

    renderIntegrityReport(report);
}

function appendDirtyRelationshipCleanupPreview(container, preview) {
    const section = document.createElement('div');
    section.classList.add('integrity-section', 'integrity-cleanup-preview');

    const heading = document.createElement('h3');
    heading.textContent = `Dirty Relationship Value Cleanup Preview (${preview?.count || 0})`;
    section.appendChild(heading);

    const explanation = document.createElement('p');
    explanation.textContent = 'This narrow cleanup removes only null, undefined, "undefined", "null", and empty-string values from root-level parentId / children arrays. It does not repair missing IDs or merge records.';
    section.appendChild(explanation);

    if (!preview || !Array.isArray(preview.changes) || preview.changes.length === 0) {
        const ok = document.createElement('p');
        ok.textContent = 'No dirty relationship values found.';
        section.appendChild(ok);
        container.appendChild(section);
        return;
    }

    const details = document.createElement('details');
    details.classList.add('integrity-group');
    details.open = true;

    const summary = document.createElement('summary');
    summary.textContent = `Preview ${preview.changes.length} record${preview.changes.length === 1 ? '' : 's'} that would be cleaned`;
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(preview.changes, null, 2);
    details.appendChild(pre);
    section.appendChild(details);

    const cleanButton = createButton('Clean Dirty Relationship Values', 'integrity-danger-button');
    cleanButton.addEventListener('click', async () => {
        const confirmed = confirm('Clean only dirty relationship array values? This removes null / undefined / empty relationship IDs, but does not repair missing records.');
        if (!confirmed) return;

        cleanButton.disabled = true;
        cleanButton.textContent = 'Cleaning...';

        try {
            const response = await fetch(`${baseURL}/api/reference/dirty-relationship-values/clean`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Cleanup failed.');
            }

            alert(result.message || 'Cleanup complete.');
            await rerunIntegrityReport();
        } catch (error) {
            console.error('Error cleaning dirty relationship values:', error);
            alert('Failed to clean dirty relationship values. Check the server console for details.');
            cleanButton.disabled = false;
            cleanButton.textContent = 'Clean Dirty Relationship Values';
        }
    });

    section.appendChild(cleanButton);
    container.appendChild(section);
}



function appendStaleChildReferenceCleanupPreview(container, preview) {
    const section = document.createElement('div');
    section.classList.add('integrity-section', 'stale-child-cleanup-preview');

    const heading = document.createElement('h3');
    heading.textContent = `Stale Child Reference Cleanup Preview (${preview?.count || 0})`;
    section.appendChild(heading);

    const explanation = document.createElement('p');
    explanation.textContent = 'This narrow cleanup removes only children IDs that point to no existing record. It does not touch parentId arrays, repair authors, merge duplicates, or edit info fields.';
    section.appendChild(explanation);

    if (!preview || !Array.isArray(preview.changes) || preview.changes.length === 0) {
        const ok = document.createElement('p');
        ok.textContent = 'No stale child references found.';
        section.appendChild(ok);
        container.appendChild(section);
        return;
    }

    const details = document.createElement('details');
    details.classList.add('integrity-group');
    details.open = true;

    const removedReferenceCount = preview.removedReferenceCount || 0;
    const summary = document.createElement('summary');
    summary.textContent = `Preview ${removedReferenceCount} stale child reference${removedReferenceCount === 1 ? '' : 's'} in ${preview.changes.length} record${preview.changes.length === 1 ? '' : 's'}`;
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(preview.changes, null, 2);
    details.appendChild(pre);
    section.appendChild(details);

    const cleanButton = createButton('Clean Stale Child References', 'integrity-danger-button');
    cleanButton.addEventListener('click', async () => {
        const confirmed = confirm('Clean stale child references? This removes only children IDs that no longer point to an existing record. It does not alter parentId arrays.');
        if (!confirmed) return;

        cleanButton.disabled = true;
        cleanButton.textContent = 'Cleaning...';

        try {
            const response = await fetch(`${baseURL}/api/reference/stale-child-references/clean`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Cleanup failed.');
            }

            alert(result.message || 'Cleanup complete.');
            await rerunIntegrityReport();
        } catch (error) {
            console.error('Error cleaning stale child references:', error);
            alert('Failed to clean stale child references. Check the server console for details.');
            cleanButton.disabled = false;
            cleanButton.textContent = 'Clean Stale Child References';
        }
    });

    section.appendChild(cleanButton);
    container.appendChild(section);
}



function appendHistoricalInfoRelationshipCleanupPreview(container, preview) {
    const section = document.createElement('div');
    section.classList.add('integrity-section', 'historical-info-cleanup-preview');

    const heading = document.createElement('h3');
    heading.textContent = `Historical Info Relationship Field Cleanup Preview (${preview?.count || 0})`;
    section.appendChild(heading);

    const explanation = document.createElement('p');
    explanation.textContent = 'This narrow cleanup removes only duplicated shadow fields inside info.parentId and info.children. It does not alter root-level parentId / children arrays or any other info fields.';
    section.appendChild(explanation);

    if (!preview || !Array.isArray(preview.changes) || preview.changes.length === 0) {
        const ok = document.createElement('p');
        ok.textContent = 'No historical info relationship fields found.';
        section.appendChild(ok);
        container.appendChild(section);
        return;
    }

    const details = document.createElement('details');
    details.classList.add('integrity-group');
    details.open = true;

    const removedFieldCount = preview.removedFieldCount || 0;
    const summary = document.createElement('summary');
    summary.textContent = `Preview ${removedFieldCount} info shadow field${removedFieldCount === 1 ? '' : 's'} in ${preview.changes.length} record${preview.changes.length === 1 ? '' : 's'}`;
    details.appendChild(summary);

    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(preview.changes, null, 2);
    details.appendChild(pre);
    section.appendChild(details);

    const cleanButton = createButton('Clean Historical Info Relationship Fields', 'integrity-danger-button');
    cleanButton.addEventListener('click', async () => {
        const confirmed = confirm('Remove historical info.parentId / info.children fields? This does not touch root-level parentId / children arrays.');
        if (!confirmed) return;

        cleanButton.disabled = true;
        cleanButton.textContent = 'Cleaning...';

        try {
            const response = await fetch(`${baseURL}/api/reference/historical-info-relationships/clean`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Cleanup failed.');
            }

            alert(result.message || 'Cleanup complete.');
            await rerunIntegrityReport();
        } catch (error) {
            console.error('Error cleaning historical info relationship fields:', error);
            alert('Failed to clean historical info relationship fields. Check the server console for details.');
            cleanButton.disabled = false;
            cleanButton.textContent = 'Clean Historical Info Relationship Fields';
        }
    });

    section.appendChild(cleanButton);
    container.appendChild(section);
}


function shortId(value) {
    const stringValue = String(value || '');
    if (stringValue.length <= 12) return stringValue;
    return `${stringValue.slice(0, 8)}…${stringValue.slice(-4)}`;
}

function formatRecordSummary(record, options = {}) {
    if (!record) return 'Unknown record';

    const label = record.label || '(no label)';
    const type = record.type ? ` [${record.type}]` : '';

    let dateBits = '';
    if (record.type === 'theorist' || record.type === 'artist') {
        if (record.birth && record.death) dateBits = ` (${record.birth}–${record.death})`;
        else if (record.birth) dateBits = ` (${record.birth}–)`;
    } else if (record.date) {
        dateBits = ` (${record.date})`;
    }

    const id = record.id && options.includeId !== false ? ` — ${options.shortId ? shortId(record.id) : record.id}` : '';
    return `${label}${dateBits}${type}${id}`;
}

function formatMissingParentGroupLabel(group) {
    const records = group.records || [];
    const samples = records.slice(0, 3).map(record => {
        const date = record.date ? ` (${record.date})` : '';
        return `${record.label || '(no label)'}${date}`;
    });

    const sampleText = samples.join(' / ');
    const moreText = records.length > samples.length ? ` / +${records.length - samples.length} more` : '';
    return `${group.count} record${group.count === 1 ? '' : 's'} — ${sampleText}${moreText} — ${shortId(group.displayValue)}`;
}

function appendRecordList(container, records, options = {}) {
    const list = document.createElement('ul');
    list.classList.add('record-context-list');

    records.forEach(record => {
        const item = document.createElement('li');
        item.textContent = formatRecordSummary(record, { shortId: true, includeId: options.includeId !== false });
        list.appendChild(item);
    });

    container.appendChild(list);
}

function appendMissingParentReplacementPreview(container, groups) {
    const section = document.createElement('div');
    section.classList.add('integrity-section', 'missing-parent-preview-section');

    const heading = document.createElement('h3');
    heading.textContent = 'Missing Parent Replacement Preview';
    section.appendChild(heading);

    const explanation = document.createElement('p');
    explanation.textContent = 'Choose a missing parent group by the affected records, search for the current surviving parent record, preview the repair, then apply it only after checking the affected records.';
    section.appendChild(explanation);

    const candidateGroups = (groups || []).filter(group => group.valueKind === 'missing-record-id');

    if (!candidateGroups.length) {
        const ok = document.createElement('p');
        ok.textContent = 'No missing parent IDs available for replacement preview.';
        section.appendChild(ok);
        container.appendChild(section);
        return;
    }

    const controls = document.createElement('div');
    controls.classList.add('missing-parent-preview-controls');

    const missingLabel = document.createElement('label');
    missingLabel.textContent = 'Affected records group: ';

    const missingSelect = document.createElement('select');
    candidateGroups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.missingId;
        option.textContent = formatMissingParentGroupLabel(group);
        option.title = `Missing parent ID: ${group.displayValue}`;
        missingSelect.appendChild(option);
    });

    missingLabel.appendChild(missingSelect);
    controls.appendChild(missingLabel);

    const searchLabel = document.createElement('label');
    searchLabel.textContent = ' Search replacement record: ';

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'e.g. Jacques Lacan';
    searchLabel.appendChild(searchInput);
    controls.appendChild(searchLabel);

    const searchButton = createButton('Search Candidates', 'integrity-secondary-button');
    controls.appendChild(searchButton);

    section.appendChild(controls);

    const groupContext = document.createElement('div');
    groupContext.classList.add('missing-parent-group-context');
    section.appendChild(groupContext);

    const candidateResults = document.createElement('div');
    candidateResults.classList.add('missing-parent-candidates');
    section.appendChild(candidateResults);

    const selectedReplacement = document.createElement('p');
    selectedReplacement.classList.add('missing-parent-selection');
    selectedReplacement.textContent = 'No replacement selected.';
    section.appendChild(selectedReplacement);

    const previewButton = createButton('Preview Replacement', 'integrity-secondary-button');
    previewButton.disabled = true;
    section.appendChild(previewButton);

    const applyButton = createButton('Apply Reviewed Replacement', 'integrity-danger-button');
    applyButton.disabled = true;
    section.appendChild(applyButton);

    const previewResults = document.createElement('div');
    previewResults.classList.add('missing-parent-preview-results');
    section.appendChild(previewResults);

    let replacementId = null;
    let replacementSummary = null;
    let lastPreview = null;

    function getSelectedGroup() {
        return candidateGroups.find(group => String(group.missingId) === missingSelect.value) || candidateGroups[0];
    }

    function renderSelectedGroupContext() {
        const group = getSelectedGroup();
        const records = group?.records || [];

        groupContext.innerHTML = '';
        previewResults.innerHTML = '';

        const title = document.createElement('h4');
        title.textContent = 'Affected records for selected missing parent';
        groupContext.appendChild(title);

        const meta = document.createElement('p');
        meta.textContent = `Missing parent ID: ${group.displayValue} / ${group.count} affected record${group.count === 1 ? '' : 's'}.`;
        groupContext.appendChild(meta);

        if (!records.length) {
            const empty = document.createElement('p');
            empty.textContent = 'No affected records were included in this diagnostic group.';
            groupContext.appendChild(empty);
            return;
        }

        appendRecordList(groupContext, records, { includeId: false });

        const hint = document.createElement('p');
        hint.classList.add('integrity-help-text');
        hint.textContent = 'Use these titles/dates to decide which current person or parent record to search for above.';
        groupContext.appendChild(hint);
    }

    missingSelect.addEventListener('change', () => {
        candidateResults.innerHTML = '';
        replacementId = null;
        replacementSummary = null;
        lastPreview = null;
        selectedReplacement.textContent = 'No replacement selected.';
        previewButton.disabled = true;
        applyButton.disabled = true;
        renderSelectedGroupContext();
    });

    renderSelectedGroupContext();

    function renderCandidateResults(results) {
        candidateResults.innerHTML = '';
        previewResults.innerHTML = '';
        replacementId = null;
        replacementSummary = null;
        lastPreview = null;
        selectedReplacement.textContent = 'No replacement selected.';
        previewButton.disabled = true;
        applyButton.disabled = true;

        if (!results.length) {
            candidateResults.textContent = 'No candidate records found.';
            return;
        }

        results.forEach(candidate => {
            const candidateBlock = document.createElement('button');
            candidateBlock.type = 'button';
            candidateBlock.classList.add('candidate-result-button');
            candidateBlock.textContent = formatRecordSummary(candidate, { shortId: true });

            candidateBlock.addEventListener('click', () => {
                replacementId = candidate.id;
                replacementSummary = candidate;
                selectedReplacement.textContent = `Selected replacement: ${formatRecordSummary(candidate, { shortId: true })}`;
                previewButton.disabled = false;
                applyButton.disabled = true;
                lastPreview = null;

                candidateResults.querySelectorAll('.candidate-result-button').forEach(button => {
                    button.classList.remove('selected');
                });
                candidateBlock.classList.add('selected');
            });

            candidateResults.appendChild(candidateBlock);
        });
    }

    searchButton.addEventListener('click', async () => {
        const query = searchInput.value.trim();

        if (!query) {
            alert('Enter a label to search for a replacement record.');
            return;
        }

        candidateResults.textContent = 'Searching...';
        previewResults.innerHTML = '';
        applyButton.disabled = true;
        lastPreview = null;

        try {
            const response = await fetch(`${baseURL}/api/reference/missing-parent-replacement/candidates?query=${encodeURIComponent(query)}`);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Candidate search failed.');
            }

            renderCandidateResults(data.results || []);
        } catch (error) {
            console.error('Error searching replacement candidates:', error);
            candidateResults.textContent = 'Candidate search failed. Check the server console.';
        }
    });

    searchInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            searchButton.click();
        }
    });

    previewButton.addEventListener('click', async () => {
        if (!replacementId) {
            alert('Select a replacement record first.');
            return;
        }

        const missingParentId = missingSelect.value;

        previewResults.textContent = 'Building preview...';

        try {
            const url = `${baseURL}/api/reference/missing-parent-replacement/preview?missingParentId=${encodeURIComponent(missingParentId)}&replacementId=${encodeURIComponent(replacementId)}`;
            const response = await fetch(url);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Preview failed.');
            }

            const preview = data.preview || {};
            lastPreview = {
                missingParentId,
                replacementId,
                replacementSummary,
                preview
            };
            applyButton.disabled = Boolean(data.oldRecordStillExists) || !preview.affectedCount;
            previewResults.innerHTML = '';

            const warning = document.createElement('p');
            warning.textContent = data.oldRecordStillExists
                ? 'Warning: the old parent ID still exists in the database, so this is not a simple missing-record repair.'
                : 'Preview ready. No database changes have been made yet.';
            previewResults.appendChild(warning);

            const summary = document.createElement('p');
            summary.textContent = `Would replace ${shortId(preview.missingParentId)} with ${formatRecordSummary(preview.replacement, { shortId: true })} for ${preview.affectedCount || 0} record${preview.affectedCount === 1 ? '' : 's'}.`;
            previewResults.appendChild(summary);

            const childrenSummary = document.createElement('p');
            const addCount = Array.isArray(preview.childIdsToAddToReplacement)
                ? preview.childIdsToAddToReplacement.length
                : 0;
            childrenSummary.textContent = `Replacement record would gain ${addCount} child reference${addCount === 1 ? '' : 's'} if this is applied.`;
            previewResults.appendChild(childrenSummary);

            if (Array.isArray(preview.changes) && preview.changes.length) {
                const affectedHeading = document.createElement('h4');
                affectedHeading.textContent = 'Affected records';
                previewResults.appendChild(affectedHeading);
                appendRecordList(previewResults, preview.changes.map(change => change.record), { includeId: false });
            }

            const details = document.createElement('details');
            details.classList.add('integrity-group');
            details.open = false;

            const detailsSummary = document.createElement('summary');
            detailsSummary.textContent = 'Raw preview JSON';
            details.appendChild(detailsSummary);

            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(preview, null, 2);
            details.appendChild(pre);
            previewResults.appendChild(details);
        } catch (error) {
            console.error('Error building replacement preview:', error);
            previewResults.textContent = 'Replacement preview failed. Check the server console.';
            applyButton.disabled = true;
            lastPreview = null;
        }
    });

    applyButton.addEventListener('click', async () => {
        if (!lastPreview || !replacementId) {
            alert('Preview the replacement before applying it.');
            return;
        }

        const affectedCount = lastPreview.preview?.affectedCount || 0;
        const replacementLabel = lastPreview.replacementSummary?.label || lastPreview.preview?.replacement?.label || replacementId;
        const confirmed = confirm(`Apply this missing-parent replacement?

${affectedCount} affected record${affectedCount === 1 ? '' : 's'} will replace the missing parent ID with: ${replacementLabel}.

This will also add the affected record IDs to the replacement parent's children array.`);

        if (!confirmed) return;

        applyButton.disabled = true;
        applyButton.textContent = 'Applying...';

        try {
            const response = await fetch(`${baseURL}/api/reference/missing-parent-replacement/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    missingParentId: lastPreview.missingParentId,
                    replacementId: lastPreview.replacementId
                })
            });
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Apply failed.');
            }

            alert(result.message || 'Missing-parent replacement applied.');
            await rerunIntegrityReport();
        } catch (error) {
            console.error('Error applying missing-parent replacement:', error);
            alert('Failed to apply missing-parent replacement. Check the server console for details.');
            applyButton.disabled = false;
            applyButton.textContent = 'Apply Reviewed Replacement';
        }
    });

    container.appendChild(section);
}



function appendReciprocalRelationshipRepairPreview(container, preview) {
    const section = document.createElement('div');
    section.classList.add('integrity-section', 'reciprocal-relationship-repair-preview');

    const heading = document.createElement('h3');
    heading.textContent = `Reviewed Reciprocal Relationship Actions (${preview?.count || 0})`;
    section.appendChild(heading);

    const explanation = document.createElement('p');
    explanation.textContent = 'These rows show one-sided relationships where both records still exist. For each row, either add the missing reciprocal link, remove the asserted one-sided link, or leave it untouched.';
    section.appendChild(explanation);

    if (!preview || preview.count === 0) {
        const ok = document.createElement('p');
        ok.textContent = 'No reciprocal relationship mismatches found.';
        section.appendChild(ok);
        container.appendChild(section);
        return;
    }

    const selectedCountText = document.createElement('p');
    selectedCountText.classList.add('integrity-help-text');

    const controls = document.createElement('div');
    controls.classList.add('reciprocal-review-controls');

    const selectAllButton = createButton('Select all', 'integrity-secondary-button');
    const clearAllButton = createButton('Clear all', 'integrity-secondary-button');
    const setAllAddButton = createButton('Set selected to add reciprocal', 'integrity-secondary-button');
    const setAllRemoveButton = createButton('Set selected to remove asserted link', 'integrity-secondary-button');

    controls.appendChild(selectAllButton);
    controls.appendChild(clearAllButton);
    controls.appendChild(setAllAddButton);
    controls.appendChild(setAllRemoveButton);
    section.appendChild(controls);

    const form = document.createElement('form');
    form.classList.add('reciprocal-review-form');

    const rowControls = [];

    function createReviewRow(change, directionLabel) {
        const row = document.createElement('div');
        row.classList.add('reciprocal-review-row');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = change.actionKey;
        checkbox.classList.add('reciprocal-action-checkbox');

        const select = document.createElement('select');
        select.classList.add('reciprocal-action-select');

        const addOption = document.createElement('option');
        addOption.value = 'add-reciprocal';
        addOption.textContent = change.addActionLabel || 'Add reciprocal link';
        select.appendChild(addOption);

        const removeOption = document.createElement('option');
        removeOption.value = 'remove-asserted';
        removeOption.textContent = change.removeActionLabel || 'Remove asserted one-sided link';
        select.appendChild(removeOption);

        const label = document.createElement('label');
        label.classList.add('reciprocal-review-label');
        label.appendChild(checkbox);

        const text = document.createElement('span');
        const childText = formatRecordSummary(change.child, { shortId: true });
        const parentText = formatRecordSummary(change.parent, { shortId: true });

        if (change.direction === 'add-child-to-parent') {
            text.textContent = `${parentText} is missing child ${childText}`;
        } else {
            text.textContent = `${childText} is missing parent ${parentText}`;
        }

        label.appendChild(text);
        row.appendChild(label);

        const meta = document.createElement('p');
        meta.classList.add('integrity-help-text');
        meta.textContent = `${directionLabel}: ${change.explanation || ''}`;
        row.appendChild(meta);

        row.appendChild(select);

        rowControls.push({ checkbox, select, change });
        return row;
    }

    const childDetails = document.createElement('details');
    childDetails.classList.add('integrity-group');
    childDetails.open = true;

    const childSummary = document.createElement('summary');
    childSummary.textContent = `Child says parent exists; parent is missing child (${preview.addChildReferenceCount || 0})`;
    childDetails.appendChild(childSummary);

    if (Array.isArray(preview.addChildReferenceChanges) && preview.addChildReferenceChanges.length) {
        preview.addChildReferenceChanges.forEach(change => {
            childDetails.appendChild(createReviewRow(change, 'Default repair would add child ID to parent.children'));
        });
    } else {
        const none = document.createElement('p');
        none.textContent = 'No child IDs need adding to parent.children.';
        childDetails.appendChild(none);
    }

    form.appendChild(childDetails);

    const parentDetails = document.createElement('details');
    parentDetails.classList.add('integrity-group');
    parentDetails.open = true;

    const parentSummary = document.createElement('summary');
    parentSummary.textContent = `Parent says child exists; child is missing parent (${preview.addParentReferenceCount || 0})`;
    parentDetails.appendChild(parentSummary);

    if (Array.isArray(preview.addParentReferenceChanges) && preview.addParentReferenceChanges.length) {
        preview.addParentReferenceChanges.forEach(change => {
            parentDetails.appendChild(createReviewRow(change, 'Default repair would add parent ID to child.parentId'));
        });
    } else {
        const none = document.createElement('p');
        none.textContent = 'No parent IDs need adding to child.parentId.';
        parentDetails.appendChild(none);
    }

    form.appendChild(parentDetails);
    section.appendChild(form);

    function updateSelectedCount() {
        const selectedCount = rowControls.filter(row => row.checkbox.checked).length;
        selectedCountText.textContent = `${selectedCount} of ${rowControls.length} reviewed action${rowControls.length === 1 ? '' : 's'} selected.`;
    }

    rowControls.forEach(row => {
        row.checkbox.addEventListener('change', updateSelectedCount);
    });

    selectAllButton.addEventListener('click', () => {
        rowControls.forEach(row => { row.checkbox.checked = true; });
        updateSelectedCount();
    });

    clearAllButton.addEventListener('click', () => {
        rowControls.forEach(row => { row.checkbox.checked = false; });
        updateSelectedCount();
    });

    setAllAddButton.addEventListener('click', () => {
        rowControls.forEach(row => {
            if (row.checkbox.checked) row.select.value = 'add-reciprocal';
        });
    });

    setAllRemoveButton.addEventListener('click', () => {
        rowControls.forEach(row => {
            if (row.checkbox.checked) row.select.value = 'remove-asserted';
        });
    });

    section.appendChild(selectedCountText);
    updateSelectedCount();

    const rawDetails = document.createElement('details');
    rawDetails.classList.add('integrity-group');
    rawDetails.open = false;

    const rawSummary = document.createElement('summary');
    rawSummary.textContent = 'Raw reciprocal review preview JSON';
    rawDetails.appendChild(rawSummary);

    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(preview, null, 2);
    rawDetails.appendChild(pre);
    section.appendChild(rawDetails);

    const applyButton = createButton('Apply Selected Reciprocal Actions', 'integrity-danger-button');
    applyButton.addEventListener('click', async () => {
        const actions = rowControls
            .filter(row => row.checkbox.checked)
            .map(row => ({
                actionKey: row.change.actionKey,
                resolution: row.select.value
            }));

        if (actions.length === 0) {
            alert('Select at least one reciprocal relationship action first.');
            return;
        }

        const removeCount = actions.filter(action => action.resolution === 'remove-asserted').length;
        const addCount = actions.filter(action => action.resolution === 'add-reciprocal').length;
        const confirmed = confirm(`Apply ${actions.length} selected reciprocal relationship action${actions.length === 1 ? '' : 's'}?\n\nAdd reciprocal link: ${addCount}\nRemove asserted one-sided link: ${removeCount}\n\nThis will only affect the selected rows.`);
        if (!confirmed) return;

        applyButton.disabled = true;
        applyButton.textContent = 'Applying...';

        try {
            const response = await fetch(`${baseURL}/api/reference/reciprocal-relationships/apply-reviewed`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actions })
            });
            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Reviewed reciprocal action failed.');
            }

            alert(result.message || 'Reviewed reciprocal relationship actions applied.');
            await rerunIntegrityReport();
        } catch (error) {
            console.error('Error applying reviewed reciprocal relationship actions:', error);
            alert('Failed to apply reviewed reciprocal relationship actions. Check the server console for details.');
            applyButton.disabled = false;
            applyButton.textContent = 'Apply Selected Reciprocal Actions';
        }
    });

    section.appendChild(applyButton);
    container.appendChild(section);
}


function renderIntegrityReport(report) {
    const container = document.getElementById('integrity-report-results');
    container.innerHTML = '';

    const meta = document.createElement('p');
    meta.textContent = `Checked ${report.totalRecords} records at ${report.generatedAt}.`;
    container.appendChild(meta);

    const summaryWrapper = document.createElement('div');
    summaryWrapper.classList.add('integrity-summary');

    Object.entries(report.summary || {}).forEach(([key, count]) => {
        const card = document.createElement('div');
        card.classList.add('integrity-summary-card');

        const number = document.createElement('strong');
        number.textContent = count;

        const label = document.createElement('span');
        label.textContent = humaniseIntegrityKey(key);

        card.appendChild(number);
        card.appendChild(label);
        summaryWrapper.appendChild(card);
    });

    container.appendChild(summaryWrapper);

    appendMissingParentReplacementPreview(
        container,
        report.groupedDiagnostics?.missingParentIdsGrouped || []
    );

    appendDirtyRelationshipCleanupPreview(
        container,
        report.cleanupPreviews?.dirtyRelationshipValues || { count: 0, changes: [] }
    );

    appendStaleChildReferenceCleanupPreview(
        container,
        report.cleanupPreviews?.staleChildReferences || { count: 0, removedReferenceCount: 0, changes: [] }
    );

    appendHistoricalInfoRelationshipCleanupPreview(
        container,
        report.cleanupPreviews?.historicalInfoRelationshipFields || { count: 0, removedFieldCount: 0, changes: [] }
    );

    appendReciprocalRelationshipRepairPreview(
        container,
        report.cleanupPreviews?.reciprocalRelationships || { count: 0, addChildReferenceCount: 0, addParentReferenceCount: 0, addChildReferenceChanges: [], addParentReferenceChanges: [] }
    );

    appendGroupedIntegritySection(
        container,
        'Missing Parent IDs Grouped',
        report.groupedDiagnostics?.missingParentIdsGrouped || []
    );

    appendGroupedIntegritySection(
        container,
        'Missing Child IDs Grouped',
        report.groupedDiagnostics?.missingChildIdsGrouped || []
    );

    const issueOrder = [
        'recordsMissingId',
        'duplicateIds',
        'missingParentIdField',
        'malformedParentId',
        'missingChildrenField',
        'malformedChildren',
        'parentIdsPointingNowhere',
        'childrenIdsPointingNowhere',
        'childParentNotReciprocated',
        'parentChildNotReciprocated',
        'duplicateLabelsByType',
        'historicalInfoRelationshipFields'
    ];

    issueOrder.forEach(key => {
        appendIntegritySection(container, humaniseIntegrityKey(key), report.issues?.[key] || []);
    });
}

const integrityButton = document.getElementById('run-integrity-report');
if (integrityButton) {
    integrityButton.addEventListener('click', async () => {
        const container = document.getElementById('integrity-report-results');
        container.textContent = 'Running integrity report...';

        try {
            await rerunIntegrityReport();
        } catch (error) {
            console.error('Error running integrity report:', error);
            container.textContent = 'Failed to run integrity report. Check the server console for details.';
        }
    });
}


//handle visual scrolling
function showContentSection(targetId, updateHistory = true) {
    const contentWrapper = document.querySelector('.content-wrapper');
    const targetSection = document.querySelector(targetId);
    const allSections = Array.from(document.querySelectorAll('.content-section'));

    if (!contentWrapper || !targetSection || allSections.length === 0) {
        return;
    }

    const targetIndex = allSections.indexOf(targetSection);
    if (targetIndex < 0) {
        return;
    }

    const shiftPercent = (targetIndex * 100) / allSections.length;
    contentWrapper.style.transform = `translateX(-${shiftPercent}%)`;

    if (updateHistory) {
        window.history.pushState({}, '', targetId); // Update the URL without jumping
    }
}

document.querySelectorAll('nav a').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        showContentSection(this.getAttribute('href'));
    });
});

if (window.location.hash && document.querySelector(window.location.hash)) {
    showContentSection(window.location.hash, false);
}

// ========== Image queue scaffold ==========
// This is the first non-destructive image workflow step: queue records and build
// search queries. It does not scrape, download, upload, or write image data yet.
const IMAGE_QUEUE_LIMIT = 5;
const imageQueueRecords = [];

function getImageQueueRecordId(record) {
    return record?.id || record?.info?.id || '';
}

function getImageQueueInfo(record) {
    return record?.info || record || {};
}

function normaliseImageQueueRecord(record) {
    const info = getImageQueueInfo(record);
    return {
        id: getImageQueueRecordId(record),
        label: info.label || record?.label || '',
        label_jp: info.label_jp || '',
        type: info.type || record?.type || '',
        birth: info.birth || '',
        death: info.death || '',
        date: info.date || record?.date || '',
        imgURL: info.imgURL || info.image || '',
        imageCandidates: Array.isArray(record?.imageCandidates) ? record.imageCandidates : [],
        selectedImageCandidateUrl: record?.selectedImageCandidateUrl || '',
        imageCandidatesRejected: Boolean(record?.imageCandidatesRejected),
        manualCandidateText: record?.manualCandidateText || '',
        raw: record
    };
}

function formatImageQueueMeta(record) {
    const parts = [];
    if (record.type) parts.push(record.type);
    if ((record.type === 'theorist' || record.type === 'artist') && (record.birth || record.death)) {
        parts.push(`${record.birth || '?'}–${record.death || ''}`);
    } else if (record.date) {
        parts.push(record.date);
    }
    if (record.id) parts.push(`ID: ${record.id}`);
    if (record.imgURL) parts.push('has image');
    return parts.join(' · ');
}

function buildImageSearchQuery(record) {
    const label = record.label || '';
    const datePart = (record.type === 'theorist' || record.type === 'artist')
        ? [record.birth, record.death].filter(Boolean).join(' ')
        : record.date;

    const hint = (record.type === 'theorist' || record.type === 'artist')
        ? 'portrait'
        : (record.type === 'artworkBook' ? 'book cover' : 'image');

    return [label, datePart, hint].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function parseManualImageCandidateUrls(rawText) {
    const seen = new Set();

    return String(rawText || '')
        .split(/\n+/)
        .map(url => url.trim())
        .filter(Boolean)
        .filter(url => /^https?:\/\//i.test(url))
        .filter(url => {
            if (seen.has(url)) return false;
            seen.add(url);
            return true;
        })
        .slice(0, 5);
}

function renderImageCandidateReview(record) {
    const container = document.createElement('div');
    container.classList.add('image-candidate-review');

    const heading = document.createElement('div');
    heading.classList.add('image-candidate-heading');
    heading.textContent = 'Manual image candidates';
    container.appendChild(heading);

    const help = document.createElement('p');
    help.classList.add('image-candidate-help-text');
    help.textContent = 'Paste up to five image URLs, one per line. This only previews/selects candidates; it does not download, upload, or write to the database.';
    container.appendChild(help);

    const textarea = document.createElement('textarea');
    textarea.classList.add('image-candidate-url-input');
    textarea.placeholder = 'https://example.com/image-1.jpg\nhttps://example.com/image-2.jpg';
    textarea.value = record.manualCandidateText || record.imageCandidates.join('\n');
    textarea.addEventListener('input', () => {
        record.manualCandidateText = textarea.value;
    });
    container.appendChild(textarea);

    const actions = document.createElement('div');
    actions.classList.add('image-candidate-actions');

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.textContent = 'Preview Candidate URLs';
    previewButton.addEventListener('click', () => {
        const urls = parseManualImageCandidateUrls(textarea.value);
        if (!urls.length) {
            alert('Paste at least one valid http/https image URL.');
            return;
        }

        record.manualCandidateText = textarea.value;
        record.imageCandidates = urls;
        record.selectedImageCandidateUrl = urls.includes(record.selectedImageCandidateUrl)
            ? record.selectedImageCandidateUrl
            : '';
        record.imageCandidatesRejected = false;
        renderImageQueue();
    });
    actions.appendChild(previewButton);

    const rejectButton = document.createElement('button');
    rejectButton.type = 'button';
    rejectButton.textContent = 'Reject All';
    rejectButton.addEventListener('click', () => {
        record.selectedImageCandidateUrl = '';
        record.imageCandidatesRejected = true;
        renderImageQueue();
    });
    actions.appendChild(rejectButton);

    container.appendChild(actions);

    const status = document.createElement('div');
    status.classList.add('image-candidate-status');
    if (record.selectedImageCandidateUrl) {
        status.textContent = 'Selected candidate only. No database write yet.';
    } else if (record.imageCandidatesRejected) {
        status.textContent = 'All candidates rejected for this queue session.';
    } else if (record.imageCandidates.length) {
        status.textContent = 'Preview loaded. Choose one candidate or reject all.';
    } else {
        status.textContent = 'No candidates previewed yet.';
    }
    container.appendChild(status);

    if (record.imageCandidates.length) {
        const grid = document.createElement('div');
        grid.classList.add('image-candidate-grid');

        record.imageCandidates.forEach((url, index) => {
            const candidate = document.createElement('div');
            candidate.classList.add('image-candidate-card');
            if (url === record.selectedImageCandidateUrl) {
                candidate.classList.add('selected');
            }

            const image = document.createElement('img');
            image.classList.add('image-candidate-preview-image');
            image.src = url;
            image.alt = `${record.label || 'Record'} candidate ${index + 1}`;
            image.addEventListener('error', () => {
                candidate.classList.add('image-candidate-broken');
            });
            candidate.appendChild(image);

            const candidateActions = document.createElement('div');
            candidateActions.classList.add('image-candidate-card-actions');

            const selectButton = document.createElement('button');
            selectButton.type = 'button';
            selectButton.textContent = url === record.selectedImageCandidateUrl ? 'Selected' : 'Select';
            selectButton.addEventListener('click', () => {
                record.selectedImageCandidateUrl = url;
                record.imageCandidatesRejected = false;
                renderImageQueue();
            });
            candidateActions.appendChild(selectButton);

            const openLink = document.createElement('a');
            openLink.href = url;
            openLink.target = '_blank';
            openLink.rel = 'noopener noreferrer';
            openLink.textContent = 'Open';
            candidateActions.appendChild(openLink);

            candidate.appendChild(candidateActions);

            const urlText = document.createElement('div');
            urlText.classList.add('image-candidate-url-text');
            urlText.textContent = url;
            candidate.appendChild(urlText);

            grid.appendChild(candidate);
        });

        container.appendChild(grid);
    }

    return container;
}

function renderImageQueue() {
    const list = document.getElementById('image-queue-list');
    const count = document.getElementById('image-queue-count');
    const preview = document.getElementById('image-query-preview');

    if (!list || !count) return;

    count.textContent = `${imageQueueRecords.length} / ${IMAGE_QUEUE_LIMIT} queued`;
    list.innerHTML = '';

    if (preview) {
        preview.style.display = 'none';
        preview.innerHTML = '';
    }

    if (!imageQueueRecords.length) {
        list.textContent = 'No records queued yet.';
        return;
    }

    imageQueueRecords.forEach(record => {
        const card = document.createElement('div');
        card.classList.add('image-queue-card');

        if (record.imgURL) {
            const thumb = document.createElement('img');
            thumb.classList.add('image-queue-thumb');
            thumb.src = record.imgURL;
            thumb.alt = record.label || 'Queued record image';
            card.appendChild(thumb);
        } else {
            const placeholder = document.createElement('div');
            placeholder.classList.add('image-queue-thumb-placeholder');
            placeholder.textContent = 'No image';
            card.appendChild(placeholder);
        }

        const details = document.createElement('div');
        const title = document.createElement('div');
        title.classList.add('image-queue-card-title');
        title.textContent = record.label || '(Untitled record)';
        details.appendChild(title);

        if (record.label_jp) {
            const jp = document.createElement('div');
            jp.classList.add('image-queue-card-meta');
            jp.textContent = record.label_jp;
            details.appendChild(jp);
        }

        const meta = document.createElement('div');
        meta.classList.add('image-queue-card-meta');
        meta.textContent = formatImageQueueMeta(record);
        details.appendChild(meta);

        const query = document.createElement('div');
        query.classList.add('image-queue-card-meta');
        query.textContent = `Future query: ${buildImageSearchQuery(record)}`;
        details.appendChild(query);

        details.appendChild(renderImageCandidateReview(record));

        card.appendChild(details);

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.classList.add('image-queue-remove-button');
        removeButton.textContent = 'Remove';
        removeButton.addEventListener('click', () => {
            const index = imageQueueRecords.findIndex(item => item.id === record.id);
            if (index !== -1) imageQueueRecords.splice(index, 1);
            renderImageQueue();
        });
        card.appendChild(removeButton);

        list.appendChild(card);
    });
}

function addRecordToImageQueue(record) {
    const normalisedRecord = normaliseImageQueueRecord(record);
    if (!normalisedRecord.id) {
        alert('This record does not have an id, so it cannot be queued safely.');
        return;
    }

    if (imageQueueRecords.some(item => item.id === normalisedRecord.id)) {
        alert('This record is already in the image queue.');
        return;
    }

    if (imageQueueRecords.length >= IMAGE_QUEUE_LIMIT) {
        alert(`The image queue is limited to ${IMAGE_QUEUE_LIMIT} records.`);
        return;
    }

    imageQueueRecords.push(normalisedRecord);
    renderImageQueue();
}

function renderImageQueueSearchResults(data) {
    const container = document.getElementById('image-queue-search-results');
    if (!container) return;

    container.innerHTML = '';

    if (!Array.isArray(data) || !data.length) {
        container.textContent = 'No matches found.';
        return;
    }

    data.forEach(item => {
        const record = normaliseImageQueueRecord(item);
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('image-queue-result-button');
        button.innerHTML = `<strong>${record.label || '(Untitled record)'}</strong> ${formatImageQueueMeta(record)}`;
        button.disabled = imageQueueRecords.some(queueItem => queueItem.id === record.id);
        button.addEventListener('click', () => {
            addRecordToImageQueue(item);
            button.disabled = true;
        });
        container.appendChild(button);
    });
}

async function searchRecordsForImageQueue() {
    const input = document.getElementById('image-queue-query');
    const query = input?.value.trim();

    if (!query) {
        alert('Please enter a search term.');
        return;
    }

    try {
        const response = await fetch(`${baseURL}/api/reference/label/all/${encodeURIComponent(query)}`);
        const data = await response.json();
        renderImageQueueSearchResults(data);
    } catch (error) {
        console.error('Error searching image queue records:', error);
        alert('Failed to search records for the image queue.');
    }
}

async function fillImageQueueWithRandomPeopleWithoutImages() {
    if (imageQueueRecords.length >= IMAGE_QUEUE_LIMIT) {
        alert(`The image queue is already full (${IMAGE_QUEUE_LIMIT} records).`);
        return;
    }

    const remainingSlots = IMAGE_QUEUE_LIMIT - imageQueueRecords.length;
    const excludedIds = imageQueueRecords.map(record => record.id).filter(Boolean).join(',');
    const url = `${baseURL}/api/reference/image-queue/random-missing-images?limit=${remainingSlots}&types=artist,theorist&exclude=${encodeURIComponent(excludedIds)}`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Random image queue request failed with status ${response.status}`);
        }

        const records = await response.json();
        if (!Array.isArray(records) || !records.length) {
            alert('No matching artist/theorist records without images were found.');
            return;
        }

        records.forEach(addRecordToImageQueue);
        renderImageQueryPreview();
    } catch (error) {
        console.error('Error filling image queue randomly:', error);
        alert('Failed to fill the image queue with random people.');
    }
}

function renderImageQueryPreview() {
    const preview = document.getElementById('image-query-preview');
    if (!preview) return;

    preview.innerHTML = '';

    if (!imageQueueRecords.length) {
        preview.style.display = 'block';
        preview.textContent = 'Queue records before building image search queries.';
        return;
    }

    const heading = document.createElement('h3');
    heading.textContent = 'Image Search Query Preview';
    preview.appendChild(heading);

    const help = document.createElement('p');
    help.textContent = 'These are the queries a future image-candidate fetcher would send to a search API or scraper. No external request is made in this scaffold.';
    preview.appendChild(help);

    const list = document.createElement('ol');
    list.classList.add('image-query-list');

    imageQueueRecords.forEach(record => {
        const item = document.createElement('li');
        const label = document.createElement('div');
        label.textContent = `${record.label || '(Untitled record)'} — ${formatImageQueueMeta(record)}`;
        item.appendChild(label);

        const query = document.createElement('span');
        query.classList.add('image-query-text');
        query.textContent = buildImageSearchQuery(record);
        item.appendChild(query);

        if (record.selectedImageCandidateUrl || record.imageCandidatesRejected) {
            const imageStatus = document.createElement('div');
            imageStatus.classList.add('image-query-selected-candidate');
            imageStatus.textContent = record.selectedImageCandidateUrl
                ? `Selected candidate: ${record.selectedImageCandidateUrl}`
                : 'Candidates rejected for this queue session.';
            item.appendChild(imageStatus);
        }

        list.appendChild(item);
    });

    preview.appendChild(list);
    preview.style.display = 'block';
}

function initialiseImageQueueScaffold() {
    const searchButton = document.getElementById('image-queue-search-button');
    const searchInput = document.getElementById('image-queue-query');
    const buildQueriesButton = document.getElementById('image-queue-build-queries');
    const clearButton = document.getElementById('image-queue-clear');
    const randomPeopleButton = document.getElementById('image-queue-random-people');

    if (searchButton) {
        searchButton.addEventListener('click', searchRecordsForImageQueue);
    }

    if (searchInput) {
        searchInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                searchRecordsForImageQueue();
            }
        });
    }

    if (buildQueriesButton) {
        buildQueriesButton.addEventListener('click', renderImageQueryPreview);
    }

    if (clearButton) {
        clearButton.addEventListener('click', () => {
            imageQueueRecords.splice(0, imageQueueRecords.length);
            renderImageQueue();
        });
    }

    if (randomPeopleButton) {
        randomPeopleButton.addEventListener('click', fillImageQueueWithRandomPeopleWithoutImages);
    }

    renderImageQueue();
}

initialiseImageQueueScaffold();
