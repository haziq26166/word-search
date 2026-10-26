/* =========================================
   Config
   ========================================= */
const GRID_SIZE = 12;
const MAX_HINTS = 3;
const HINT_DURATION_MS = 3500;
const LAYOUT_ATTEMPTS = 40; // how many layouts to generate; the densest one wins

// [rowStep, colStep] - all 8 directions, so words can run backwards and diagonally
const DIRECTIONS = [
    [-1, 0], [-1, 1], [0, 1], [1, 1],
    [1, 0], [1, -1], [0, -1], [-1, -1]
];

// Marker colours (all light enough for dark letters to stay readable)
const colors = [
    '#5eead4', '#ff8fb1', '#ffe066', '#ffb26b', '#86e57f',
    '#c4a1ff', '#ff7f7f', '#6ec1ff', '#f4a6f0', '#b5e655'
];

const wordsData = [
    { word: "CHANGE", definition: "The addition, modification, or removal of anything that could have an effect on IT services.", quickFact: "The scope includes architectures, processes, tools, metrics, and documentation.", color: colors[0] },
    { word: "EMERGENCY", definition: "A change that must be introduced as soon as possible.", quickFact: "Usually handled by the ECAB (Emergency Change Advisory Board) to ensure rapid but safe deployment.", color: colors[1] },
    { word: "DISRUPTION", definition: "Change management aims to make beneficial changes with minimum of this.", quickFact: "The primary purpose is to deploy changes in a controlled way to prevent negative impacts on IT services.", color: colors[2] },
    { word: "LIFECYCLE", definition: "Change management is responsible for controlling the _____ of all changes.", quickFact: "Covers the entire journey from initial Request for Change (RFC) to Post-Implementation Review (PIR).", color: colors[3] },
    { word: "STANDARD", definition: "A pre-approved, low-risk, and relatively common type of change.", quickFact: "These changes are pre-authorized but must still be registered and tracked by change management.", color: colors[4] },
    { word: "PROACTIVE", definition: "Changes made for cost reduction and service improvement.", quickFact: "Involves anticipating future needs or issues rather than just reacting to them.", color: colors[5] },
    { word: "REACTIVE", definition: "Changes made for solving service disruptions and adapting to a changing environment.", quickFact: "Occurs in response to an incident, problem, or sudden business requirement.", color: colors[6] },
    { word: "NORMAL", definition: "A change that must follow the complete change process flow.", quickFact: "Requires formal assessment, authorization, and scheduling by the Change Advisory Board (CAB).", color: colors[7] },
    { word: "MANAGER", definition: "The person who prepares and chairs CAB meetings, and maintains change logs.", quickFact: "Also responsible for receiving RFCs, assessing priorities, and publishing the Change Schedule.", color: colors[8] },
    { word: "RECORD", definition: "The process must use standardized methods and _____ all changes.", quickFact: "A core requirement in ITIL: if a change isn't documented, it didn't happen.", color: colors[9] }
];

/* =========================================
   State
   ========================================= */
let grid = [];           // grid[row][col] = letter
let cells = [];          // cells[row][col] = DOM element
let placedWords = [];    // wordsData entries + id, row, col, direction, found
let foundCount = 0;
let hintsLeft = MAX_HINTS;
let hintTimer = null;

let selecting = false;
let startPos = null;
let currentPath = [];

/* =========================================
   DOM
   ========================================= */
const gridElement = document.getElementById('word-grid');
const svgOverlay = document.getElementById('grid-overlay');
const clueListElement = document.getElementById('clue-list');
const winMessageElement = document.getElementById('win-message');
const progressBadge = document.getElementById('progress-badge');
const hintBtn = document.getElementById('hint-btn');
const hintCount = document.getElementById('hint-count');

