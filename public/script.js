// Define the baseURL at the top of your script or before it's used
const baseURL = `${window.location.protocol}//${window.location.host}`;

// Root relationship fields belong at the document root, not inside info.
// Keeping this explicit helps avoid accidental schema drift during manual edits/imports.
const ROOT_RELATIONSHIP_FIELDS = new Set(['parentId', 'children']);
const MULTILINE_INFO_FIELDS = new Set(['note', 'note_jp', 'article']);
const EDIT_IMAGE_FIELDS = ['imgURL', 'imgUrl', 'imageURL', 'imageUrl', 'image_url', 'image'];

function getFirstImageUrl(info = {}) {
    for (const key of EDIT_IMAGE_FIELDS) {
        const value = String(info[key] || '').trim();
        if (value) return value;
    }
    return '';
}

function getMongoObjectIdHex(value) {
    if (typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value)) return value;
    if (value && typeof value === 'object') {
        const oid = value.$oid || value.oid || value.id;
        if (typeof oid === 'string' && /^[a-f0-9]{24}$/i.test(oid)) return oid;
    }
    return '';
}

function getRecordAddedDate(record = {}) {
    const explicitValue = record.createdAt || record.addedAt || record.insertedAt;
    if (explicitValue) {
        const explicitDate = new Date(explicitValue);
        if (!Number.isNaN(explicitDate.getTime())) {
            return { date: explicitDate, source: 'saved timestamp' };
        }
    }

    const objectId = getMongoObjectIdHex(record._id);
    if (objectId) {
        const seconds = Number.parseInt(objectId.slice(0, 8), 16);
        const objectIdDate = new Date(seconds * 1000);
        if (!Number.isNaN(objectIdDate.getTime())) {
            return { date: objectIdDate, source: 'MongoDB insertion timestamp' };
        }
    }

    return null;
}

function formatRecordAddedDate(record = {}) {
    const addedDate = getRecordAddedDate(record);
    if (!addedDate) return 'Not recorded';

    return addedDate.date.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
}

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

