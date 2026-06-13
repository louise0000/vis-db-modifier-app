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

    const originalInfo = data.info || {};
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
    editSection.style.display = 'block';

    const saveButton = document.getElementById('save-edits');
    saveButton.style.display = 'block';
    saveButton.onclick = async () => {
        console.log("Save Changes clicked for record ID:", data.id);
        const updatedInfo = {};
        ulElement.querySelectorAll('li').forEach(li => {
            const key = li.querySelector('strong').textContent.replace(':', '');
            const value = li.querySelector('span').textContent;
            updatedInfo[key] = parseEditedInfoValue(value, originalInfo[key]);
        });

        const response = await fetch(`${window.location.protocol}//${window.location.host}/api/reference/update/${data.id}`, {
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
document.querySelectorAll('nav a').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();

        const targetId = this.getAttribute('href');
        const contentWrapper = document.querySelector('.content-wrapper');
        const sectionTransforms = {
            '#section-1': 'translateX(0)',
            '#section-2': 'translateX(-16.6667%)',
            '#section-3': 'translateX(-33.3333%)',
            '#section-4': 'translateX(-50%)',
            '#section-5': 'translateX(-66.6667%)',
            '#section-6': 'translateX(-83.3333%)'
        };

        if (sectionTransforms[targetId]) {
            contentWrapper.style.transform = sectionTransforms[targetId];
            window.history.pushState({}, '', targetId); // Update the URL without jumping
        }
    });
});