const modalOverlay = document.getElementById('explanation-modal');
const modalContent = modalOverlay.querySelector('.modal-content');
const modalWord = document.getElementById('modal-word');
const modalDefinition = document.getElementById('modal-definition');
const modalQuickFact = document.getElementById('modal-quick-fact');
const modalBtn = document.getElementById('modal-btn');

const summaryPage = document.getElementById('summary-page');
const summaryList = document.getElementById('summary-list');
const reviewBtn = document.getElementById('review-btn');
const closeSummaryBtn = document.getElementById('close-summary-btn');
const playAgainWinBtn = document.getElementById('play-again-win-btn');

/* =========================================
   Word placement: dense, guaranteed to fit
   =========================================
   For each word we enumerate EVERY legal placement (all cells x all 8
   directions) and score it:
     + 10 per letter shared with an already-placed word (crossings)
     -  1.5 per word already using that direction (keeps directions varied)
     +  0-4 random jitter (so the same layout isn't produced every time)
   The best-scoring placement wins. Because we look at every legal spot
   instead of guessing randomly, a word can only fail if the grid truly has
   no room, in which case the whole layout is discarded and rebuilt.
   We build several layouts and keep the one with the most crossings.
*/

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Returns number of shared letters, or -1 if the placement is illegal.
function evaluatePlacement(word, row, col, dRow, dCol, g, owners) {
    let overlap = 0;
    const sharedWith = new Map();

    for (let i = 0; i < word.length; i++) {
        const r = row + i * dRow;
        const c = col + i * dCol;
        const existing = g[r][c];

        if (existing !== '') {
            if (existing !== word[i]) return -1;
            overlap++;
            owners[r][c].forEach(id => sharedWith.set(id, (sharedWith.get(id) || 0) + 1));
        }
    }

    // Two words may cross at ONE cell. Sharing 2+ cells with the same word
    // means they lie along the same line, which would look like one long word.
    for (const count of sharedWith.values()) {
        if (count > 1) return -1;
    }
    return overlap;
}

function tryBuildLayout() {
    const g = Array.from({ length: GRID_SIZE }, () => Array(GRID_SIZE).fill(''));
    const owners = Array.from({ length: GRID_SIZE }, () =>
        Array.from({ length: GRID_SIZE }, () => []));
    const directionUse = DIRECTIONS.map(() => 0);
    const placements = [];
    let totalOverlap = 0;

    // Longest words first (hardest to fit), shuffled among equal lengths
    const order = shuffle(wordsData.map((_, i) => i))
        .sort((a, b) => wordsData[b].word.length - wordsData[a].word.length);

    for (const id of order) {
        const word = wordsData[id].word;
        const len = word.length;
        let best = null;
        let bestScore = -Infinity;

        for (let d = 0; d < DIRECTIONS.length; d++) {
            const [dRow, dCol] = DIRECTIONS[d];

            for (let row = 0; row < GRID_SIZE; row++) {
                for (let col = 0; col < GRID_SIZE; col++) {
                    const endRow = row + (len - 1) * dRow;
                    const endCol = col + (len - 1) * dCol;
                    if (endRow < 0 || endRow >= GRID_SIZE || endCol < 0 || endCol >= GRID_SIZE) continue;

                    const overlap = evaluatePlacement(word, row, col, dRow, dCol, g, owners);
                    if (overlap < 0) continue;

                    const score = overlap * 10 - directionUse[d] * 1.5 + Math.random() * 4;
                    if (score > bestScore) {
                        bestScore = score;
                        best = { row, col, d, overlap };
                    }
                }
            }
        }

        if (!best) return null; // no room left: discard this layout

        const [dRow, dCol] = DIRECTIONS[best.d];
        for (let i = 0; i < len; i++) {
            const r = best.row + i * dRow;
            const c = best.col + i * dCol;
            g[r][c] = word[i];
            owners[r][c].push(id);
        }
        directionUse[best.d]++;
        totalOverlap += best.overlap;
        placements.push({
            ...wordsData[id],
            id,
            row: best.row,
            col: best.col,
            direction: [dRow, dCol],
            found: false
        });
    }

    return { grid: g, placements, overlap: totalOverlap };
}