function escapeHTML(value = '') {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function getSearchResultFields(item = {}) {
    const info = item.info || {};
    return {
        id: item.id || info.id || '',
        label: item.label || info.label || '',
        labelJp: item.label_jp || info.label_jp || '',
        birth: info.birth || item.birth || '',
        death: info.death || item.death || '',
        date: item.date || info.date || '',
        type: item.type || info.type || '',
        parentLabels: item.parentLabels || []
    };
}

function formatBaseAndJapaneseLabel(label, labelJp) {
    const baseLabel = escapeHTML(label || '(Untitled record)');
    const jpLabel = String(labelJp || '').trim();
    if (!jpLabel || jpLabel === label) return baseLabel;
    return `${baseLabel} <span class="result-label-jp">${escapeHTML(jpLabel)}</span>`;
}

function formatSearchResultLabel(item = {}) {
    const { label, labelJp, birth, death, date, type, parentLabels } = getSearchResultFields(item);
    let formattedLabel = formatBaseAndJapaneseLabel(label, labelJp);

    if (type === 'theorist' || type === 'artist') {
        if (birth && death) {
            formattedLabel += ` <strong>${escapeHTML(birth)}–${escapeHTML(death)}</strong>`;
        } else if (birth && !death) {
            formattedLabel += ` <strong>${escapeHTML(birth)}–</strong>`;
        }
    } else if (type === 'artworkBook') {
        if (parentLabels.length > 0) {
            const firstNonGhost = escapeHTML(parentLabels[0]);
            const coAuthors = parentLabels.slice(1).filter(Boolean).map(escapeHTML);
            formattedLabel = `<strong>${firstNonGhost}`;
            if (coAuthors.length > 0) {
                formattedLabel += ` & ${coAuthors.join(' & ')}`;
            }
            formattedLabel += `</strong>/ ${formatBaseAndJapaneseLabel(label, labelJp)}`;
            if (date) formattedLabel += ` <strong>${escapeHTML(date)}</strong>`;
        } else if (date) {
            formattedLabel += ` <strong>${escapeHTML(date)}</strong>`;
        }
    }

    if (type && type !== 'artworkBook') {
        formattedLabel += ` <span class="result-type-chip">${escapeHTML(type)}</span>`;
    }

    return formattedLabel;
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


// Draft-record bridge for browser capture/import workflows.
// Incoming data can prefill the existing Add Single Record form for human review.
// If the user saves the draft, source metadata is preserved at root-level sourceMeta,
// not mixed into info.
function normaliseDraftRecord(parsedDraft) {
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

        const draftRecord = normaliseDraftRecord(data.draftRecord || data.draft || data);
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
let currentDraftTemplateRecord = null;
let currentDraftSourceFieldMapping = { mappedFields: {}, unmappedFields: {} };
let currentDraftDuplicateCandidates = [];
let currentDraftDuplicateReviewAcknowledged = false;
let currentDraftImageCandidateState = {
    imageUrl: '',
    sourceKey: '',
    status: '',
    error: '',
    download: null,
    cloud: null
};


function clearDraftSourceMetadata() {
    currentDraftRecord = null;
    currentDraftTemplateRecord = null;
    currentDraftSourceFieldMapping = { mappedFields: {}, unmappedFields: {} };
    currentDraftDuplicateCandidates = [];
    currentDraftDuplicateReviewAcknowledged = false;
    currentDraftImageCandidateState = { imageUrl: '', sourceKey: '', status: '', error: '', download: null, cloud: null };
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

function appendReadOnlyRecordMetaRow(container, labelText, value) {
    const row = document.createElement('div');
    row.classList.add('edit-record-meta-row');

    const label = document.createElement('strong');
    label.textContent = labelText;

    const valueElement = document.createElement('code');
    valueElement.textContent = Array.isArray(value)
        ? (value.length ? value.join('\n') : 'None')
        : (String(value || '').trim() || 'None');

    row.appendChild(label);
    row.appendChild(valueElement);
    container.appendChild(row);
}

function appendEditableRelationshipRow(container, labelText, fieldName, values = []) {
    const row = document.createElement('div');
    row.classList.add('edit-record-meta-row');

    const label = document.createElement('strong');
    label.textContent = labelText;

    const input = document.createElement('textarea');
    input.classList.add('edit-record-relationship-input');
    input.dataset.relationshipField = fieldName;
    input.value = Array.isArray(values) ? values.join(', ') : '';
    input.placeholder = 'Comma-separated record IDs';
    input.rows = 3;

    row.appendChild(label);
    row.appendChild(input);
    container.appendChild(row);

    return input;
}

function renderEditRecordMetadata(container, record = {}) {
    const panel = document.createElement('section');
    panel.classList.add('edit-record-meta');

    const heading = document.createElement('h4');
    heading.textContent = 'Record Identity & Relationships';
    panel.appendChild(heading);

    const help = document.createElement('p');
    help.classList.add('draft-source-help-text');
    help.textContent = 'Record ID and added date are read-only. Parent and child IDs can be edited directly; this changes only the current record and does not create reciprocal links automatically.';
    panel.appendChild(help);

    appendReadOnlyRecordMetaRow(panel, 'Record ID', record.id || '');
    const parentIdInput = appendEditableRelationshipRow(panel, 'Parent IDs', 'parentId', Array.isArray(record.parentId) ? record.parentId : []);
    const childrenInput = appendEditableRelationshipRow(panel, 'Child IDs', 'children', Array.isArray(record.children) ? record.children : []);
    appendReadOnlyRecordMetaRow(panel, 'Added to database', formatRecordAddedDate(record));

    container.appendChild(panel);
    return { parentIdInput, childrenInput };
}

function renderEditImagePreview(container, info = {}) {
    const panel = document.createElement('section');
    panel.classList.add('edit-image-preview-panel');

    const heading = document.createElement('h4');
    heading.textContent = 'Image Preview';
    panel.appendChild(heading);

    const image = document.createElement('img');
    image.classList.add('edit-image-preview');
    image.alt = 'Record image preview';

    const status = document.createElement('p');
    status.classList.add('edit-image-preview-status');

    const openLink = document.createElement('a');
    openLink.classList.add('edit-image-preview-link');
    openLink.textContent = 'Open image in new tab';
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';

    panel.appendChild(image);
    panel.appendChild(status);
    panel.appendChild(openLink);
    container.appendChild(panel);

    const update = (rawUrl = '') => {
        const url = String(rawUrl || '').trim();
        image.removeAttribute('src');
        image.style.display = 'none';
        openLink.style.display = 'none';

        if (!url) {
            status.textContent = 'No image URL saved.';
            return;
        }

        status.textContent = 'Loading preview…';
        image.style.display = 'block';
        image.src = url;
        openLink.href = url;
        openLink.style.display = 'inline-block';

        image.onload = () => {
            status.textContent = '';
        };

        image.onerror = () => {
            image.style.display = 'none';
            status.textContent = 'Preview could not be loaded from this URL.';
        };
    };

    update(getFirstImageUrl(info));
    return { update };
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


function isHttpUrl(value = '') {
    return /^https?:\/\//i.test(String(value || '').trim());
}

function hasKanji(text = '') {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(String(text || ''));
}

function getPreferredImageSearchLabel(record = {}) {
    const japaneseLabel = String(record.label_jp || '').trim();
    if (japaneseLabel && hasKanji(japaneseLabel)) {
        return japaneseLabel;
    }
    return String(record.label || '').trim();
}

function looksLikeImageSourceKey(key = '') {
    return /(^|_)(img|image|thumbnail|thumb|photo|picture|poster|cover|ogImage|og:image)(URL|Url|url)?$/i.test(String(key || ''))
        || /image/i.test(String(key || ''));
}

function normaliseDraftImageCandidateUrl(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!isHttpUrl(trimmed)) return '';
    return trimmed;
}

function findImageUrlInObjectByKeys(object = {}, prefix = '') {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return null;

    const priorityKeys = [
        'imgURL', 'imgUrl', 'imageUrl', 'imageURL', 'image_url', 'image',
        'thumbnailUrl', 'thumbnailURL', 'thumbnail', 'ogImage', 'og:image',
        'primaryImage', 'coverImage', 'coverUrl', 'cover_url', 'poster', 'photo'
    ];

    for (const key of priorityKeys) {
        const url = normaliseDraftImageCandidateUrl(object[key]);
        if (url) return { imageUrl: url, sourceKey: prefix ? `${prefix}.${key}` : key };
    }

    for (const [key, value] of Object.entries(object)) {
        if (!looksLikeImageSourceKey(key)) continue;
        const url = normaliseDraftImageCandidateUrl(value);
        if (url) return { imageUrl: url, sourceKey: prefix ? `${prefix}.${key}` : key };
    }

    return null;
}

function getDraftImageCandidate(draftRecord = {}) {
    const candidates = [
        findImageUrlInObjectByKeys(draftRecord.proposedInfo || {}, 'proposedInfo'),
        findImageUrlInObjectByKeys(draftRecord.info || {}, 'info'),
        findImageUrlInObjectByKeys(draftRecord.sourceMeta?.raw || {}, 'sourceMeta.raw'),
        findImageUrlInObjectByKeys(draftRecord.sourceMeta || {}, 'sourceMeta'),
        findImageUrlInObjectByKeys(draftRecord.raw || {}, 'raw')
    ].filter(Boolean);

    return candidates[0] || null;
}

function getDraftSourcePageUrl(draftRecord = {}) {
    const raw = draftRecord.sourceMeta?.raw || {};
    const values = [
        raw.url,
        raw.pageUrl,
        raw.page_url,
        raw.sourcePageUrl,
        raw.canonicalUrl,
        raw.canonical_url,
        raw.href,
        draftRecord.sourceMeta?.url,
        draftRecord.sourceMeta?.sourceUrl
    ];

    return values.map(value => String(value || '').trim()).find(isHttpUrl) || '';
}

function resetDraftImageCandidateState(draftRecord = {}) {
    const candidate = getDraftImageCandidate(draftRecord);
    if (!candidate?.imageUrl) {
        currentDraftImageCandidateState = { imageUrl: '', sourceKey: '', status: '', error: '', download: null, cloud: null };
        return null;
    }

    if (currentDraftImageCandidateState.imageUrl !== candidate.imageUrl) {
        currentDraftImageCandidateState = {
            imageUrl: candidate.imageUrl,
            sourceKey: candidate.sourceKey || '',
            status: '',
            error: '',
            download: null,
            cloud: null
        };
    } else if (candidate.sourceKey && !currentDraftImageCandidateState.sourceKey) {
        currentDraftImageCandidateState.sourceKey = candidate.sourceKey;
    }

    return currentDraftImageCandidateState;
}

function setDraftFormImageUrl(imageUrl = '') {
    const form = document.getElementById('new-record-form');
    const formFields = document.getElementById('form-fields');
    if (!form || !formFields) return false;

    let imageField = form.querySelector('[name="imgURL"]');
    if (!imageField) {
        appendFormField(formFields, 'imgURL', '');
        imageField = form.querySelector('[name="imgURL"]');
    }

    if (!imageField) return false;
    imageField.value = imageUrl;
    imageField.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

function renderDraftImageCandidatePanel(panel, draftRecord = {}) {
    const state = resetDraftImageCandidateState(draftRecord);
    if (!state?.imageUrl) return;

    const section = document.createElement('div');
    section.classList.add('draft-image-candidate-panel');

    const heading = document.createElement('h5');
    heading.textContent = 'Captured image candidate';
    section.appendChild(heading);

    const help = document.createElement('p');
    help.classList.add('draft-source-help-text');
    help.textContent = 'The browser capture supplied an image URL. Preview it, then upload it to cloud storage and set the ImageKit URL in the new-record form if it looks right.';
    section.appendChild(help);

    const previewRow = document.createElement('div');
    previewRow.classList.add('draft-image-candidate-preview-row');

    const previewImage = document.createElement('img');
    previewImage.src = state.cloud?.imgURL || state.download?.previewUrl || state.imageUrl;
    previewImage.alt = getDraftProposedLabel(draftRecord) || 'Captured image candidate';
    previewRow.appendChild(previewImage);

    const details = document.createElement('div');

    const source = document.createElement('p');
    source.classList.add('draft-source-help-text');
    source.textContent = `Source field: ${state.sourceKey || 'unknown'}${state.download?.contentType ? ` · ${state.download.contentType}` : ''}`;
    details.appendChild(source);

    const urlText = document.createElement('p');
    urlText.classList.add('draft-image-candidate-url-text');
    urlText.textContent = state.imageUrl;
    details.appendChild(urlText);

    const status = document.createElement('p');
    status.classList.add('draft-source-help-text');
    if (state.status === 'validating') {
        status.textContent = 'Validating and downloading local preview...';
    } else if (state.status === 'downloaded') {
        status.textContent = 'Local preview is ready. You can now upload to cloud storage and set the form imgURL.';
    } else if (state.status === 'uploading') {
        status.textContent = 'Uploading to Google Cloud Storage and creating ImageKit URL...';
    } else if (state.status === 'saved') {
        status.textContent = 'Cloud image saved and form imgURL set.';
    } else if (state.status === 'error') {
        status.classList.add('browser-capture-status-error');
        status.textContent = `Image preview/save failed: ${state.error || 'Unknown error.'}`;
    } else {
        status.textContent = 'Not yet validated. This will not affect the draft unless you choose to save it.';
    }
    details.appendChild(status);

    const actions = document.createElement('div');
    actions.classList.add('draft-image-candidate-actions');

    const validateButton = document.createElement('button');
    validateButton.type = 'button';
    validateButton.textContent = state.status === 'validating' ? 'Validating...' : 'Preview / Validate Image';
    validateButton.disabled = state.status === 'validating' || state.status === 'uploading';
    validateButton.addEventListener('click', validateDraftImageCandidate);
    actions.appendChild(validateButton);

    if (state.download?.previewUrl) {
        const uploadButton = document.createElement('button');
        uploadButton.type = 'button';
        uploadButton.textContent = state.status === 'uploading' ? 'Uploading...' : 'Upload to Cloud + Set imgURL';
        uploadButton.disabled = state.status === 'uploading';
        uploadButton.addEventListener('click', uploadDraftImageCandidateToCloud);
        actions.appendChild(uploadButton);
    }

    if (state.cloud?.imgURL) {
        const openCloud = document.createElement('a');
        openCloud.href = state.cloud.imgURL;
        openCloud.target = '_blank';
        openCloud.rel = 'noopener noreferrer';
        openCloud.textContent = 'Open ImageKit URL';
        actions.appendChild(openCloud);
    }

    const openOriginal = document.createElement('a');
    openOriginal.href = state.imageUrl;
    openOriginal.target = '_blank';
    openOriginal.rel = 'noopener noreferrer';
    openOriginal.textContent = 'Open original URL';
    actions.appendChild(openOriginal);

    details.appendChild(actions);
    previewRow.appendChild(details);
    section.appendChild(previewRow);
    panel.appendChild(section);
}

function rerenderCurrentDraftMetadata() {
    if (!currentDraftRecord) return;
    renderDraftSourceMetadata(currentDraftRecord, currentDraftTemplateRecord || {});
}

async function validateDraftImageCandidate() {
    if (!currentDraftRecord || !currentDraftImageCandidateState.imageUrl) return;

    currentDraftImageCandidateState.status = 'validating';
    currentDraftImageCandidateState.error = '';
    currentDraftImageCandidateState.download = null;
    currentDraftImageCandidateState.cloud = null;
    rerenderCurrentDraftMetadata();

    try {
        const response = await fetch(`${baseURL}/api/reference/image-queue/validate-image-candidate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageUrl: currentDraftImageCandidateState.imageUrl,
                recordId: 'draft',
                label: getDraftProposedLabel(currentDraftRecord)
            })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(payload?.error || `Draft image validation failed with status ${response.status}.`);
        }

        currentDraftImageCandidateState.download = payload;
        currentDraftImageCandidateState.status = 'downloaded';
        currentDraftImageCandidateState.error = '';
    } catch (error) {
        console.error('Error validating draft image candidate:', error);
        currentDraftImageCandidateState.download = null;
        currentDraftImageCandidateState.status = 'error';
        currentDraftImageCandidateState.error = error.message || String(error);
    }

    rerenderCurrentDraftMetadata();
}

async function uploadDraftImageCandidateToCloud() {
    if (!currentDraftRecord || !currentDraftImageCandidateState.imageUrl || !currentDraftImageCandidateState.download?.previewUrl) return;

    const confirmed = confirm('Upload this captured image to cloud storage and set the ImageKit URL in the new-record form?');
    if (!confirmed) return;

    currentDraftImageCandidateState.status = 'uploading';
    currentDraftImageCandidateState.error = '';
    rerenderCurrentDraftMetadata();

    try {
        const raw = currentDraftRecord.sourceMeta?.raw || {};
        const response = await fetch(`${baseURL}/api/reference/image-queue/upload-local-image-candidate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                label: getDraftProposedLabel(currentDraftRecord),
                type: currentDraftRecord.proposedType || currentDraftRecord.proposedInfo?.type || '',
                selectedImageCandidateUrl: currentDraftImageCandidateState.imageUrl,
                selectedImageCandidateDownload: currentDraftImageCandidateState.download,
                selectedImageCandidateMeta: {
                    provider: 'browser-capture',
                    sourceField: currentDraftImageCandidateState.sourceKey,
                    sourcePageUrl: getDraftSourcePageUrl(currentDraftRecord),
                    title: raw.title || currentDraftRecord.proposedInfo?.label || '',
                    source: currentDraftRecord.sourceMeta?.source || 'browser-capture',
                    query: ''
                }
            })
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            throw new Error(payload?.error || `Draft image cloud upload failed with status ${response.status}.`);
        }

        currentDraftImageCandidateState.cloud = payload;
        currentDraftImageCandidateState.status = 'saved';
        currentDraftImageCandidateState.error = '';
        setDraftFormImageUrl(payload.imgURL || '');
    } catch (error) {
        console.error('Error uploading draft image candidate:', error);
        currentDraftImageCandidateState.cloud = null;
        currentDraftImageCandidateState.status = 'error';
        currentDraftImageCandidateState.error = error.message || String(error);
    }

    rerenderCurrentDraftMetadata();
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
    currentDraftTemplateRecord = templateRecord;
    currentDraftSourceFieldMapping = { mappedFields, unmappedFields };
    const draftImageCandidate = getDraftImageCandidate(draftRecord);

    if (!Object.keys(mappedFields).length && !Object.keys(unmappedFields).length && !duplicateWarnings.length && !hasSourceMetadata && !draftImageCandidate) {
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
    renderDraftImageCandidatePanel(panel, draftRecord);

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

    const persistable = {
        source: sourceMeta.source || 'unknown-draft-source',
        capturedAt: sourceMeta.capturedAt || '',
        acceptedAt: new Date().toISOString(),
        proposedType: draftRecord.proposedType || draftRecord.proposedInfo?.type || savedInfo.type || '',
        mappedFields: currentDraftSourceFieldMapping.mappedFields || {},
        unmappedFields: currentDraftSourceFieldMapping.unmappedFields || {},
        raw,
        note: 'Captured through modifier draft-record prefill bridge. Mapped fields were saved into info; unmapped fields are preserved here for provenance/review.'
    };

    if (currentDraftImageCandidateState.cloud?.imageSource) {
        persistable.imageSource = currentDraftImageCandidateState.cloud.imageSource;
    }

    return persistable;
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
            const { id } = getSearchResultFields(item);
            const optionElement = document.createElement('div');
            optionElement.classList.add('custom-option');
            optionElement.dataset.id = id;
            optionElement.innerHTML = formatSearchResultLabel(item);

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

// Search 1: any record can be selected as the parent.
document.getElementById('query-button-theorist-artist').addEventListener('click', async () => {
    const label = document.getElementById('query-theorist-artist').value.trim();
    if (!label) {
        alert('Please enter a search term.');
        return;
    }

    const response = await fetch(`${baseURL}/api/reference/label/all/${encodeURIComponent(label)}`);
    const data = await response.json();
    renderResults(data, 'result-theorist-artist', false); // One parent.
});

// Search 2: any records can be selected as children.
document.getElementById('query-button-artworkbook').addEventListener('click', async () => {
    const label = document.getElementById('query-artworkbook').value.trim();
    if (!label) {
        alert('Please enter a search term.');
        return;
    }

    const response = await fetch(`${baseURL}/api/reference/label/all/${encodeURIComponent(label)}`);
    const data = await response.json();
    renderResults(data, 'result-artworkbook', true); // One-to-many child selection.
});

// Convenience search retained for the existing artworkBook orphan workflow.
document.getElementById('query-button-orphans').addEventListener('click', async () => {
    const response = await fetch(`${baseURL}/api/reference/orphans`);
    const data = await response.json();
    renderResults(data, 'result-artworkbook', true);
});

// Create reciprocal durable relationships: parent.children and child.parentId.
document.getElementById('confirm-selection').addEventListener('click', async () => {
    const selectedParent = document.querySelector('#result-theorist-artist .custom-option.selected');
    const selectedChildren = document.querySelectorAll('#result-artworkbook .custom-option.selected');

    if (!selectedParent || selectedChildren.length === 0) {
        alert('Please select one parent record and one or more child records.');
        return;
    }

    const parentId = selectedParent.dataset.id;
    const childIds = [...new Set(
        Array.from(selectedChildren)
            .map(child => child.dataset.id)
            .filter(Boolean)
    )];

    if (!parentId || childIds.length === 0) {
        alert('There was an error capturing the selected IDs. Please try again.');
        return;
    }

    if (childIds.includes(parentId)) {
        alert('A record cannot be connected as its own child.');
        return;
    }

    try {
        const response = await fetch(`${baseURL}/api/reference/connect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentId, childIds })
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.message || result.error || 'Relationship update failed.');
        }

        alert(`Connected ${childIds.length} child record${childIds.length === 1 ? '' : 's'} to the selected parent.`);
    } catch (error) {
        console.error('Error connecting records:', error);
        alert(error.message || 'There was an error connecting the selected records.');
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

    const relationshipEditors = renderEditRecordMetadata(editRecord, fullRecord);
    const imagePreview = renderEditImagePreview(editRecord, originalInfo);

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

        if (EDIT_IMAGE_FIELDS.includes(key)) {
            span.addEventListener('input', () => {
                imagePreview.update(span.textContent);
            });
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
            body: JSON.stringify({
                info: updatedInfo,
                parentId: parseRootArrayField(relationshipEditors.parentIdInput.value),
                children: parseRootArrayField(relationshipEditors.childrenInput.value)
            })
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
            const { id } = getSearchResultFields(item);
            const optionElement = document.createElement('div');
            optionElement.classList.add('custom-option');
            optionElement.dataset.id = id;
            optionElement.innerHTML = formatSearchResultLabel(item);

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

    const loadLatestBrowserCaptureButton = document.getElementById('load-latest-browser-capture');

    if (loadLatestBrowserCaptureButton) {
        loadLatestBrowserCaptureButton.addEventListener('click', () => {
            loadLatestBrowserCapture();
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
            const { id, label, labelJp } = getSearchResultFields(item)

            // Create a wrapper div
            const wrapperDiv = document.createElement('div');
            wrapperDiv.classList.add('delete-item-wrapper');

            // Create a checkbox
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = id;

            // Create a label for the record
            const labelElement = document.createElement('label');
            labelElement.textContent = `${label}${labelJp && labelJp !== label ? ` / ${labelJp}` : ''} (ID: ${id})`;

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
const IMAGE_QUEUE_MANUAL_LIMIT = 5;
const IMAGE_QUEUE_BATCH_LIMIT = 50;
const imageQueueRecords = [];
let imageQueueMode = 'manual';

function getImageQueueLimit() {
    return imageQueueMode === 'batch' ? IMAGE_QUEUE_BATCH_LIMIT : IMAGE_QUEUE_MANUAL_LIMIT;
}

function getImageQueueModeLabel() {
    return imageQueueMode === 'batch' ? 'batch mode' : 'manual mode';
}

function setImageQueueMode(mode) {
    imageQueueMode = mode === 'batch' ? 'batch' : 'manual';
}

function resetImageQueueModeIfEmpty() {
    if (!imageQueueRecords.length) {
        setImageQueueMode('manual');
    }
}

function getImageQueueAvailableSlots() {
    return Math.max(0, getImageQueueLimit() - imageQueueRecords.length);
}


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
        imageCandidateDetails: Array.isArray(record?.imageCandidateDetails) ? record.imageCandidateDetails : [],
        selectedImageCandidateUrl: record?.selectedImageCandidateUrl || '',
        selectedImageCandidateDownload: record?.selectedImageCandidateDownload || null,
        selectedImageCandidateCloud: record?.selectedImageCandidateCloud || null,
        imageCandidateFetchStatus: record?.imageCandidateFetchStatus || '',
        imageCandidateFetchError: record?.imageCandidateFetchError || '',
        imageCandidateDownloadStatus: record?.imageCandidateDownloadStatus || '',
        imageCandidateDownloadError: record?.imageCandidateDownloadError || '',
        imageCandidateCloudStatus: record?.imageCandidateCloudStatus || '',
        imageCandidateCloudError: record?.imageCandidateCloudError || '',
        lastImageCandidateQuery: record?.lastImageCandidateQuery || '',
        imageSearchExtraTerms: record?.imageSearchExtraTerms || '',
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
    const label = getPreferredImageSearchLabel(record);
    const usingJapaneseLabel = Boolean(record.label_jp && label === record.label_jp && hasKanji(record.label_jp));
    const datePart = (record.type === 'theorist' || record.type === 'artist')
        ? [record.birth, record.death].filter(Boolean).join(' ')
        : record.date;

    const rawInfo = getImageQueueInfo(record?.raw || record);
    const classificationText = [
        record.type,
        rawInfo.type,
        rawInfo.subtype,
        rawInfo.category,
        rawInfo.medium,
        rawInfo.format,
        rawInfo.genre
    ].filter(Boolean).join(' ').toLowerCase();

    const looksLikePublication = /\b(book|publication|catalogue|catalog|journal|article|essay|text|monograph|chapter|volume)\b/.test(classificationText);
    let hint = (record.type === 'theorist' || record.type === 'artist')
        ? 'portrait'
        : (record.type === 'artworkBook' ? (looksLikePublication ? 'cover image' : 'artwork image') : 'image');

    if (usingJapaneseLabel) {
        hint = (record.type === 'theorist' || record.type === 'artist')
            ? '肖像'
            : (record.type === 'artworkBook' ? (looksLikePublication ? '表紙' : '作品画像') : '画像');
    }

    const extraTerms = String(record?.imageSearchExtraTerms || '').trim();

    return [label, datePart, extraTerms, hint].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function getImageCandidateDetail(record, url) {
    if (!record || !Array.isArray(record.imageCandidateDetails)) return null;
    return record.imageCandidateDetails.find(candidate => candidate.imageUrl === url || candidate.originalUrl === url) || null;
}

function clearImageCandidateFetchState(record) {
    if (!record) return;
    record.imageCandidateFetchStatus = '';
    record.imageCandidateFetchError = '';
}

async function fetchSerpApiImageCandidatesForRecord(record) {
    if (!record) return;

    const query = buildImageSearchQuery(record);
    if (!query) {
        alert('This record does not produce a usable image search query.');
        return;
    }

    record.imageCandidateFetchStatus = 'fetching';
    record.imageCandidateFetchError = '';
    renderImageQueue();

    try {
        const response = await fetch(`${baseURL}/api/reference/image-queue/serpapi-image-candidates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                recordId: record.id,
                label: record.label,
                type: record.type,
                limit: 5
            })
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (jsonError) {
            payload = null;
        }

        if (!response.ok) {
            throw new Error(payload?.error || `SerpApi image search failed with status ${response.status}.`);
        }

        const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
        if (!candidates.length) {
            record.imageCandidates = [];
            record.imageCandidateDetails = [];
            record.selectedImageCandidateUrl = '';
            clearImageCandidateDownloadState(record);
            record.imageCandidateFetchStatus = 'empty';
            record.imageCandidateFetchError = 'No image candidates returned.';
            record.lastImageCandidateQuery = query;
            renderImageQueue();
            return;
        }

        const urls = candidates.map(candidate => candidate.imageUrl).filter(Boolean).slice(0, 5);
        const previousSelection = record.selectedImageCandidateUrl;
        record.imageCandidates = urls;
        record.imageCandidateDetails = candidates.slice(0, 5);
        record.selectedImageCandidateUrl = urls.includes(record.selectedImageCandidateUrl)
            ? record.selectedImageCandidateUrl
            : '';
        if (previousSelection !== record.selectedImageCandidateUrl) {
            clearImageCandidateDownloadState(record);
        }
            record.imageCandidateFetchStatus = 'loaded';
        record.imageCandidateFetchError = '';
        record.lastImageCandidateQuery = payload.query || query;
    } catch (error) {
        console.error('Error fetching SerpApi image candidates:', error);
        record.imageCandidateFetchStatus = 'error';
        record.imageCandidateFetchError = error.message || String(error);
    }

    renderImageQueue();
}

async function fetchSerpApiImageCandidatesForQueue() {
    if (!imageQueueRecords.length) {
        alert('Queue records before fetching image candidates.');
        return;
    }

    if (imageQueueRecords.length > IMAGE_QUEUE_MANUAL_LIMIT) {
        const confirmed = confirm(`Fetch SerpApi candidates for ${imageQueueRecords.length} queued records? This runs sequentially and may take a while.`);
        if (!confirmed) return;
    }

    for (const record of imageQueueRecords) {
        await fetchSerpApiImageCandidatesForRecord(record);
    }
}

function clearImageCandidateDownloadState(record) {
    if (!record) return;
    record.selectedImageCandidateDownload = null;
    record.imageCandidateDownloadStatus = '';
    record.imageCandidateDownloadError = '';
    clearImageCandidateCloudState(record);
}

function clearImageCandidateCloudState(record) {
    if (!record) return;
    record.selectedImageCandidateCloud = null;
    record.imageCandidateCloudStatus = '';
    record.imageCandidateCloudError = '';
}

function renderLocalImageCandidatePreview(downloadInfo) {
    if (!downloadInfo || !downloadInfo.previewUrl) return null;

    const container = document.createElement('div');
    container.classList.add('image-candidate-local-preview');

    const image = document.createElement('img');
    image.src = downloadInfo.previewUrl;
    image.alt = 'Local temp image preview';
    container.appendChild(image);

    const details = document.createElement('div');

    const heading = document.createElement('p');
    heading.innerHTML = '<strong>Local temp preview</strong>';
    details.appendChild(heading);

    const meta = document.createElement('p');
    const size = Number(downloadInfo.sizeBytes || 0);
    const sizeText = size ? `${Math.round(size / 1024)} KB` : 'size unknown';
    meta.textContent = [downloadInfo.contentType, sizeText].filter(Boolean).join(' · ');
    details.appendChild(meta);

    const note = document.createElement('p');
    note.textContent = downloadInfo.note || 'Downloaded for local preview only. No database write yet.';
    details.appendChild(note);

    const openLink = document.createElement('a');
    openLink.href = downloadInfo.previewUrl;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.textContent = 'Open local preview';
    details.appendChild(openLink);

    container.appendChild(details);
    return container;
}

function renderCloudImageCandidateResult(cloudInfo) {
    if (!cloudInfo || !cloudInfo.imgURL) return null;

    const container = document.createElement('div');
    container.classList.add('image-candidate-cloud-result');

    const image = document.createElement('img');
    image.src = cloudInfo.imgURL;
    image.alt = 'Saved ImageKit image preview';
    container.appendChild(image);

    const details = document.createElement('div');

    const heading = document.createElement('p');
    heading.innerHTML = '<strong>Cloud image saved</strong>';
    details.appendChild(heading);

    const objectInfo = document.createElement('p');
    objectInfo.textContent = cloudInfo.gcsObjectName || 'Google Cloud object saved.';
    details.appendChild(objectInfo);

    const openLink = document.createElement('a');
    openLink.href = cloudInfo.imgURL;
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    openLink.textContent = 'Open ImageKit URL';
    details.appendChild(openLink);

    container.appendChild(details);
    return container;
}

async function finaliseSelectedImageCandidate(record, options = {}) {
    if (!record || !record.id) {
        alert('This queued record does not have an id, so it cannot be updated safely.');
        return;
    }

    if (!record.selectedImageCandidateUrl || !record.selectedImageCandidateDownload?.previewUrl) {
        alert('Validate/download a selected candidate before uploading it to cloud storage.');
        return;
    }

    if (!options.skipConfirm) {
        const confirmed = confirm('Upload this selected local preview to Google Cloud Storage and save the ImageKit URL to this record?');
        if (!confirmed) return;
    }

    record.imageCandidateCloudStatus = 'uploading';
    record.imageCandidateCloudError = '';
    record.selectedImageCandidateCloud = null;
    if (!options.suppressRender) renderImageQueue();

    try {
        const response = await fetch(`${baseURL}/api/reference/image-queue/finalise-image-candidate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recordId: record.id,
                label: record.label,
                selectedImageCandidateUrl: record.selectedImageCandidateUrl,
                selectedImageCandidateDownload: record.selectedImageCandidateDownload,
                selectedImageCandidateMeta: getImageCandidateDetail(record, record.selectedImageCandidateUrl)
            })
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (jsonError) {
            payload = null;
        }

        if (!response.ok) {
            throw new Error(payload?.error || `Cloud image finalise failed with status ${response.status}.`);
        }

        record.selectedImageCandidateCloud = payload;
        record.imageCandidateCloudStatus = 'saved';
        record.imageCandidateCloudError = '';
        record.imgURL = payload.imgURL || record.imgURL;
    } catch (error) {
        console.error('Error uploading/saving selected image candidate:', error);
        record.selectedImageCandidateCloud = null;
        record.imageCandidateCloudStatus = 'error';
        record.imageCandidateCloudError = error.message || String(error);
    }

    if (!options.suppressRender) renderImageQueue();
}

async function validateSelectedImageCandidate(record, options = {}) {
    if (!record || !record.selectedImageCandidateUrl) {
        alert('Select an image candidate before validating/downloading.');
        return;
    }

    record.imageCandidateDownloadStatus = 'downloading';
    record.imageCandidateDownloadError = '';
    record.selectedImageCandidateDownload = null;
    if (!options.suppressRender) renderImageQueue();

    try {
        const response = await fetch(`${baseURL}/api/reference/image-queue/validate-image-candidate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageUrl: record.selectedImageCandidateUrl,
                recordId: record.id,
                label: record.label
            })
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (jsonError) {
            payload = null;
        }

        if (!response.ok) {
            throw new Error(payload?.error || `Image candidate validation failed with status ${response.status}.`);
        }

        record.selectedImageCandidateDownload = payload;
        record.imageCandidateDownloadStatus = 'downloaded';
        record.imageCandidateDownloadError = '';
        clearImageCandidateCloudState(record);
    } catch (error) {
        console.error('Error validating/downloading selected image candidate:', error);
        record.selectedImageCandidateDownload = null;
        record.imageCandidateDownloadStatus = 'error';
        record.imageCandidateDownloadError = error.message || String(error);
    }

    if (!options.suppressRender) renderImageQueue();
}

async function saveSelectedImageCandidatesForQueue() {
    const selectedRecords = imageQueueRecords.filter(record => record.selectedImageCandidateUrl && record.id);

    if (!selectedRecords.length) {
        alert('Select one image candidate for at least one queued record before saving.');
        return;
    }

    const confirmed = confirm(`Validate/download and save selected images for ${selectedRecords.length} queued record${selectedRecords.length === 1 ? '' : 's'}?`);
    if (!confirmed) return;

    for (const record of selectedRecords) {
        if (record.imageCandidateCloudStatus === 'saved') continue;

        try {
            if (!record.selectedImageCandidateDownload?.previewUrl) {
                await validateSelectedImageCandidate(record, { suppressRender: true });
            }

            if (record.selectedImageCandidateDownload?.previewUrl) {
                await finaliseSelectedImageCandidate(record, { skipConfirm: true, suppressRender: true });
            }
        } catch (error) {
            console.error('Error saving selected queued image:', error);
            record.imageCandidateCloudStatus = 'error';
            record.imageCandidateCloudError = error.message || String(error);
        }

        renderImageQueue();
    }

    renderImageQueue();
}

function formatImageCandidateDimensions(detail = {}) {
    const width = detail.originalWidth || detail.width || '';
    const height = detail.originalHeight || detail.height || '';
    if (!width || !height) return 'size ?';
    return `${width}×${height}`;
}

function renderImageCandidateReview(record) {
    const container = document.createElement('div');
    container.classList.add('image-candidate-review');

    const heading = document.createElement('div');
    heading.classList.add('image-candidate-heading');
    heading.textContent = 'Candidate review';
    container.appendChild(heading);

    const help = document.createElement('p');
    help.classList.add('image-candidate-help-text');
    help.textContent = 'Select one SerpApi candidate. The queue-level save button will validate/download and upload selected images to storage, then write the ImageKit URL to the database.';
    container.appendChild(help);

    const status = document.createElement('div');
    status.classList.add('image-candidate-status');
    if (record.imageCandidateFetchStatus === 'fetching') {
        status.textContent = `Fetching SerpApi image candidates for: ${buildImageSearchQuery(record)}`;
    } else if (record.imageCandidateFetchStatus === 'loaded') {
        status.textContent = `SerpApi candidates loaded${record.lastImageCandidateQuery ? ` for: ${record.lastImageCandidateQuery}` : ''}.`;
    } else if (record.imageCandidateFetchStatus === 'empty') {
        status.classList.add('image-candidate-download-error');
        status.textContent = `SerpApi returned no candidates${record.lastImageCandidateQuery ? ` for: ${record.lastImageCandidateQuery}` : ''}.`;
    } else if (record.imageCandidateFetchStatus === 'error') {
        status.classList.add('image-candidate-download-error');
        status.textContent = `SerpApi fetch failed: ${record.imageCandidateFetchError || 'Unknown error.'}`;
    } else if (record.imageCandidateCloudStatus === 'uploading') {
        status.textContent = 'Uploading selected local preview to cloud storage and saving ImageKit URL...';
    } else if (record.imageCandidateCloudStatus === 'saved') {
        status.textContent = 'Cloud image saved to this record.';
    } else if (record.imageCandidateCloudStatus === 'error') {
        status.classList.add('image-candidate-download-error');
        status.textContent = `Cloud save failed: ${record.imageCandidateCloudError || 'Unknown error.'}`;
    } else if (record.imageCandidateDownloadStatus === 'downloading') {
        status.textContent = 'Validating and downloading selected image to a local temp preview...';
    } else if (record.imageCandidateDownloadStatus === 'downloaded') {
        status.textContent = 'Selected image downloaded to local temp preview. It can now be saved to cloud/database.';
    } else if (record.imageCandidateDownloadStatus === 'error') {
        status.classList.add('image-candidate-download-error');
        status.textContent = `Download failed: ${record.imageCandidateDownloadError || 'Unknown error.'}`;
    } else if (record.selectedImageCandidateUrl) {
        status.textContent = 'Selected candidate. Use “Save Selected Images to Database” when the queue selections look right.';
    } else if (record.imageCandidates.length) {
        status.textContent = 'Choose one candidate for this record, or leave it unselected to skip it.';
    } else {
        status.textContent = 'No candidates fetched yet.';
    }
    container.appendChild(status);

    const localPreview = renderLocalImageCandidatePreview(record.selectedImageCandidateDownload);
    if (localPreview) container.appendChild(localPreview);

    const cloudResult = renderCloudImageCandidateResult(record.selectedImageCandidateCloud);
    if (cloudResult) container.appendChild(cloudResult);

    if (record.selectedImageCandidateUrl && record.imageCandidateCloudStatus !== 'saved') {
        const selectedActions = document.createElement('div');
        selectedActions.classList.add('image-candidate-actions');

        const clearSelectionButton = document.createElement('button');
        clearSelectionButton.type = 'button';
        clearSelectionButton.textContent = 'Clear Selection';
        clearSelectionButton.addEventListener('click', () => {
            record.selectedImageCandidateUrl = '';
            clearImageCandidateDownloadState(record);
            renderImageQueue();
        });
        selectedActions.appendChild(clearSelectionButton);

        const downloadButton = document.createElement('button');
        downloadButton.type = 'button';
        downloadButton.textContent = record.imageCandidateDownloadStatus === 'downloading'
            ? 'Downloading...'
            : 'Validate Only';
        downloadButton.disabled = record.imageCandidateDownloadStatus === 'downloading';
        downloadButton.addEventListener('click', () => validateSelectedImageCandidate(record));
        selectedActions.appendChild(downloadButton);

        if (record.selectedImageCandidateDownload?.previewUrl) {
            const finaliseButton = document.createElement('button');
            finaliseButton.type = 'button';
            finaliseButton.textContent = record.imageCandidateCloudStatus === 'uploading'
                ? 'Uploading...'
                : 'Save This Image';
            finaliseButton.disabled = record.imageCandidateCloudStatus === 'uploading';
            finaliseButton.addEventListener('click', () => finaliseSelectedImageCandidate(record));
            selectedActions.appendChild(finaliseButton);
        }

        container.appendChild(selectedActions);
    }

    if (record.imageCandidates.length) {
        const grid = document.createElement('div');
        grid.classList.add('image-candidate-grid');

        record.imageCandidates.forEach((url, index) => {
            const detail = getImageCandidateDetail(record, url) || {};
            const isSelected = url === record.selectedImageCandidateUrl;
            const candidate = document.createElement('div');
            candidate.classList.add('image-candidate-card');
            if (isSelected) {
                candidate.classList.add('selected');
            }

            const imageWrap = document.createElement('div');
            imageWrap.classList.add('image-candidate-image-wrap');

            const image = document.createElement('img');
            image.classList.add('image-candidate-preview-image');
            image.src = detail.thumbnailUrl || url;
            image.alt = detail.title || `${record.label || 'Record'} candidate ${index + 1}`;
            image.addEventListener('error', () => {
                candidate.classList.add('image-candidate-broken');
            });
            imageWrap.appendChild(image);

            const dimensions = document.createElement('span');
            dimensions.classList.add('image-candidate-dimensions');
            dimensions.textContent = formatImageCandidateDimensions(detail);
            imageWrap.appendChild(dimensions);
            candidate.appendChild(imageWrap);

            const candidateActions = document.createElement('div');
            candidateActions.classList.add('image-candidate-card-actions');

            const selectButton = document.createElement('button');
            selectButton.type = 'button';
            selectButton.textContent = isSelected ? 'Selected' : 'Select';
            selectButton.addEventListener('click', () => {
                if (record.selectedImageCandidateUrl !== url) {
                    clearImageCandidateDownloadState(record);
                }
                record.selectedImageCandidateUrl = url;
                            renderImageQueue();
            });
            candidateActions.appendChild(selectButton);

            const openLink = document.createElement('a');
            openLink.href = url;
            openLink.target = '_blank';
            openLink.rel = 'noopener noreferrer';
            openLink.textContent = 'Open image';
            candidateActions.appendChild(openLink);

            if (detail.sourcePageUrl) {
                const sourceLink = document.createElement('a');
                sourceLink.href = detail.sourcePageUrl;
                sourceLink.target = '_blank';
                sourceLink.rel = 'noopener noreferrer';
                sourceLink.textContent = 'Source page';
                candidateActions.appendChild(sourceLink);
            }

            candidate.appendChild(candidateActions);

            const urlText = document.createElement('div');
            urlText.classList.add('image-candidate-url-text');
            const bits = [detail.source, detail.title].filter(Boolean);
            urlText.textContent = bits.length ? bits.join(' · ') : url;
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
    const saveSelectedButton = document.getElementById('image-queue-save-selected');
    const fetchSerpApiButton = document.getElementById('image-queue-fetch-serpapi');
    const helpText = document.getElementById('image-queue-help-text');

    if (!list || !count) return;

    const queueLimit = getImageQueueLimit();
    count.textContent = `${imageQueueRecords.length} / ${queueLimit} queued · ${getImageQueueModeLabel()}`;

    if (helpText) {
        helpText.textContent = imageQueueMode === 'batch'
            ? `Batch mode allows up to ${IMAGE_QUEUE_BATCH_LIMIT} queued records. Fetching runs one record at a time, so large batches can take a while; remove anything you do not want before requesting candidates.`
            : `Manual queue mode is capped at ${IMAGE_QUEUE_MANUAL_LIMIT} records for careful review. Batch Records can send a larger controlled set when needed.`;
    }

    if (saveSelectedButton) {
        const selectedCount = imageQueueRecords.filter(record => record.selectedImageCandidateUrl && record.imageCandidateCloudStatus !== 'saved').length;
        saveSelectedButton.disabled = selectedCount === 0;
        saveSelectedButton.textContent = selectedCount
            ? `Save ${selectedCount} Selected Image${selectedCount === 1 ? '' : 's'} to Database`
            : 'Save Selected Images to Database';
    }

    if (fetchSerpApiButton) {
        const isFetching = imageQueueRecords.some(record => record.imageCandidateFetchStatus === 'fetching');
        fetchSerpApiButton.disabled = imageQueueRecords.length === 0 || isFetching;
        fetchSerpApiButton.textContent = isFetching ? 'Fetching SerpApi Candidates...' : 'Fetch SerpApi Image Candidates';
    }

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
        const preferredSearchLabel = getPreferredImageSearchLabel(record);
        const labelSource = preferredSearchLabel === record.label_jp && hasKanji(record.label_jp) ? 'JP label' : 'base label';
        query.textContent = `SerpApi query (${labelSource}): ${buildImageSearchQuery(record)}`;
        details.appendChild(query);

        const queryControls = document.createElement('div');
        queryControls.classList.add('image-queue-query-controls');

        const extraTermsLabel = document.createElement('label');
        extraTermsLabel.textContent = 'Extra SerpApi terms (optional)';
        queryControls.appendChild(extraTermsLabel);

        const extraTermsInput = document.createElement('input');
        extraTermsInput.type = 'text';
        extraTermsInput.classList.add('image-queue-extra-query-input');
        extraTermsInput.placeholder = 'e.g. printmaker, Gutai, university';
        extraTermsInput.value = record.imageSearchExtraTerms || '';
        extraTermsInput.addEventListener('input', event => {
            record.imageSearchExtraTerms = event.target.value;
            query.textContent = `SerpApi query (${labelSource}): ${buildImageSearchQuery(record)}`;
        });
        queryControls.appendChild(extraTermsInput);

        const fetchThisRecordButton = document.createElement('button');
        fetchThisRecordButton.type = 'button';
        fetchThisRecordButton.classList.add('image-queue-fetch-record-button');
        fetchThisRecordButton.textContent = record.imageCandidateFetchStatus === 'fetching'
            ? 'Fetching...'
            : (record.lastImageCandidateQuery ? 'Refetch This Record' : 'Fetch This Record');
        fetchThisRecordButton.disabled = record.imageCandidateFetchStatus === 'fetching';
        fetchThisRecordButton.addEventListener('click', () => fetchSerpApiImageCandidatesForRecord(record));
        queryControls.appendChild(fetchThisRecordButton);

        details.appendChild(queryControls);
        details.appendChild(renderImageCandidateReview(record));

        card.appendChild(details);

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.classList.add('image-queue-remove-button');
        removeButton.textContent = 'Remove';
        removeButton.addEventListener('click', () => {
            const index = imageQueueRecords.findIndex(item => item.id === record.id);
            if (index !== -1) imageQueueRecords.splice(index, 1);
            resetImageQueueModeIfEmpty();
            renderImageQueue();
        });
        card.appendChild(removeButton);

        list.appendChild(card);
    });
}

function addRecordToImageQueue(record, options = {}) {
    if (options.source === 'batch') {
        setImageQueueMode('batch');
    }

    const normalisedRecord = normaliseImageQueueRecord(record);
    if (!normalisedRecord.id) {
        alert('This record does not have an id, so it cannot be queued safely.');
        return;
    }

    if (imageQueueRecords.some(item => item.id === normalisedRecord.id)) {
        alert('This record is already in the image queue.');
        return;
    }

    const queueLimit = getImageQueueLimit();
    if (imageQueueRecords.length >= queueLimit) {
        alert(`The image queue is limited to ${queueLimit} records in ${getImageQueueModeLabel()}.`);
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
    const queueLimit = getImageQueueLimit();
    if (imageQueueRecords.length >= queueLimit) {
        alert(`The image queue is already full (${queueLimit} records in ${getImageQueueModeLabel()}).`);
        return;
    }

    const remainingSlots = queueLimit - imageQueueRecords.length;
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
        renderImageQueue();
    } catch (error) {
        console.error('Error filling image queue randomly:', error);
        alert('Failed to fill the image queue with random people.');
    }
}

function initialiseImageQueueScaffold() {
    const searchButton = document.getElementById('image-queue-search-button');
    const searchInput = document.getElementById('image-queue-query');
    const clearButton = document.getElementById('image-queue-clear');
    const randomPeopleButton = document.getElementById('image-queue-random-people');
    const fetchSerpApiButton = document.getElementById('image-queue-fetch-serpapi');
    const saveSelectedButton = document.getElementById('image-queue-save-selected');

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

    if (clearButton) {
        clearButton.addEventListener('click', () => {
            imageQueueRecords.splice(0, imageQueueRecords.length);
            resetImageQueueModeIfEmpty();
            renderImageQueue();
        });
    }

    if (fetchSerpApiButton) {
        fetchSerpApiButton.addEventListener('click', fetchSerpApiImageCandidatesForQueue);
    }

    if (saveSelectedButton) {
        saveSelectedButton.addEventListener('click', saveSelectedImageCandidatesForQueue);
    }

    if (randomPeopleButton) {
        randomPeopleButton.addEventListener('click', fillImageQueueWithRandomPeopleWithoutImages);
    }

    renderImageQueue();
}

initialiseImageQueueScaffold();



// -----------------------------------------------------------------------------
// Batch Records cluster workbench
// -----------------------------------------------------------------------------
// This screen now has two safe layers:
// 1. editable single-record rows, saved one at a time through the normal update route;
// 2. repeated relationship / field operations that must be previewed before commit.
const BATCH_REFERENCE_SOURCE = 'reference';
const BATCH_CURATION_SOURCE = 'curation';

const batchRecordsState = {
    selectedSource: BATCH_REFERENCE_SOURCE,
    selectedRoot: null,
    records: [],
    selectedIds: new Set(),
    expandedIds: new Set(),
    pendingEdits: new Map(),
    resolvedParent: null,
    previewRows: [],
    fieldPreviewRows: []
};

const BATCH_APPLY_INFO_FIELDS = new Set([
    'type',
    'birth',
    'death',
    'date',
    'imgURL',
    'note',
    'note_jp'
]);

function getBatchRecordInfo(record = {}) {
    return record.info || record || {};
}

function getBatchRecordId(record = {}) {
    return record.id || record.curationId || record.info?.id || '';
}

function getBatchRecordLabel(record = {}) {
    const info = getBatchRecordInfo(record);
    return record.name || info.label || record.label || record.id || record.curationId || '(Untitled record)';
}

function getBatchRecordJapaneseLabel(record = {}) {
    const info = getBatchRecordInfo(record);
    return info.label_jp || record.label_jp || '';
}

function getBatchRecordType(record = {}) {
    const info = getBatchRecordInfo(record);
    return record.source === BATCH_CURATION_SOURCE ? 'curation' : (info.type || record.type || '');
}

function getBatchRecordImageUrl(record = {}) {
    return getFirstImageUrl(getBatchRecordInfo(record));
}

function getBatchImageFieldKey(info = {}) {
    return EDIT_IMAGE_FIELDS.find(key => String(info?.[key] || '').trim()) || 'imgURL';
}

function formatBatchRecordDate(record = {}) {
    const info = getBatchRecordInfo(record);
    const type = getBatchRecordType(record);

    if ((type === 'artist' || type === 'theorist') && (info.birth || info.death)) {
        return `${info.birth || '?'}–${info.death || ''}`;
    }

    return info.date || record.updatedAt || record.createdAt || '[no date]';
}

function getBatchRecordParentIds(record = {}) {
    return Array.isArray(record.parentId) ? record.parentId : [];
}

function getBatchRecordChildIds(record = {}) {
    return Array.isArray(record.children) ? record.children : [];
}

function getBatchSelectedRecords() {
    return batchRecordsState.records.filter(record => batchRecordsState.selectedIds.has(getBatchRecordId(record)));
}

function getBatchSelectedMissingImageRecords() {
    return getBatchSelectedRecords().filter(record => !getBatchRecordImageUrl(record));
}

function getBatchRelationshipOperation() {
    const operation = document.getElementById('batch-operation-select')?.value || 'add-parent';
    return operation === 'add-child' ? 'add-child' : 'add-parent';
}

function getBatchRelationshipOperationConfig(operation = getBatchRelationshipOperation()) {
    if (operation === 'add-child') {
        return {
            operation: 'add-child',
            relatedRole: 'child',
            selectedField: 'children',
            selectedLabel: 'child',
            reciprocalField: 'parentId',
            reciprocalLabel: 'parent',
            endpoint: '/api/reference/batch-records/add-child',
            bodyKey: 'childId',
            previewAction: 'Would add child',
            alreadyPresentAction: 'No change',
            selfSkipAction: 'Skipped: self-child',
            previewButtonLabel: 'Preview Child Add',
            commitButtonLabel: 'Commit Reviewed Child Add',
            resolveButtonLabel: 'Resolve Child',
            inputPlaceholder: 'Paste child ID, or type a child label and resolve'
        };
    }

    return {
        operation: 'add-parent',
        relatedRole: 'parent',
        selectedField: 'parentId',
        selectedLabel: 'parent',
        reciprocalField: 'children',
        reciprocalLabel: 'child',
        endpoint: '/api/reference/batch-records/add-parent',
        bodyKey: 'parentId',
        previewAction: 'Would add parent',
        alreadyPresentAction: 'No change',
        selfSkipAction: 'Skipped: self-parent',
        previewButtonLabel: 'Preview Parent Add',
        commitButtonLabel: 'Commit Reviewed Parent Add',
        resolveButtonLabel: 'Resolve Parent',
        inputPlaceholder: "Paste Guattari's ID, or type Guattari and resolve"
    };
}

function getBatchRelationshipIds(record = {}, field = 'parentId') {
    return field === 'children' ? getBatchRecordChildIds(record) : getBatchRecordParentIds(record);
}

function syncBatchOperationLabels() {
    const config = getBatchRelationshipOperationConfig();
    const resolveButton = document.getElementById('batch-resolve-parent-button');
    const previewButton = document.getElementById('batch-preview-operation-button');
    const commitButton = document.getElementById('batch-commit-operation-button');
    const input = document.getElementById('batch-parent-input');

    if (resolveButton) resolveButton.textContent = config.resolveButtonLabel;
    if (previewButton) previewButton.textContent = config.previewButtonLabel;
    if (commitButton) commitButton.textContent = config.commitButtonLabel;
    if (input) input.placeholder = config.inputPlaceholder;
}

function setBatchClusterStatus(message = '') {
    const status = document.getElementById('batch-cluster-status');
    if (status) status.textContent = message;
}

function updateBatchSelectionControls() {
    const selectedCount = batchRecordsState.selectedIds.size;
    const totalCount = batchRecordsState.records.length;
    const count = document.getElementById('batch-record-count');
    const selectAll = document.getElementById('batch-select-all');
    const clearSelection = document.getElementById('batch-clear-selection');
    const previewButton = document.getElementById('batch-preview-operation-button');
    const commitButton = document.getElementById('batch-commit-operation-button');
    const expandAll = document.getElementById('batch-expand-all');
    const collapseAll = document.getElementById('batch-collapse-all');
    const saveDirty = document.getElementById('batch-save-dirty-records');
    const fieldPreviewButton = document.getElementById('batch-preview-field-apply');
    const fieldCommitButton = document.getElementById('batch-commit-field-apply');
    const sendImageQueueButton = document.getElementById('batch-send-selected-image-queue');

    if (count) {
        count.textContent = totalCount
            ? `${totalCount} record${totalCount === 1 ? '' : 's'} loaded · ${selectedCount} selected`
            : 'No records loaded.';
    }

    if (selectAll) selectAll.disabled = totalCount === 0 || selectedCount === totalCount;
    if (clearSelection) clearSelection.disabled = selectedCount === 0;
    if (expandAll) expandAll.disabled = totalCount === 0 || batchRecordsState.expandedIds.size === totalCount;
    if (collapseAll) collapseAll.disabled = totalCount === 0 || batchRecordsState.expandedIds.size === 0;
    if (saveDirty) {
        const dirtyCount = batchRecordsState.pendingEdits.size;
        saveDirty.disabled = dirtyCount === 0;
        saveDirty.textContent = dirtyCount ? `Save Edited Rows (${dirtyCount})` : 'Save Edited Rows';
    }
    if (fieldPreviewButton) fieldPreviewButton.disabled = selectedCount === 0;
    if (fieldCommitButton) fieldCommitButton.disabled = batchRecordsState.fieldPreviewRows.filter(row => row && row.changed).length === 0;
    if (sendImageQueueButton) {
        const missingImageSelectedCount = getBatchSelectedMissingImageRecords().length;
        sendImageQueueButton.disabled = missingImageSelectedCount === 0;
        sendImageQueueButton.textContent = missingImageSelectedCount
            ? `Send Missing Images to Queue (${missingImageSelectedCount})`
            : 'Send Missing Images to Queue';
    }
    if (previewButton) previewButton.disabled = selectedCount === 0 || !batchRecordsState.resolvedParent;
    if (commitButton) {
        const changedRows = batchRecordsState.previewRows.filter(row => row && !row.alreadyPresent && !row.isSelfRelationship);
        commitButton.disabled = changedRows.length === 0 || !batchRecordsState.resolvedParent;
    }
}

function clearBatchOperationPreview() {
    batchRecordsState.previewRows = [];
    const preview = document.getElementById('batch-operation-preview');
    if (preview) preview.innerHTML = '';
    updateBatchSelectionControls();
}

function clearBatchFieldApplyPreview() {
    batchRecordsState.fieldPreviewRows = [];
    const preview = document.getElementById('batch-field-apply-preview');
    if (preview) preview.innerHTML = '';
    updateBatchSelectionControls();
}

function parseBatchRelationshipInput(value = '') {
    return [...new Set(
        String(value || '')
            .split(/[\n,;]+/)
            .map(item => item.trim())
            .filter(Boolean)
    )];
}

function getBatchRootSource() {
    const selected = document.querySelector('input[name="batch-root-source"]:checked');
    return selected?.value === BATCH_CURATION_SOURCE ? BATCH_CURATION_SOURCE : BATCH_REFERENCE_SOURCE;
}

function syncBatchSourceControls() {
    const source = getBatchRootSource();
    batchRecordsState.selectedSource = source;

    const rootTypeFilter = document.getElementById('batch-root-type-filter');
    const queryInput = document.getElementById('batch-root-query');
    const referenceOnlyControls = document.querySelectorAll('.batch-reference-only-control');

    if (rootTypeFilter) {
        rootTypeFilter.disabled = source === BATCH_CURATION_SOURCE;
        rootTypeFilter.title = source === BATCH_CURATION_SOURCE ? 'Curation search ignores reference type.' : '';
    }

    if (queryInput) {
        queryInput.placeholder = source === BATCH_CURATION_SOURCE
            ? 'Search saved curation name, description, or curation ID...'
            : 'Search paradigm, artist, theorist, book, keyword, or ID...';
    }

    referenceOnlyControls.forEach(control => {
        const disabled = source === BATCH_CURATION_SOURCE;
        control.classList.toggle('batch-control-disabled', disabled);
        control.querySelectorAll('input, select, button').forEach(field => {
            field.disabled = disabled;
            field.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        });
        control.title = disabled ? 'Reference-root scope controls do not apply when loading records from a saved curation.' : '';
    });
}

function resetBatchRootSelection() {
    batchRecordsState.selectedRoot = null;
    batchRecordsState.records = [];
    batchRecordsState.selectedIds.clear();
    batchRecordsState.expandedIds.clear();
    batchRecordsState.pendingEdits.clear();
    batchRecordsState.resolvedParent = null;
    clearBatchOperationPreview();
    clearBatchFieldApplyPreview();
    renderBatchSelectedRoot();
    renderBatchRecordsList();
    renderResolvedBatchParent(null);
}

function renderBatchSelectedRoot() {
    const rootPanel = document.getElementById('batch-selected-root');
    const loadButton = document.getElementById('batch-load-cluster-button');

    if (!rootPanel) return;

    if (!batchRecordsState.selectedRoot) {
        rootPanel.textContent = 'No source selected.';
        if (loadButton) loadButton.disabled = true;
        return;
    }

    const root = batchRecordsState.selectedRoot;
    const label = escapeHTML(getBatchRecordLabel(root));
    const jp = getBatchRecordJapaneseLabel(root);
    const type = getBatchRecordType(root);
    const id = getBatchRecordId(root);
    const sourceLabel = root.source === BATCH_CURATION_SOURCE ? 'saved curation' : 'reference root';
    const countText = root.source === BATCH_CURATION_SOURCE && Number.isFinite(Number(root.includedCount))
        ? ` · ${Number(root.includedCount)} included node${Number(root.includedCount) === 1 ? '' : 's'}`
        : '';

    rootPanel.innerHTML = `<strong>${label}</strong>${jp ? ` <span class="result-label-jp">${escapeHTML(jp)}</span>` : ''}<br><span>${escapeHTML(sourceLabel)} · ${escapeHTML(type || 'unknown type')} · ID: ${escapeHTML(id)}${countText}</span>`;
    if (loadButton) loadButton.disabled = !id;
}

function renderBatchRootResults(data = []) {
    const container = document.getElementById('batch-root-results');
    if (!container) return;

    container.innerHTML = '';

    if (!Array.isArray(data) || !data.length) {
        container.textContent = 'No matches found.';
        return;
    }

    data.slice(0, 40).forEach(item => {
        const id = getBatchRecordId(item);
        const button = document.createElement('button');
        button.type = 'button';
        button.classList.add('batch-root-result-button');
        button.dataset.id = id;

        if (item.source === BATCH_CURATION_SOURCE) {
            const description = String(item.description || '').trim();
            button.innerHTML = `<strong>${escapeHTML(item.name || id)}</strong><br><span>saved curation · ${Number(item.includedCount || 0)} node${Number(item.includedCount || 0) === 1 ? '' : 's'}${description ? ` · ${escapeHTML(description.slice(0, 120))}` : ''}</span>`;
        } else {
            button.innerHTML = formatSearchResultLabel(item);
        }

        button.addEventListener('click', () => {
            batchRecordsState.selectedRoot = item;
            batchRecordsState.records = [];
            batchRecordsState.selectedIds.clear();
            batchRecordsState.expandedIds.clear();
            batchRecordsState.pendingEdits.clear();
            clearBatchFieldApplyPreview();
            document.querySelectorAll('.batch-root-result-button').forEach(result => result.classList.remove('is-selected'));
            button.classList.add('is-selected');
            renderBatchSelectedRoot();
            renderBatchRecordsList();
            clearBatchOperationPreview();
            setBatchClusterStatus('Source selected. Choose filters and load records.');
        });
        container.appendChild(button);
    });
}

async function searchBatchRootRecords() {
    const input = document.getElementById('batch-root-query');
    const query = input?.value.trim();
    const source = getBatchRootSource();
    const rootTypes = source === BATCH_REFERENCE_SOURCE
        ? document.getElementById('batch-root-type-filter')?.value || ''
        : '';

    if (!query) {
        alert('Please enter a source search term.');
        return;
    }

    try {
        setBatchClusterStatus(`Searching ${source === BATCH_CURATION_SOURCE ? 'saved curations' : 'reference roots'}...`);
        const params = new URLSearchParams({ source, query });
        if (rootTypes) params.set('types', rootTypes);

        const response = await fetch(`${baseURL}/api/batch-records/root-search?${params.toString()}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'Root search failed.');
        renderBatchRootResults(data.results || data);
        const count = Array.isArray(data.results) ? data.results.length : Array.isArray(data) ? data.length : 0;
        setBatchClusterStatus(`Found ${count} possible source${count === 1 ? '' : 's'}.`);
    } catch (error) {
        console.error('Error searching batch roots:', error);
        setBatchClusterStatus('Source search failed.');
        alert(`Source search failed: ${error.message}`);
    }
}

async function loadBatchRecordCluster() {
    const rootId = getBatchRecordId(batchRecordsState.selectedRoot);
    if (!rootId) {
        alert('Choose a source first.');
        return;
    }

    const source = batchRecordsState.selectedRoot?.source || getBatchRootSource();
    const depth = document.getElementById('batch-depth-select')?.value || 'recursive';
    const types = document.getElementById('batch-type-filter')?.value || '';
    const includeRoot = source === BATCH_REFERENCE_SOURCE && Boolean(document.getElementById('batch-include-root')?.checked);
    const missingImagesOnly = Boolean(document.getElementById('batch-missing-images-only')?.checked);

    const params = new URLSearchParams({
        missingImagesOnly: missingImagesOnly ? 'true' : 'false'
    });
    if (types) params.set('types', types);

    let url = '';
    if (source === BATCH_CURATION_SOURCE) {
        url = `${baseURL}/api/batch-records/curation-cluster/${encodeURIComponent(rootId)}?${params.toString()}`;
    } else {
        params.set('depth', depth);
        params.set('includeRoot', includeRoot ? 'true' : 'false');
        url = `${baseURL}/api/reference/batch-records/cluster/${encodeURIComponent(rootId)}?${params.toString()}`;
    }

    try {
        setBatchClusterStatus('Loading records...');
        const response = await fetch(url);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'Record load failed.');

        batchRecordsState.records = Array.isArray(data.records) ? data.records : [];
        batchRecordsState.selectedIds.clear();
        batchRecordsState.expandedIds.clear();
        batchRecordsState.pendingEdits.clear();
        clearBatchOperationPreview();
        clearBatchFieldApplyPreview();
        renderBatchRecordsList();

        const missing = data.summary?.missingRelationshipTargets || data.summary?.missingReferenceIds || [];
        const missingText = missing.length ? ` · ${missing.length} missing target${missing.length === 1 ? '' : 's'} ignored` : '';
        const discovered = data.summary?.discoveredCount ?? data.summary?.includedNodeCount ?? batchRecordsState.records.length;
        setBatchClusterStatus(`Loaded ${data.summary?.returnedCount || 0} of ${discovered} record${discovered === 1 ? '' : 's'}${missingText}.`);
    } catch (error) {
        console.error('Error loading batch records:', error);
        setBatchClusterStatus('Record load failed.');
        alert(`Record load failed: ${error.message}`);
    }
}

function createBatchTextInput(name, value = '') {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.value = value || '';
    return input;
}

function createBatchTextarea(name, value = '', rows = 3) {
    const textarea = document.createElement('textarea');
    textarea.name = name;
    textarea.rows = rows;
    textarea.value = value || '';
    return textarea;
}

function createBatchEditField(labelText, field) {
    const label = document.createElement('label');
    label.classList.add('batch-edit-field');
    const labelSpan = document.createElement('span');
    labelSpan.textContent = labelText;
    label.appendChild(labelSpan);
    label.appendChild(field);
    return label;
}

function getBatchPendingPayload(record) {
    const id = getBatchRecordId(record);
    return batchRecordsState.pendingEdits.get(id) || null;
}

function getBatchDraftInfo(record) {
    const pending = getBatchPendingPayload(record);
    return {
        ...getBatchRecordInfo(record),
        ...(pending?.info || {})
    };
}

function getBatchDraftParentIds(record) {
    const pending = getBatchPendingPayload(record);
    return Array.isArray(pending?.parentId) ? pending.parentId : getBatchRecordParentIds(record);
}

function getBatchDraftChildIds(record) {
    const pending = getBatchPendingPayload(record);
    return Array.isArray(pending?.children) ? pending.children : getBatchRecordChildIds(record);
}

function markBatchRecordRowDirty(id, row) {
    if (!id || !row) return;
    const payload = collectBatchRecordRowPayload(row);
    batchRecordsState.pendingEdits.set(id, payload);
    row.classList.add('is-dirty');

    const status = row.querySelector('.batch-record-save-status');
    if (status) status.textContent = 'Edited locally. Save this row or use Save Edited Rows.';

    clearBatchOperationPreview();
    clearBatchFieldApplyPreview();
    updateBatchSelectionControls();
}

function renderBatchRecordEditor(record, row) {
    const id = getBatchRecordId(record);
    const info = getBatchDraftInfo(record);
    const editor = document.createElement('div');
    editor.classList.add('batch-record-editor');

    const imageKey = getBatchImageFieldKey(info);
    editor.appendChild(createBatchEditField('label', createBatchTextInput('info.label', info.label || '')));
    editor.appendChild(createBatchEditField('label_jp', createBatchTextInput('info.label_jp', info.label_jp || '')));
    editor.appendChild(createBatchEditField('type', createBatchTextInput('info.type', info.type || '')));
    editor.appendChild(createBatchEditField('birth', createBatchTextInput('info.birth', info.birth || '')));
    editor.appendChild(createBatchEditField('death', createBatchTextInput('info.death', info.death || '')));
    editor.appendChild(createBatchEditField('date', createBatchTextInput('info.date', info.date || '')));
    editor.appendChild(createBatchEditField(imageKey, createBatchTextInput(`info.${imageKey}`, info[imageKey] || '')));
    editor.appendChild(createBatchEditField('note', createBatchTextarea('info.note', info.note || '', 4)));
    editor.appendChild(createBatchEditField('note_jp', createBatchTextarea('info.note_jp', info.note_jp || '', 4)));
    editor.appendChild(createBatchEditField('parentId', createBatchTextarea('parentId', getBatchDraftParentIds(record).join('\n'), 3)));
    editor.appendChild(createBatchEditField('children', createBatchTextarea('children', getBatchDraftChildIds(record).join('\n'), 3)));

    editor.querySelectorAll('input, textarea').forEach(field => {
        field.addEventListener('input', () => markBatchRecordRowDirty(id, row));
        field.addEventListener('change', () => markBatchRecordRowDirty(id, row));
    });

    const actions = document.createElement('div');
    actions.classList.add('batch-record-editor-actions');

    const status = document.createElement('span');
    status.classList.add('batch-record-save-status');
    status.textContent = batchRecordsState.pendingEdits.has(id)
        ? 'Edited locally. Save this row or use Save Edited Rows.'
        : 'Unsaved changes stay local until you save this row.';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = 'Save this record';
    saveButton.addEventListener('click', () => saveBatchRecordRow(id, row));

    actions.appendChild(status);
    actions.appendChild(saveButton);
    editor.appendChild(actions);

    return editor;
}

function renderBatchRecordsList() {
    const list = document.getElementById('batch-records-list');
    if (!list) return;

    list.innerHTML = '';

    if (!batchRecordsState.records.length) {
        const empty = document.createElement('p');
        empty.textContent = 'No records loaded yet.';
        list.appendChild(empty);
        updateBatchSelectionControls();
        return;
    }

    batchRecordsState.records.forEach(record => {
        const id = getBatchRecordId(record);
        const info = getBatchDraftInfo(record);
        const row = document.createElement('div');
        row.classList.add('batch-record-row');
        if (batchRecordsState.expandedIds.has(id)) row.classList.add('is-expanded');
        if (batchRecordsState.pendingEdits.has(id)) row.classList.add('is-dirty');
        row.dataset.id = id;

        const summary = document.createElement('div');
        summary.classList.add('batch-record-summary');

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = batchRecordsState.selectedIds.has(id);
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) batchRecordsState.selectedIds.add(id);
            else batchRecordsState.selectedIds.delete(id);
            updateBatchSelectionControls();
            clearBatchOperationPreview();
            clearBatchFieldApplyPreview();
        });

        const title = document.createElement('div');
        const jp = getBatchRecordJapaneseLabel(record);
        const draftLabel = info.label || getBatchRecordLabel(record);
        const draftType = info.type || getBatchRecordType(record) || 'unknown';
        const draftDate = ((draftType === 'artist' || draftType === 'theorist') && (info.birth || info.death))
            ? `${info.birth || '?'}–${info.death || ''}`
            : (info.date || formatBatchRecordDate(record));
        title.innerHTML = `<div class="batch-record-title">${escapeHTML(draftLabel)}${jp ? `<span class="batch-record-jp">${escapeHTML(jp)}</span>` : ''}${batchRecordsState.pendingEdits.has(id) ? '<span class="batch-dirty-chip">edited</span>' : ''}</div><div class="batch-record-meta"><span class="batch-record-chip">${escapeHTML(draftType)}</span><span class="batch-record-chip">${escapeHTML(draftDate)}</span><span class="batch-record-chip">depth ${Number(record.depth || 0)}</span></div>`;

        const relations = document.createElement('div');
        const parentLabels = Array.isArray(record.parentLabels) ? record.parentLabels : [];
        const childLabels = Array.isArray(record.childLabels) ? record.childLabels : [];
        relations.classList.add('batch-record-relationships');
        const draftImageUrl = getFirstImageUrl(info);
        relations.innerHTML = `Parents: ${parentLabels.length ? parentLabels.map(escapeHTML).join(', ') : '<em>none</em>'}<br>Children: ${childLabels.length ? childLabels.slice(0, 5).map(escapeHTML).join(', ') : '<em>none</em>'}${childLabels.length > 5 ? ` + ${childLabels.length - 5} more` : ''}<br><span class="${draftImageUrl ? 'batch-record-has-image' : 'batch-record-missing-image'}">${draftImageUrl ? 'has image' : 'missing image'}</span>`;

        const note = document.createElement('div');
        note.classList.add('batch-record-note-preview');
        const noteText = String(info.note || info.note_jp || '').replace(/\s+/g, ' ').trim();
        note.innerHTML = `<code>${escapeHTML(id)}</code><br>${noteText ? escapeHTML(noteText.slice(0, 160)) + (noteText.length > 160 ? '…' : '') : '<em>no note</em>'}`;

        const expandButton = document.createElement('button');
        expandButton.type = 'button';
        expandButton.classList.add('batch-record-expand-button');
        expandButton.textContent = batchRecordsState.expandedIds.has(id) ? 'Collapse' : 'Edit';
        expandButton.addEventListener('click', () => {
            if (batchRecordsState.expandedIds.has(id)) batchRecordsState.expandedIds.delete(id);
            else batchRecordsState.expandedIds.add(id);
            renderBatchRecordsList();
        });

        summary.appendChild(checkbox);
        summary.appendChild(title);
        summary.appendChild(relations);
        summary.appendChild(note);
        summary.appendChild(expandButton);
        row.appendChild(summary);

        if (batchRecordsState.expandedIds.has(id)) {
            row.appendChild(renderBatchRecordEditor(record, row));
        }

        list.appendChild(row);
    });

    updateBatchSelectionControls();
}

function replaceBatchRecordInState(record) {
    const id = getBatchRecordId(record);
    if (!id) return;
    batchRecordsState.records = batchRecordsState.records.map(existing => (
        getBatchRecordId(existing) === id ? record : existing
    ));
}

function collectBatchRecordRowPayload(row) {
    const info = {};
    row.querySelectorAll('[name^="info."]').forEach(field => {
        const key = field.name.slice('info.'.length);
        info[key] = field.value;
    });

    const parentId = parseBatchRelationshipInput(row.querySelector('[name="parentId"]')?.value || '');
    const children = parseBatchRelationshipInput(row.querySelector('[name="children"]')?.value || '');

    return { info, parentId, children };
}

async function putBatchRecordPayload(id, payload) {
    const response = await fetch(`${baseURL}/api/reference/update/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || 'Save failed.');
    return data;
}

async function saveBatchRecordRow(id, row) {
    if (!id || !row) return;

    const saveButton = row.querySelector('.batch-record-editor-actions button');
    const status = row.querySelector('.batch-record-save-status');
    const payload = collectBatchRecordRowPayload(row);

    if (saveButton) saveButton.disabled = true;
    if (status) status.textContent = 'Saving...';

    try {
        const data = await putBatchRecordPayload(id, payload);

        if (data.record) replaceBatchRecordInState(data.record);
        batchRecordsState.pendingEdits.delete(id);
        clearBatchOperationPreview();
        clearBatchFieldApplyPreview();
        renderBatchRecordsList();
        const refreshedRow = document.querySelector(`.batch-record-row[data-id="${CSS.escape(id)}"]`);
        const refreshedStatus = refreshedRow?.querySelector('.batch-record-save-status');
        if (refreshedStatus) refreshedStatus.textContent = data.message || 'Saved.';
    } catch (error) {
        console.error('Error saving batch record row:', error);
        if (status) status.textContent = `Save failed: ${error.message}`;
        alert(`Save failed: ${error.message}`);
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}

async function saveDirtyBatchRecords() {
    const entries = [...batchRecordsState.pendingEdits.entries()].filter(([id]) => id);
    if (!entries.length) return;

    const confirmed = window.confirm(`Save ${entries.length} edited row${entries.length === 1 ? '' : 's'}?

This writes each dirty row to the canonical reference database.`);
    if (!confirmed) return;

    const saveDirtyButton = document.getElementById('batch-save-dirty-records');
    if (saveDirtyButton) saveDirtyButton.disabled = true;
    setBatchClusterStatus(`Saving ${entries.length} edited row${entries.length === 1 ? '' : 's'}...`);

    const failures = [];
    for (const [id, payload] of entries) {
        try {
            const data = await putBatchRecordPayload(id, payload);
            if (data.record) replaceBatchRecordInState(data.record);
            batchRecordsState.pendingEdits.delete(id);
        } catch (error) {
            failures.push({ id, error });
            console.error('Error saving dirty batch row:', id, error);
        }
    }

    clearBatchOperationPreview();
    clearBatchFieldApplyPreview();
    renderBatchRecordsList();

    if (failures.length) {
        setBatchClusterStatus(`Saved ${entries.length - failures.length} row${entries.length - failures.length === 1 ? '' : 's'}; ${failures.length} failed.`);
        alert(`Some rows failed to save:\n${failures.slice(0, 8).map(row => `${row.id}: ${row.error.message}`).join('\n')}`);
    } else {
        setBatchClusterStatus(`Saved ${entries.length} edited row${entries.length === 1 ? '' : 's'}.`);
    }
}

function selectAllBatchRecords() {
    batchRecordsState.records.forEach(record => {
        const id = getBatchRecordId(record);
        if (id) batchRecordsState.selectedIds.add(id);
    });
    renderBatchRecordsList();
    clearBatchOperationPreview();
}

function clearBatchRecordSelection() {
    batchRecordsState.selectedIds.clear();
    renderBatchRecordsList();
    clearBatchOperationPreview();
    clearBatchFieldApplyPreview();
}

function expandAllBatchRecords() {
    batchRecordsState.records.forEach(record => {
        const id = getBatchRecordId(record);
        if (id) batchRecordsState.expandedIds.add(id);
    });
    renderBatchRecordsList();
}

function collapseAllBatchRecords() {
    batchRecordsState.expandedIds.clear();
    renderBatchRecordsList();
}


function getBatchApplyFieldName() {
    const field = document.getElementById('batch-apply-field-select')?.value || '';
    return BATCH_APPLY_INFO_FIELDS.has(field) ? field : '';
}

function getBatchApplyFieldValue() {
    return document.getElementById('batch-apply-field-value')?.value || '';
}

function previewBatchFieldApply() {
    const preview = document.getElementById('batch-field-apply-preview');
    if (!preview) return;

    const field = getBatchApplyFieldName();
    const value = getBatchApplyFieldValue();
    const allowBlank = Boolean(document.getElementById('batch-apply-allow-blank')?.checked);
    const selected = getBatchSelectedRecords();

    if (!field) {
        alert('Choose a supported info field first.');
        return;
    }

    if (!selected.length) {
        alert('Select at least one record first.');
        return;
    }

    if (!value.trim() && !allowBlank) {
        alert('Blank values are blocked unless “allow blank value” is checked.');
        return;
    }

    const rows = selected.map(record => {
        const info = getBatchDraftInfo(record);
        const currentValue = String(info[field] || '');
        const changed = currentValue !== value;
        return { record, field, currentValue, nextValue: value, changed };
    });

    batchRecordsState.fieldPreviewRows = rows;
    preview.innerHTML = '';

    const changedCount = rows.filter(row => row.changed).length;
    const summary = document.createElement('div');
    summary.classList.add('batch-preview-summary');
    summary.innerHTML = `<strong>Preview:</strong> ${changedCount} of ${rows.length} selected record${rows.length === 1 ? '' : 's'} would receive <code>info.${escapeHTML(field)}</code> = <code>${escapeHTML(value || '[blank]')}</code>.`;
    preview.appendChild(summary);

    rows.forEach(row => {
        const item = document.createElement('div');
        item.classList.add('batch-preview-row');
        if (!row.changed) item.classList.add('batch-preview-noop');
        item.innerHTML = `<div><strong>${escapeHTML(getBatchRecordLabel(row.record))}</strong><br><code>${escapeHTML(getBatchRecordId(row.record))}</code></div><div>${row.changed ? 'Would set field' : 'No change'}</div><div><strong>current</strong>: ${escapeHTML(row.currentValue || '[blank]')}<br><strong>next</strong>: ${escapeHTML(row.nextValue || '[blank]')}</div>`;
        preview.appendChild(item);
    });

    updateBatchSelectionControls();
}

async function commitBatchFieldApply() {
    const field = getBatchApplyFieldName();
    const rowsToChange = batchRecordsState.fieldPreviewRows.filter(row => row && row.changed);

    if (!field || !rowsToChange.length) {
        alert('Preview a field-set operation with at least one real change first.');
        return;
    }

    const confirmed = window.confirm(`Commit field set?

Set info.${field} on ${rowsToChange.length} selected record${rowsToChange.length === 1 ? '' : 's'}.`);
    if (!confirmed) return;

    const commitButton = document.getElementById('batch-commit-field-apply');
    if (commitButton) commitButton.disabled = true;
    setBatchClusterStatus(`Applying info.${field} to ${rowsToChange.length} record${rowsToChange.length === 1 ? '' : 's'}...`);

    const failures = [];
    for (const row of rowsToChange) {
        const id = getBatchRecordId(row.record);
        const payload = { info: { [field]: row.nextValue } };
        try {
            const data = await putBatchRecordPayload(id, payload);
            if (data.record) replaceBatchRecordInState(data.record);
            batchRecordsState.pendingEdits.delete(id);
        } catch (error) {
            failures.push({ id, error });
            console.error('Error applying batch field:', id, error);
        }
    }

    clearBatchFieldApplyPreview();
    clearBatchOperationPreview();
    renderBatchRecordsList();

    if (failures.length) {
        setBatchClusterStatus(`Applied field to ${rowsToChange.length - failures.length} record${rowsToChange.length - failures.length === 1 ? '' : 's'}; ${failures.length} failed.`);
        alert(`Some records failed:\n${failures.slice(0, 8).map(row => `${row.id}: ${row.error.message}`).join('\n')}`);
    } else {
        setBatchClusterStatus(`Applied info.${field} to ${rowsToChange.length} record${rowsToChange.length === 1 ? '' : 's'}.`);
    }
}

function renderResolvedBatchParent(record) {
    batchRecordsState.resolvedParent = record || null;
    const container = document.getElementById('batch-parent-resolution');
    const config = getBatchRelationshipOperationConfig();
    if (!container) return;

    if (!record) {
        container.textContent = `No ${config.relatedRole} resolved.`;
        updateBatchSelectionControls();
        return;
    }

    container.innerHTML = `Resolved ${escapeHTML(config.relatedRole)}: <strong>${escapeHTML(getBatchRecordLabel(record))}</strong>${getBatchRecordJapaneseLabel(record) ? ` <span class="result-label-jp">${escapeHTML(getBatchRecordJapaneseLabel(record))}</span>` : ''} · ${escapeHTML(getBatchRecordType(record) || 'unknown type')} · <code>${escapeHTML(getBatchRecordId(record))}</code>`;
    updateBatchSelectionControls();
}

async function fetchBatchParentById(id) {
    const response = await fetch(`${baseURL}/api/reference/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || 'No record found for this ID.');
    return data;
}

async function resolveBatchParent() {
    const input = document.getElementById('batch-parent-input');
    const value = input?.value.trim();
    const container = document.getElementById('batch-parent-resolution');

    if (!value) {
        const config = getBatchRelationshipOperationConfig();
        alert(`Paste a ${config.relatedRole} ID or type a ${config.relatedRole} label to resolve.`);
        return;
    }

    batchRecordsState.resolvedParent = null;
    clearBatchOperationPreview();
    if (container) container.textContent = 'Resolving parent...';

    try {
        if (/^[0-9a-f-]{24,36}$/i.test(value)) {
            const record = await fetchBatchParentById(value);
            renderResolvedBatchParent(record);
            return;
        }

        const params = new URLSearchParams({ source: BATCH_REFERENCE_SOURCE, query: value });
        const response = await fetch(`${baseURL}/api/batch-records/root-search?${params.toString()}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'Parent search failed.');
        const results = Array.isArray(data.results) ? data.results : [];

        if (!results.length) {
            renderResolvedBatchParent(null);
            if (container) container.textContent = `No ${getBatchRelationshipOperationConfig().relatedRole} candidates found.`;
            return;
        }

        if (container) {
            container.innerHTML = `<strong>Choose ${getBatchRelationshipOperationConfig().relatedRole}:</strong>`;
            results.slice(0, 10).forEach(candidate => {
                const button = document.createElement('button');
                button.type = 'button';
                button.classList.add('candidate-result-button');
                button.innerHTML = formatSearchResultLabel(candidate);
                button.addEventListener('click', async () => {
                    try {
                        const fullRecord = await fetchFullRecordForEdit(candidate);
                        renderResolvedBatchParent(fullRecord);
                    } catch (error) {
                        renderResolvedBatchParent(candidate);
                    }
                });
                container.appendChild(button);
            });
        }
    } catch (error) {
        const config = getBatchRelationshipOperationConfig();
        console.error(`Error resolving batch ${config.relatedRole}:`, error);
        renderResolvedBatchParent(null);
        alert(`${config.relatedRole[0].toUpperCase()}${config.relatedRole.slice(1)} resolution failed: ${error.message}`);
    }
}

function previewBatchOperation() {
    const preview = document.getElementById('batch-operation-preview');
    if (!preview) return;

    const config = getBatchRelationshipOperationConfig();
    const relatedRecord = batchRecordsState.resolvedParent;
    const relatedId = getBatchRecordId(relatedRecord);
    const selected = getBatchSelectedRecords();

    if (!relatedId) {
        alert(`Resolve a ${config.relatedRole} first.`);
        return;
    }

    if (!selected.length) {
        alert('Select at least one record first.');
        return;
    }

    const rows = selected.map(record => {
        const currentRelationshipIds = getBatchRelationshipIds(record, config.selectedField);
        const id = getBatchRecordId(record);
        const isSelfRelationship = id === relatedId;
        const alreadyPresent = currentRelationshipIds.includes(relatedId);
        return { record, currentRelationshipIds, alreadyPresent, isSelfRelationship, config };
    });

    batchRecordsState.previewRows = rows;
    const changedCount = rows.filter(row => !row.alreadyPresent && !row.isSelfRelationship).length;
    preview.innerHTML = '';

    const summary = document.createElement('div');
    summary.classList.add('batch-preview-summary');
    summary.innerHTML = `<strong>Preview:</strong> ${changedCount} of ${rows.length} selected record${rows.length === 1 ? '' : 's'} would receive ${escapeHTML(config.selectedLabel)} <code>${escapeHTML(relatedId)}</code>. The related record's ${escapeHTML(config.reciprocalField)} list will also be updated on commit.`;
    preview.appendChild(summary);

    rows.forEach(row => {
        const item = document.createElement('div');
        item.classList.add('batch-preview-row');
        if (row.alreadyPresent || row.isSelfRelationship) item.classList.add('batch-preview-noop');
        const nextRelationshipIds = row.alreadyPresent || row.isSelfRelationship
            ? row.currentRelationshipIds
            : [...row.currentRelationshipIds, relatedId];
        const status = row.isSelfRelationship
            ? config.selfSkipAction
            : row.alreadyPresent
                ? config.alreadyPresentAction
                : config.previewAction;
        item.innerHTML = `<div><strong>${escapeHTML(getBatchRecordLabel(row.record))}</strong><br><code>${escapeHTML(getBatchRecordId(row.record))}</code></div><div>${escapeHTML(status)}</div><div>${escapeHTML(config.selectedField)}: ${nextRelationshipIds.length ? nextRelationshipIds.map(escapeHTML).join(', ') : '<em>none</em>'}</div>`;
        preview.appendChild(item);
    });

    updateBatchSelectionControls();
}

async function commitBatchOperation() {
    const config = getBatchRelationshipOperationConfig();
    const relatedRecord = batchRecordsState.resolvedParent;
    const relatedId = getBatchRecordId(relatedRecord);
    const rowsToChange = batchRecordsState.previewRows.filter(row => row && !row.alreadyPresent && !row.isSelfRelationship);
    const recordIds = rowsToChange.map(row => getBatchRecordId(row.record)).filter(Boolean);

    if (!relatedId || !recordIds.length) {
        alert(`Preview a ${config.selectedLabel}-add operation with at least one real change first.`);
        return;
    }

    const relatedLabel = getBatchRecordLabel(relatedRecord);
    const confirmed = window.confirm(`Commit ${config.selectedLabel} add?\n\nAdd ${relatedLabel} as ${config.selectedLabel} to ${recordIds.length} selected record${recordIds.length === 1 ? '' : 's'} and update the related record's ${config.reciprocalField} list.`);
    if (!confirmed) return;

    const commitButton = document.getElementById('batch-commit-operation-button');
    if (commitButton) commitButton.disabled = true;

    try {
        const response = await fetch(`${baseURL}${config.endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [config.bodyKey]: relatedId, recordIds })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'Batch commit failed.');

        if (Array.isArray(data.updatedRecords)) {
            data.updatedRecords.forEach(record => replaceBatchRecordInState(record));
        }

        clearBatchOperationPreview();
        renderBatchRecordsList();
        setBatchClusterStatus(data.message || `Updated ${data.summary?.changedCount || 0} records.`);
        alert(data.message || `Batch ${config.selectedLabel} add committed.`);
    } catch (error) {
        console.error('Error committing batch operation:', error);
        alert(`Batch commit failed: ${error.message}`);
    } finally {
        updateBatchSelectionControls();
    }
}

function sendSelectedBatchRecordsToImageQueue() {
    const selectedMissingImageRecords = getBatchSelectedMissingImageRecords();

    if (!selectedMissingImageRecords.length) {
        alert('Select at least one loaded record without an image first.');
        return;
    }

    setImageQueueMode('batch');

    const availableSlots = getImageQueueAvailableSlots();
    if (availableSlots === 0) {
        alert(`The image queue is already full (${getImageQueueLimit()} records in ${getImageQueueModeLabel()}). Clear space in the Image Queue screen first.`);
        showContentSection('#section-7');
        return;
    }

    const alreadyQueuedIds = new Set(imageQueueRecords.map(record => record.id).filter(Boolean));
    const recordsToQueue = selectedMissingImageRecords
        .map(record => normaliseImageQueueRecord(record))
        .filter(record => record.id && !alreadyQueuedIds.has(record.id))
        .slice(0, availableSlots);

    if (!recordsToQueue.length) {
        alert('All selected missing-image records are already in the image queue, or could not be queued safely.');
        showContentSection('#section-7');
        return;
    }

    recordsToQueue.forEach(record => {
        imageQueueRecords.push(record);
    });
    renderImageQueue();
    showContentSection('#section-7');

    const skippedBecauseFull = selectedMissingImageRecords.length - recordsToQueue.length;
    const message = skippedBecauseFull > 0
        ? `Queued ${recordsToQueue.length} record${recordsToQueue.length === 1 ? '' : 's'} for image search. ${skippedBecauseFull} selected record${skippedBecauseFull === 1 ? ' was' : 's were'} skipped because of queue limit/duplicates.`
        : `Queued ${recordsToQueue.length} record${recordsToQueue.length === 1 ? '' : 's'} for image search.`;
    setBatchClusterStatus(message);
}


function initialiseBatchRecordsWorkbench() {
    const searchButton = document.getElementById('batch-root-search-button');
    const searchInput = document.getElementById('batch-root-query');
    const loadButton = document.getElementById('batch-load-cluster-button');
    const selectAllButton = document.getElementById('batch-select-all');
    const clearSelectionButton = document.getElementById('batch-clear-selection');
    const expandAllButton = document.getElementById('batch-expand-all');
    const collapseAllButton = document.getElementById('batch-collapse-all');
    const saveDirtyButton = document.getElementById('batch-save-dirty-records');
    const fieldValue = document.getElementById('batch-apply-field-value');
    const fieldSelect = document.getElementById('batch-apply-field-select');
    const fieldAllowBlank = document.getElementById('batch-apply-allow-blank');
    const fieldPreviewButton = document.getElementById('batch-preview-field-apply');
    const fieldCommitButton = document.getElementById('batch-commit-field-apply');
    const sendImageQueueButton = document.getElementById('batch-send-selected-image-queue');
    const operationSelect = document.getElementById('batch-operation-select');
    const resolveParentButton = document.getElementById('batch-resolve-parent-button');
    const parentInput = document.getElementById('batch-parent-input');
    const previewButton = document.getElementById('batch-preview-operation-button');
    const commitButton = document.getElementById('batch-commit-operation-button');

    document.querySelectorAll('input[name="batch-root-source"]').forEach(input => {
        input.addEventListener('change', () => {
            syncBatchSourceControls();
            resetBatchRootSelection();
            const results = document.getElementById('batch-root-results');
            if (results) results.innerHTML = '';
            setBatchClusterStatus('Source changed. Search again.');
        });
    });

    if (searchButton) searchButton.addEventListener('click', searchBatchRootRecords);
    if (searchInput) {
        searchInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                searchBatchRootRecords();
            }
        });
    }
    if (loadButton) loadButton.addEventListener('click', loadBatchRecordCluster);
    if (selectAllButton) selectAllButton.addEventListener('click', selectAllBatchRecords);
    if (clearSelectionButton) clearSelectionButton.addEventListener('click', clearBatchRecordSelection);
    if (expandAllButton) expandAllButton.addEventListener('click', expandAllBatchRecords);
    if (collapseAllButton) collapseAllButton.addEventListener('click', collapseAllBatchRecords);
    if (saveDirtyButton) saveDirtyButton.addEventListener('click', saveDirtyBatchRecords);
    if (sendImageQueueButton) sendImageQueueButton.addEventListener('click', sendSelectedBatchRecordsToImageQueue);
    if (fieldPreviewButton) fieldPreviewButton.addEventListener('click', previewBatchFieldApply);
    if (fieldCommitButton) fieldCommitButton.addEventListener('click', commitBatchFieldApply);
    if (fieldValue) fieldValue.addEventListener('input', clearBatchFieldApplyPreview);
    if (fieldSelect) fieldSelect.addEventListener('change', clearBatchFieldApplyPreview);
    if (fieldAllowBlank) fieldAllowBlank.addEventListener('change', clearBatchFieldApplyPreview);
    if (operationSelect) {
        operationSelect.addEventListener('change', () => {
            batchRecordsState.resolvedParent = null;
            const container = document.getElementById('batch-parent-resolution');
            if (container) container.textContent = 'Relationship operation changed; resolve the related record again.';
            clearBatchOperationPreview();
            syncBatchOperationLabels();
            updateBatchSelectionControls();
        });
    }
    if (resolveParentButton) resolveParentButton.addEventListener('click', resolveBatchParent);
    if (parentInput) {
        parentInput.addEventListener('input', () => {
            batchRecordsState.resolvedParent = null;
            const container = document.getElementById('batch-parent-resolution');
            if (container) container.textContent = 'Related record changed; resolve again before previewing.';
            clearBatchOperationPreview();
            updateBatchSelectionControls();
        });
        parentInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                resolveBatchParent();
            }
        });
    }
    if (previewButton) previewButton.addEventListener('click', previewBatchOperation);
    if (commitButton) commitButton.addEventListener('click', commitBatchOperation);

    syncBatchSourceControls();
    syncBatchOperationLabels();
    renderBatchSelectedRoot();
    renderBatchRecordsList();
    renderResolvedBatchParent(null);
}

initialiseBatchRecordsWorkbench();

// -----------------------------------------------------------------------------
// CSV import review
// -----------------------------------------------------------------------------

const CSV_IMPORT_MAX_ROWS = 500;

const csvImportState = {
    fileName: '',
    candidates: [],
    previewed: false,
    busy: false
};

function parseCsvText(text = '') {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (inQuotes) {
            if (char === '"' && next === '"') {
                field += '"';
                index += 1;
            } else if (char === '"') {
                inQuotes = false;
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
        } else if (char === ',') {
            row.push(field);
            field = '';
        } else if (char === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (char !== '\r') {
            field += char;
        }
    }

    row.push(field);
    if (row.some(value => value !== '') || rows.length === 0) rows.push(row);
    return rows;
}

function normaliseCsvHeader(header = '') {
    return String(header || '').replace(/^\uFEFF/, '').trim();
}

function splitCsvRelationshipValues(value = '') {
    return [...new Set(
        String(value || '')
            .split(/[;|]/)
            .map(item => item.trim())
            .filter(Boolean)
    )];
}

function csvControlFieldKind(header = '') {
    const key = String(header || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

    if (['id', 'uuid', 'record_id', 'recordid'].includes(key)) return 'incomingId';
    if (['parent', 'parents', 'parent_label', 'parent_labels', 'parentlabel', 'parentlabels', 'author', 'authors', 'creator', 'creators'].includes(key)) return 'parentLabels';
    if (['parent_id', 'parent_ids', 'parentid', 'parentids'].includes(key)) return 'parentIds';
    if (['child', 'children', 'child_label', 'child_labels', 'childlabel', 'childlabels'].includes(key)) return 'childLabels';
    if (['child_id', 'child_ids', 'childid', 'childids', 'children_id', 'children_ids', 'childrenid', 'childrenids'].includes(key)) return 'childIds';
    return '';
}

function csvRowsToCandidates(rows = []) {
    if (!rows.length) return [];

    const headers = rows[0].map(normaliseCsvHeader);
    const nonEmptyHeaders = headers.filter(Boolean);
    if (!nonEmptyHeaders.length) throw new Error('CSV has no header row.');

    return rows.slice(1).map((cells, index) => {
        const info = {};
        const parentLabels = [];
        const parentIds = [];
        const childLabels = [];
        const childIds = [];
        let incomingId = '';

        headers.forEach((header, columnIndex) => {
            if (!header) return;
            const value = String(cells[columnIndex] ?? '').trim();
            if (!value) return;

            const controlKind = csvControlFieldKind(header);
            if (controlKind === 'incomingId') {
                incomingId = value;
            } else if (controlKind === 'parentLabels') {
                parentLabels.push(...splitCsvRelationshipValues(value));
            } else if (controlKind === 'parentIds') {
                parentIds.push(...splitCsvRelationshipValues(value));
            } else if (controlKind === 'childLabels') {
                childLabels.push(...splitCsvRelationshipValues(value));
            } else if (controlKind === 'childIds') {
                childIds.push(...splitCsvRelationshipValues(value));
            } else {
                info[header] = value;
            }
        });

        const uniqueParentLabels = [...new Set(parentLabels)];
        const uniqueParentIds = [...new Set(parentIds)];
        const uniqueChildLabels = [...new Set(childLabels)];
        const uniqueChildIds = [...new Set(childIds)];
        const hasLabel = Boolean(String(info.label || '').trim() || String(info.label_jp || '').trim());

        return {
            candidateKey: `csv-row-${index + 2}`,
            rowNumber: index + 2,
            incomingId,
            info,
            parentLabels: uniqueParentLabels,
            parentIds: uniqueParentIds,
            childLabels: uniqueChildLabels,
            childIds: uniqueChildIds,
            duplicateCandidates: [],
            parentMatches: {},
            childMatches: {},
            parentSelections: {},
            childSelections: {},
            decision: hasLabel ? 'create' : 'skip',
            mergeTargetId: '',
            parseWarning: hasLabel ? '' : 'No label or label_jp found; row defaults to skip.'
        };
    }).filter(candidate => Object.keys(candidate.info).length || candidate.parentLabels.length || candidate.parentIds.length || candidate.childLabels.length || candidate.childIds.length);
}

function csvNormaliseComparableLabel(value = '') {
    return String(value || '')
        .normalize('NFKC')
        .replace(/[’'`]/g, '')
        .replace(/[-–—_:;,.!?/\\|"“”‘’()（）]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function csvAppendUniqueText(existing = '', incoming = '') {
    const oldText = String(existing || '').trim();
    const newText = String(incoming || '').trim();
    if (!newText) return oldText;
    if (!oldText) return newText;
    if (oldText.includes(newText)) return oldText;
    if (newText.includes(oldText)) return newText;
    return `${oldText}\n\n${newText}`;
}

function buildCsvMergePreview(existingInfo = {}, incomingInfo = {}) {
    const preferredExisting = new Set(['label', 'label_jp', 'birth', 'death']);
    const appendFields = new Set(['note', 'note_jp', 'article']);
    const keys = [...new Set([...Object.keys(existingInfo || {}), ...Object.keys(incomingInfo || {})])];
    const merged = {};

    keys.forEach(key => {
        const existing = existingInfo?.[key];
        const incoming = incomingInfo?.[key];
        const hasExisting = existing !== undefined && existing !== null && String(existing).trim() !== '';
        const hasIncoming = incoming !== undefined && incoming !== null && String(incoming).trim() !== '';

        if (appendFields.has(key)) {
            merged[key] = csvAppendUniqueText(existing, incoming);
        } else if (preferredExisting.has(key)) {
            merged[key] = hasExisting ? existing : incoming;
        } else {
            merged[key] = hasExisting ? existing : incoming;
        }

        if (merged[key] === undefined) delete merged[key];
    });

    return merged;
}

function csvCandidateDisplayLabel(candidate = {}) {
    return candidate.info?.label || candidate.info?.label_jp || `(row ${candidate.rowNumber})`;
}

function csvExistingCandidateLabel(candidate = {}) {
    const info = candidate.info || {};
    const jp = info.label_jp ? ` / ${info.label_jp}` : '';
    const type = info.type ? ` [${info.type}]` : '';
    const exact = candidate.exactMatch ? ' — exact label match' : '';
    return `${info.label || info.label_jp || '(untitled)'}${jp}${type}${exact}`;
}

function csvFindBatchRelationshipOptions(parentLabel, currentKey) {
    const wanted = csvNormaliseComparableLabel(parentLabel);
    if (!wanted) return [];

    return csvImportState.candidates.filter(candidate => {
        if (candidate.candidateKey === currentKey) return false;
        const labels = [candidate.info?.label, candidate.info?.label_jp]
            .filter(Boolean)
            .map(csvNormaliseComparableLabel);
        return labels.includes(wanted);
    });
}

function createCsvFieldsList(info = {}) {
    const list = document.createElement('ul');
    list.classList.add('csv-import-fields');
    Object.entries(info).forEach(([key, value]) => {
        const item = document.createElement('li');
        const keyNode = document.createElement('strong');
        keyNode.textContent = key;
        const valueNode = document.createElement('span');
        valueNode.textContent = String(value ?? '');
        item.appendChild(keyNode);
        item.appendChild(valueNode);
        list.appendChild(item);
    });
    return list;
}

function getCsvImportCandidateByKey(candidateKey) {
    return csvImportState.candidates.find(candidate => candidate.candidateKey === candidateKey);
}

function getCsvRelationshipReviewIssues() {
    const issues = [];
    const activeCandidates = csvImportState.candidates.filter(candidate => candidate.decision !== 'skip');

    const inspectSelections = (candidate, labels = [], selections = {}, kind = 'relationship') => {
        labels.forEach(label => {
            const resolution = String(selections?.[label] || '').trim();
            if (!resolution) {
                issues.push({
                    candidateKey: candidate.candidateKey,
                    rowNumber: candidate.rowNumber,
                    kind,
                    label,
                    reason: 'unresolved'
                });
                return;
            }

            if (resolution === 'none' || resolution.startsWith('existing:')) return;

            if (resolution.startsWith('batch:')) {
                const targetKey = resolution.slice('batch:'.length);
                const target = getCsvImportCandidateByKey(targetKey);
                if (!target || target.decision === 'skip') {
                    issues.push({
                        candidateKey: candidate.candidateKey,
                        rowNumber: candidate.rowNumber,
                        kind,
                        label,
                        reason: 'batch-target-skipped-or-missing'
                    });
                }
                return;
            }

            issues.push({
                candidateKey: candidate.candidateKey,
                rowNumber: candidate.rowNumber,
                kind,
                label,
                reason: 'invalid-resolution'
            });
        });
    };

    activeCandidates.forEach(candidate => {
        inspectSelections(candidate, candidate.parentLabels, candidate.parentSelections, 'parent');
        inspectSelections(candidate, candidate.childLabels, candidate.childSelections, 'child');
    });

    return issues;
}

function updateCsvImportCommitAvailability() {
    const commitButton = document.getElementById('csv-import-commit');
    const status = document.getElementById('csv-import-commit-status');
    if (!commitButton || !status) return;

    const active = csvImportState.candidates.filter(candidate => candidate.decision !== 'skip');
    const unresolvedDuplicates = active.filter(candidate => candidate.decision === 'review' || (candidate.decision === 'merge' && !candidate.mergeTargetId));
    const unresolvedRelationships = getCsvRelationshipReviewIssues();

    commitButton.disabled = csvImportState.busy
        || !csvImportState.previewed
        || active.length === 0
        || unresolvedDuplicates.length > 0
        || unresolvedRelationships.length > 0;

    if (!csvImportState.previewed) {
        status.textContent = 'Parse and check the CSV first.';
    } else if (unresolvedDuplicates.length) {
        status.textContent = `${unresolvedDuplicates.length} row${unresolvedDuplicates.length === 1 ? '' : 's'} still need a duplicate decision.`;
    } else if (unresolvedRelationships.length) {
        status.textContent = `${unresolvedRelationships.length} parent/child relationship${unresolvedRelationships.length === 1 ? '' : 's'} still need explicit resolution or “no attachment” confirmation.`;
    } else {
        status.textContent = `${active.length} row${active.length === 1 ? '' : 's'} ready to commit; ${csvImportState.candidates.length - active.length} skipped.`;
    }
}

function renderCsvImportCandidate(candidate) {
    const card = document.createElement('article');
    card.classList.add('csv-import-card');
    if (candidate.decision === 'review') card.classList.add('csv-import-needs-review');
    else if (candidate.decision === 'skip') card.classList.add('csv-import-skip');
    else card.classList.add('csv-import-ready');

    const header = document.createElement('div');
    header.classList.add('csv-import-card-header');
    const title = document.createElement('h3');
    title.textContent = csvCandidateDisplayLabel(candidate);
    const meta = document.createElement('span');
    meta.classList.add('csv-import-row-meta');
    meta.textContent = `CSV row ${candidate.rowNumber}${candidate.info?.type ? ` · ${candidate.info.type}` : ''}`;
    header.appendChild(title);
    header.appendChild(meta);
    card.appendChild(header);

    if (candidate.parseWarning) {
        const warning = document.createElement('div');
        warning.classList.add('csv-import-warning');
        warning.textContent = candidate.parseWarning;
        card.appendChild(warning);
    }

    const grid = document.createElement('div');
    grid.classList.add('csv-import-grid');

    const incomingPanel = document.createElement('section');
    incomingPanel.classList.add('csv-import-panel');
    const incomingHeading = document.createElement('h4');
    incomingHeading.textContent = 'Incoming fields';
    incomingPanel.appendChild(incomingHeading);
    incomingPanel.appendChild(createCsvFieldsList(candidate.info));
    grid.appendChild(incomingPanel);

    const reviewPanel = document.createElement('section');
    reviewPanel.classList.add('csv-import-panel');
    const reviewHeading = document.createElement('h4');
    reviewHeading.textContent = 'Duplicate decision';
    reviewPanel.appendChild(reviewHeading);

    const decisionRow = document.createElement('div');
    decisionRow.classList.add('csv-import-decision-row');
    const decisionLabel = document.createElement('label');
    decisionLabel.textContent = 'Action';
    const decisionSelect = document.createElement('select');
    [
        ['review', 'Needs review'],
        ['create', 'Not a duplicate — create new'],
        ['merge', 'Duplicate — merge into existing'],
        ['skip', 'Skip this row']
    ].forEach(([value, text]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        option.selected = candidate.decision === value;
        decisionSelect.appendChild(option);
    });
    decisionSelect.addEventListener('change', () => {
        candidate.decision = decisionSelect.value;
        if (candidate.decision !== 'merge') candidate.mergeTargetId = '';
        renderCsvImportCandidates();
    });
    decisionRow.appendChild(decisionLabel);
    decisionRow.appendChild(decisionSelect);
    reviewPanel.appendChild(decisionRow);

    const duplicateList = document.createElement('div');
    duplicateList.classList.add('csv-import-duplicate-list');
    if (!candidate.duplicateCandidates.length) {
        const noMatch = document.createElement('p');
        noMatch.textContent = 'No plausible existing record found.';
        duplicateList.appendChild(noMatch);
    } else {
        candidate.duplicateCandidates.forEach(existing => {
            const optionLabel = document.createElement('label');
            optionLabel.classList.add('csv-import-duplicate-option');
            if (existing.exactMatch) optionLabel.classList.add('exact-match');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = `csv-merge-${candidate.candidateKey}`;
            radio.value = existing.id;
            radio.checked = candidate.mergeTargetId === existing.id;
            radio.addEventListener('change', () => {
                candidate.mergeTargetId = existing.id;
                candidate.decision = 'merge';
                renderCsvImportCandidates();
            });
            const text = document.createElement('span');
            text.textContent = csvExistingCandidateLabel(existing);
            optionLabel.appendChild(radio);
            optionLabel.appendChild(text);
            duplicateList.appendChild(optionLabel);
        });
    }
    reviewPanel.appendChild(duplicateList);

    if (candidate.decision === 'merge' && candidate.mergeTargetId) {
        const target = candidate.duplicateCandidates.find(existing => existing.id === candidate.mergeTargetId);
        if (target) {
            const preview = document.createElement('div');
            preview.classList.add('csv-import-merge-preview');
            const previewHeading = document.createElement('strong');
            previewHeading.textContent = 'Merge preview (existing values preserved; new notes appended)';
            preview.appendChild(previewHeading);
            preview.appendChild(createCsvFieldsList(buildCsvMergePreview(target.info || {}, candidate.info || {})));
            reviewPanel.appendChild(preview);
        }
    }

    grid.appendChild(reviewPanel);
    card.appendChild(grid);

    if (candidate.parentLabels.length || candidate.parentIds.length) {
        const parentsPanel = document.createElement('section');
        parentsPanel.classList.add('csv-import-panel');
        parentsPanel.style.marginTop = '12px';
        const parentsHeading = document.createElement('h4');
        parentsHeading.textContent = 'Parent matching';
        parentsPanel.appendChild(parentsHeading);

        if (candidate.parentIds.length) {
            const explicit = document.createElement('p');
            explicit.textContent = `Explicit parent IDs from CSV: ${candidate.parentIds.join(', ')}`;
            parentsPanel.appendChild(explicit);
        }

        const parentList = document.createElement('div');
        parentList.classList.add('csv-import-parent-list');
        candidate.parentLabels.forEach(parentLabel => {
            const item = document.createElement('div');
            item.classList.add('csv-import-parent-item');
            const labelNode = document.createElement('span');
            labelNode.textContent = parentLabel;
            const select = document.createElement('select');
            select.classList.add('csv-import-parent-select');

            const unresolvedOption = document.createElement('option');
            unresolvedOption.value = '';
            unresolvedOption.textContent = 'Choose parent resolution…';
            select.appendChild(unresolvedOption);

            const none = document.createElement('option');
            none.value = 'none';
            none.textContent = 'No parent attachment — confirmed';
            select.appendChild(none);

            const batchOptions = csvFindBatchRelationshipOptions(parentLabel, candidate.candidateKey);
            batchOptions.forEach(batchCandidate => {
                const option = document.createElement('option');
                option.value = `batch:${batchCandidate.candidateKey}`;
                option.textContent = `CSV row ${batchCandidate.rowNumber}: ${csvCandidateDisplayLabel(batchCandidate)}`;
                select.appendChild(option);
            });

            (candidate.parentMatches[parentLabel] || []).forEach(existing => {
                const option = document.createElement('option');
                option.value = `existing:${existing.id}`;
                option.textContent = `Existing: ${csvExistingCandidateLabel(existing)}`;
                select.appendChild(option);
            });

            const selected = candidate.parentSelections[parentLabel] || '';
            select.value = selected;
            select.addEventListener('change', () => {
                candidate.parentSelections[parentLabel] = select.value;
                updateCsvImportCommitAvailability();
            });

            item.appendChild(labelNode);
            item.appendChild(select);
            parentList.appendChild(item);
        });
        parentsPanel.appendChild(parentList);
        card.appendChild(parentsPanel);
    }

    if (candidate.childLabels.length || candidate.childIds.length) {
        const childrenPanel = document.createElement('section');
        childrenPanel.classList.add('csv-import-panel');
        childrenPanel.style.marginTop = '12px';
        const childrenHeading = document.createElement('h4');
        childrenHeading.textContent = 'Child matching';
        childrenPanel.appendChild(childrenHeading);

        if (candidate.childIds.length) {
            const explicit = document.createElement('p');
            explicit.textContent = `Explicit child IDs from CSV: ${candidate.childIds.join(', ')}`;
            childrenPanel.appendChild(explicit);
        }

        const childList = document.createElement('div');
        childList.classList.add('csv-import-parent-list');
        candidate.childLabels.forEach(childLabel => {
            const item = document.createElement('div');
            item.classList.add('csv-import-parent-item');
            const labelNode = document.createElement('span');
            labelNode.textContent = childLabel;
            const select = document.createElement('select');
            select.classList.add('csv-import-parent-select');

            const unresolvedOption = document.createElement('option');
            unresolvedOption.value = '';
            unresolvedOption.textContent = 'Choose child resolution…';
            select.appendChild(unresolvedOption);

            const none = document.createElement('option');
            none.value = 'none';
            none.textContent = 'No child attachment — confirmed';
            select.appendChild(none);

            const batchOptions = csvFindBatchRelationshipOptions(childLabel, candidate.candidateKey);
            batchOptions.forEach(batchCandidate => {
                const option = document.createElement('option');
                option.value = `batch:${batchCandidate.candidateKey}`;
                option.textContent = `CSV row ${batchCandidate.rowNumber}: ${csvCandidateDisplayLabel(batchCandidate)}`;
                select.appendChild(option);
            });

            (candidate.childMatches[childLabel] || []).forEach(existing => {
                const option = document.createElement('option');
                option.value = `existing:${existing.id}`;
                option.textContent = `Existing: ${csvExistingCandidateLabel(existing)}`;
                select.appendChild(option);
            });

            const selected = candidate.childSelections[childLabel] || '';
            select.value = selected;
            select.addEventListener('change', () => {
                candidate.childSelections[childLabel] = select.value;
                updateCsvImportCommitAvailability();
            });

            item.appendChild(labelNode);
            item.appendChild(select);
            childList.appendChild(item);
        });
        childrenPanel.appendChild(childList);
        card.appendChild(childrenPanel);
    }

    return card;
}

function renderCsvImportCandidates() {
    const container = document.getElementById('csv-import-candidates');
    const summary = document.getElementById('csv-import-summary');
    if (!container || !summary) return;

    container.innerHTML = '';
    summary.innerHTML = '';

    if (!csvImportState.candidates.length) {
        updateCsvImportCommitAvailability();
        return;
    }

    summary.classList.add('csv-import-summary');
    const possibleDuplicates = csvImportState.candidates.filter(candidate => candidate.duplicateCandidates.length).length;
    summary.textContent = `${csvImportState.fileName || 'CSV'} · ${csvImportState.candidates.length} rows · ${possibleDuplicates} rows have possible duplicate candidates.`;

    csvImportState.candidates.forEach(candidate => {
        container.appendChild(renderCsvImportCandidate(candidate));
    });

    updateCsvImportCommitAvailability();
}

async function previewCsvImport() {
    const fileInput = document.getElementById('csv-import-file');
    const file = fileInput?.files?.[0];
    if (!file) {
        alert('Choose a CSV file first.');
        return;
    }

    csvImportState.busy = true;
    updateCsvImportCommitAvailability();

    try {
        const text = await file.text();
        const parsedRows = parseCsvText(text);
        const candidates = csvRowsToCandidates(parsedRows);
        if (!candidates.length) throw new Error('No importable rows found in CSV.');
        if (candidates.length > CSV_IMPORT_MAX_ROWS) {
            throw new Error(`This importer accepts at most ${CSV_IMPORT_MAX_ROWS} non-empty data rows per CSV. This file has ${candidates.length}. Split it into smaller batches before previewing.`);
        }

        const response = await fetch(`${baseURL}/api/reference/import-review/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                rows: candidates.map(candidate => ({
                    candidateKey: candidate.candidateKey,
                    rowNumber: candidate.rowNumber,
                    info: candidate.info,
                    parentLabels: candidate.parentLabels,
                    parentIds: candidate.parentIds,
                    childLabels: candidate.childLabels,
                    childIds: candidate.childIds
                }))
            })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'CSV preview failed.');

        const previewByKey = new Map((data.rows || []).map(row => [row.candidateKey, row]));
        candidates.forEach(candidate => {
            const preview = previewByKey.get(candidate.candidateKey) || {};
            candidate.duplicateCandidates = preview.duplicateCandidates || [];
            candidate.parentMatches = preview.parentMatches || {};
            candidate.childMatches = preview.childMatches || {};
            candidate.validExplicitParentIds = preview.validExplicitParentIds || [];
            candidate.missingExplicitParentIds = preview.missingExplicitParentIds || [];
            candidate.validExplicitChildIds = preview.validExplicitChildIds || [];
            candidate.missingExplicitChildIds = preview.missingExplicitChildIds || [];

            if (!candidate.info.color && preview.autoColor) {
                candidate.info.color = preview.autoColor;
            }

            if (candidate.duplicateCandidates.length) {
                candidate.decision = 'review';
            } else if (!candidate.parseWarning) {
                candidate.decision = 'create';
            }

            if (candidate.missingExplicitParentIds.length) {
                candidate.parseWarning = `${candidate.parseWarning ? `${candidate.parseWarning} ` : ''}Missing explicit parent IDs: ${candidate.missingExplicitParentIds.join(', ')}`;
            }
            if (candidate.missingExplicitChildIds.length) {
                candidate.parseWarning = `${candidate.parseWarning ? `${candidate.parseWarning} ` : ''}Missing explicit child IDs: ${candidate.missingExplicitChildIds.join(', ')}`;
            }
        });

        csvImportState.fileName = file.name;
        csvImportState.candidates = candidates;
        csvImportState.previewed = true;
        renderCsvImportCandidates();
    } catch (error) {
        console.error('CSV import preview failed:', error);
        alert(`CSV import preview failed: ${error.message}`);
    } finally {
        csvImportState.busy = false;
        updateCsvImportCommitAvailability();
    }
}

function buildCsvImportCommitPayload() {
    return csvImportState.candidates.map(candidate => {
        const selectedParentIds = [];
        const batchParentKeys = [];
        const selectedChildIds = [];
        const batchChildKeys = [];

        Object.values(candidate.parentSelections || {}).forEach(value => {
            if (String(value).startsWith('existing:')) selectedParentIds.push(String(value).slice('existing:'.length));
            if (String(value).startsWith('batch:')) batchParentKeys.push(String(value).slice('batch:'.length));
        });

        Object.values(candidate.childSelections || {}).forEach(value => {
            if (String(value).startsWith('existing:')) selectedChildIds.push(String(value).slice('existing:'.length));
            if (String(value).startsWith('batch:')) batchChildKeys.push(String(value).slice('batch:'.length));
        });

        return {
            candidateKey: candidate.candidateKey,
            rowNumber: candidate.rowNumber,
            decision: candidate.decision,
            mergeTargetId: candidate.mergeTargetId,
            info: candidate.info,
            parentLabels: candidate.parentLabels,
            childLabels: candidate.childLabels,
            parentResolutions: candidate.parentLabels.map(label => ({
                label,
                resolution: String(candidate.parentSelections?.[label] || '')
            })),
            childResolutions: candidate.childLabels.map(label => ({
                label,
                resolution: String(candidate.childSelections?.[label] || '')
            })),
            parentIds: [...new Set([...(candidate.validExplicitParentIds || []), ...selectedParentIds])],
            batchParentKeys: [...new Set(batchParentKeys)],
            childIds: [...new Set([...(candidate.validExplicitChildIds || []), ...selectedChildIds])],
            batchChildKeys: [...new Set(batchChildKeys)]
        };
    });
}

async function commitCsvImport() {
    if (csvImportState.busy) return;

    const active = csvImportState.candidates.filter(candidate => candidate.decision !== 'skip');
    const unresolved = active.filter(candidate => candidate.decision === 'review' || (candidate.decision === 'merge' && !candidate.mergeTargetId));
    if (unresolved.length) {
        alert('Resolve every possible duplicate row before committing.');
        return;
    }

    const relationshipIssues = getCsvRelationshipReviewIssues();
    if (relationshipIssues.length) {
        alert('Resolve every parent/child label explicitly, or choose the confirmed no-attachment option, before committing.');
        return;
    }

    const confirmed = window.confirm(`Commit ${active.length} reviewed CSV row${active.length === 1 ? '' : 's'} to the reference database?`);
    if (!confirmed) return;

    csvImportState.busy = true;
    updateCsvImportCommitAvailability();

    try {
        const response = await fetch(`${baseURL}/api/reference/import-review/commit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: buildCsvImportCommitPayload(), fileName: csvImportState.fileName })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || data.message || 'CSV import commit failed.');

        const status = document.getElementById('csv-import-commit-status');
        if (status) {
            status.textContent = `Committed: ${data.summary?.created || 0} created, ${data.summary?.merged || 0} merged, ${data.summary?.skipped || 0} skipped.`;
        }

        csvImportState.previewed = false;
        csvImportState.candidates = [];
        const container = document.getElementById('csv-import-candidates');
        const summary = document.getElementById('csv-import-summary');
        if (container) container.innerHTML = '';
        if (summary) {
            summary.classList.add('csv-import-summary');
            summary.textContent = `Import complete: ${data.summary?.created || 0} created, ${data.summary?.merged || 0} merged, ${data.summary?.skipped || 0} skipped.`;
        }
    } catch (error) {
        console.error('CSV import commit failed:', error);
        alert(`CSV import commit failed: ${error.message}`);
    } finally {
        csvImportState.busy = false;
        updateCsvImportCommitAvailability();
    }
}

function clearCsvImport() {
    csvImportState.fileName = '';
    csvImportState.candidates = [];
    csvImportState.previewed = false;
    csvImportState.busy = false;
    const fileInput = document.getElementById('csv-import-file');
    const container = document.getElementById('csv-import-candidates');
    const summary = document.getElementById('csv-import-summary');
    const status = document.getElementById('csv-import-commit-status');
    if (fileInput) fileInput.value = '';
    if (container) container.innerHTML = '';
    if (summary) {
        summary.innerHTML = '';
        summary.classList.remove('csv-import-summary');
    }
    if (status) status.textContent = '';
    updateCsvImportCommitAvailability();
}

function initialiseCsvImportReview() {
    const previewButton = document.getElementById('csv-import-preview');
    const clearButton = document.getElementById('csv-import-clear');
    const commitButton = document.getElementById('csv-import-commit');
    if (previewButton) previewButton.addEventListener('click', previewCsvImport);
    if (clearButton) clearButton.addEventListener('click', clearCsvImport);
    if (commitButton) commitButton.addEventListener('click', commitCsvImport);
    updateCsvImportCommitAvailability();
}

initialiseCsvImportReview();