function buildBestLayout() {
    let best = null;
    for (let i = 0; i < LAYOUT_ATTEMPTS; i++) {
        const layout = tryBuildLayout();
        if (layout && (!best || layout.overlap > best.overlap)) best = layout;
    }
    // Practically never needed, but guarantees we never return without all words
    while (!best) best = tryBuildLayout();
    return best;
}

/* ---------- Filler letters ---------- */

function countOccurrences(g, word) {
    let count = 0;
    const len = word.length;
    for (let row = 0; row < GRID_SIZE; row++) {
        for (let col = 0; col < GRID_SIZE; col++) {
            for (const [dRow, dCol] of DIRECTIONS) {
                const endRow = row + (len - 1) * dRow;
                const endCol = col + (len - 1) * dCol;
                if (endRow < 0 || endRow >= GRID_SIZE || endCol < 0 || endCol >= GRID_SIZE) continue;

                let match = true;
                for (let i = 0; i < len; i++) {
                    if (g[row + i * dRow][col + i * dCol] !== word[i]) { match = false; break; }
                }
                if (match) count++;
            }
        }
    }
    return count;
}

function fillEmptyCells(layoutGrid, placements) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const wordLetters = placements.map(p => p.word).join('');

    // Mostly use letters that appear in the words, so decoys look convincing
    const randomLetter = () => Math.random() < 0.55
        ? wordLetters[Math.floor(Math.random() * wordLetters.length)]
        : alphabet[Math.floor(Math.random() * alphabet.length)];

    let filled = null;
    for (let attempt = 0; attempt < 200; attempt++) {
        filled = layoutGrid.map(row => row.map(ch => ch || randomLetter()));
        // Each word must appear exactly once (no accidental duplicates)
        if (placements.every(p => countOccurrences(filled, p.word) === 1)) break;
    }
    return filled;
}

/* =========================================
   Game setup
   ========================================= */
function newGame() {
    clearHint();

    const layout = buildBestLayout();
    placedWords = layout.placements.sort((a, b) => a.id - b.id);
    grid = fillEmptyCells(layout.grid, placedWords);

    foundCount = 0;
    hintsLeft = MAX_HINTS;
    currentPath = [];
    selecting = false;

    winMessageElement.classList.remove('show');
    summaryPage.classList.add('hidden');
    modalOverlay.classList.remove('active');

    renderGrid();
    renderClues();
    updateProgress();
    updateHintButton();
}

function renderGrid() {
    gridElement.innerHTML = '';
    svgOverlay.innerHTML = '';
    gridElement.appendChild(svgOverlay);

    cells = [];
    for (let r = 0; r < GRID_SIZE; r++) {
        const rowEls = [];
        for (let c = 0; c < GRID_SIZE; c++) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.textContent = grid[r][c];
            gridElement.appendChild(cell);
            rowEls.push(cell);
        }
        cells.push(rowEls);
    }
}

function renderClues() {
    clueListElement.innerHTML = '';
    placedWords.forEach(item => {
        const li = document.createElement('li');
        li.id = `clue-${item.id}`;
        li.style.setProperty('--c', item.color);
        const span = document.createElement('span');
        span.textContent = item.word;
        li.appendChild(span);
        clueListElement.appendChild(li);
    });
}

function updateProgress() {
    progressBadge.textContent = `${foundCount} / ${placedWords.length}`;
}

function updateHintButton() {
    hintCount.textContent = `(${hintsLeft})`;
    hintBtn.disabled = hintsLeft <= 0 || foundCount === placedWords.length;
}

/* =========================================
   Selecting words (mouse, touch and pen via pointer events)
   ========================================= */
function isBlocked() {
    return modalOverlay.classList.contains('active') || !summaryPage.classList.contains('hidden');
}

// Convert screen coords to the nearest grid cell (clamped to the board)
function pointToCell(x, y) {
    const rect = svgOverlay.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(gridElement).columnGap) || 0;
    const pitchX = (rect.width + gap) / GRID_SIZE;
    const pitchY = (rect.height + gap) / GRID_SIZE;
    const clamp = v => Math.max(0, Math.min(GRID_SIZE - 1, v));

    return {
        row: clamp(Math.floor((y - rect.top) / pitchY)),
        col: clamp(Math.floor((x - rect.left) / pitchX))
    };
}

// Snap the drag to the closest of the 8 directions, so a slightly
// wobbly finger or mouse still selects a clean straight line.
function computePath(start, end) {
    const dRow = end.row - start.row;
    const dCol = end.col - start.col;
    if (dRow === 0 && dCol === 0) return [start];

    const octant = Math.round(Math.atan2(dRow, dCol) / (Math.PI / 4));
    const stepRow = Math.round(Math.sin(octant * Math.PI / 4));
    const stepCol = Math.round(Math.cos(octant * Math.PI / 4));

    let length = Math.round((dRow * stepRow + dCol * stepCol) / (stepRow * stepRow + stepCol * stepCol));
    length = Math.max(0, length);

    // never run off the board
    while (length > 0) {
        const r = start.row + length * stepRow;
        const c = start.col + length * stepCol;
        if (r >= 0 && r < GRID_SIZE && c >= 0 && c < GRID_SIZE) break;
        length--;
    }

    const path = [];
    for (let i = 0; i <= length; i++) {
        path.push({ row: start.row + i * stepRow, col: start.col + i * stepCol });
    }
    return path;
}

function paintSelection(path) {
    currentPath.forEach(({ row, col }) => cells[row][col].classList.remove('selecting'));
    currentPath = path;
    currentPath.forEach(({ row, col }) => cells[row][col].classList.add('selecting'));
}

function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (isBlocked()) return;

    e.preventDefault();
    selecting = true;
    startPos = pointToCell(e.clientX, e.clientY);
    paintSelection([startPos]);
}

function onPointerMove(e) {
    if (!selecting) return;
    paintSelection(computePath(startPos, pointToCell(e.clientX, e.clientY)));
}

function onPointerUp() {
    if (!selecting) return;
    selecting = false;

    const path = currentPath;
    paintSelection([]); // clear the purple selection

    if (path.length < 2) return;

    const selected = path.map(({ row, col }) => grid[row][col]).join('');
    const reversed = [...selected].reverse().join('');
    const match = placedWords.find(p => !p.found && (p.word === selected || p.word === reversed));

    if (match) {
        handleFound(match, path);
    } else {
        path.forEach(({ row, col }) => {
            const el = cells[row][col];
            el.classList.add('miss');
            setTimeout(() => el.classList.remove('miss'), 300);
        });
    }
}

function handleFound(match, path) {
    match.found = true;
    foundCount++;

    path.forEach(({ row, col }, i) => {
        const el = cells[row][col];
        el.classList.add('found');
        el.style.animationDelay = `${i * 35}ms`;
    });

    drawLine(path[0], path[path.length - 1], match.color, true);
    document.getElementById(`clue-${match.id}`).classList.add('solved');
    clearHint();
    updateProgress();
    updateHintButton();

    const allFound = foundCount === placedWords.length;
    if (allFound) {
        winMessageElement.classList.add('show');
        launchConfetti();
    }

    // brief pause so the highlighter animation is seen before the pop-up
    setTimeout(() => showExplanation(match), 450);
}

/* =========================================
   Highlighter lines
   ========================================= */
function drawLine(from, to, color, animate = false) {
    const width = svgOverlay.getBoundingClientRect().width;
    const height = svgOverlay.getBoundingClientRect().height;
    const gap = parseFloat(getComputedStyle(gridElement).columnGap) || 0;

    const cellW = (width - gap * (GRID_SIZE - 1)) / GRID_SIZE;
    const cellH = (height - gap * (GRID_SIZE - 1)) / GRID_SIZE;
    const center = (index, size) => index * (size + gap) + size / 2;

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', center(from.col, cellW));
    line.setAttribute('y1', center(from.row, cellH));
    line.setAttribute('x2', center(to.col, cellW));
    line.setAttribute('y2', center(to.row, cellH));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', cellW * 0.9);
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('pathLength', '1');
    if (animate) line.classList.add('draw-in');

    svgOverlay.appendChild(line);
}

function redrawLines() {
    svgOverlay.innerHTML = '';
    placedWords.forEach(item => {
        if (!item.found) return;
        const [dRow, dCol] = item.direction;
        const last = item.word.length - 1;
        drawLine(
            { row: item.row, col: item.col },
            { row: item.row + last * dRow, col: item.col + last * dCol },
            item.color
        );
    });
}

/* =========================================
   Hints
   ========================================= */
function clearHint() {
    clearTimeout(hintTimer);
    document.querySelectorAll('.cell.hint').forEach(el => el.classList.remove('hint'));
}

function useHint() {
    if (hintsLeft <= 0 || isBlocked()) return;

    const remaining = placedWords.filter(p => !p.found);
    if (remaining.length === 0) return;

    const target = remaining[Math.floor(Math.random() * remaining.length)];
    clearHint();
    cells[target.row][target.col].classList.add('hint'); // glow on the word's first letter
    hintTimer = setTimeout(clearHint, HINT_DURATION_MS);

    hintsLeft--;
    updateHintButton();
}

/* =========================================
   Modal, summary, confetti
   ========================================= */
function showExplanation(wordObj) {
    modalWord.textContent = wordObj.word;
    modalDefinition.textContent = wordObj.definition;
    modalQuickFact.textContent = wordObj.quickFact;
    modalContent.style.setProperty('--word-color', wordObj.color);
    modalOverlay.classList.add('active');
    modalBtn.focus();
}

function showSummary() {
    summaryList.innerHTML = '';
    [...wordsData]
        .sort((a, b) => a.word.localeCompare(b.word))
        .forEach(item => {
            const card = document.createElement('div');
            card.className = 'summary-card';
            card.style.setProperty('--c', item.color);
            card.innerHTML = `
                <h3>${item.word}</h3>
                <p><strong>Definition:</strong> ${item.definition}</p>
                <div class="s-card-fact"><strong>💡 Fact:</strong> ${item.quickFact}</div>
            `;
            summaryList.appendChild(card);
        });

    summaryPage.classList.remove('hidden');
}

function launchConfetti() {
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';

    for (let i = 0; i < 60; i++) {
        const piece = document.createElement('span');
        piece.className = 'confetti-piece';
        piece.style.left = `${Math.random() * 100}%`;
        piece.style.background = colors[Math.floor(Math.random() * colors.length)];
        piece.style.animationDuration = `${2 + Math.random() * 1.8}s`;
        piece.style.animationDelay = `${Math.random() * 0.6}s`;
        layer.appendChild(piece);
    }

    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 4500);
}

/* =========================================
   Events (bound once)
   ========================================= */
function bindEvents() {
    gridElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', () => {
        selecting = false;
        paintSelection([]);
    });

    window.addEventListener('resize', redrawLines);

    hintBtn.addEventListener('click', useHint);
    modalBtn.addEventListener('click', () => modalOverlay.classList.remove('active'));
    reviewBtn.addEventListener('click', showSummary);
    closeSummaryBtn.addEventListener('click', () => summaryPage.classList.add('hidden'));
    playAgainWinBtn.addEventListener('click', newGame);

    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        modalOverlay.classList.remove('active');
        summaryPage.classList.add('hidden');
    });
}

bindEvents();
newGame();
