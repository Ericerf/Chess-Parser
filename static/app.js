const defaultPlayers = [];
const maxTables = 3;

let tables = [];
let activeTableId = null;
let latestRounds = [];
let buildTimer = null;
let saveTimer = null;
let lastServerUpdate = 0;
let adminConfigured = false;
let isAdmin = false;

const adminForm = document.querySelector("#adminForm");
const adminPin = document.querySelector("#adminPin");
const adminState = document.querySelector("#adminState");
const adminHint = document.querySelector("#adminHint");
const adminLogout = document.querySelector("#adminLogout");
const tableForm = document.querySelector("#tableForm");
const tableName = document.querySelector("#tableName");
const tableTabs = document.querySelector("#tableTabs");
const tableHint = document.querySelector("#tableHint");
const closeTable = document.querySelector("#closeTable");
const playerForm = document.querySelector("#playerForm");
const playerName = document.querySelector("#playerName");
const playerList = document.querySelector("#playerList");
const resetPlayers = document.querySelector("#resetPlayers");
const errorMessage = document.querySelector("#errorMessage");
const schedule = document.querySelector("#schedule");
const summaryTitle = document.querySelector("#summaryTitle");
const summaryGrid = document.querySelector("#summaryGrid");
const standings = document.querySelector("#standings");
const completedGames = document.querySelector("#completedGames");
const saveBackup = document.querySelector("#saveBackup");
const restoreBackup = document.querySelector("#restoreBackup");
const backupStatus = document.querySelector("#backupStatus");
const finishTournament = document.querySelector("#finishTournament");
const finishStatus = document.querySelector("#finishStatus");

function currentTable() {
  return tables.find((table) => table.id === activeTableId) || null;
}

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `table-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function loadTablesFromServer({ preserveActive = true } = {}) {
  const response = await fetch("/api/tables");
  const state = await response.json();
  tables = normalizeTables(state.tables || []);
  lastServerUpdate = state.updatedAt || 0;

  if (!preserveActive || !tables.some((table) => table.id === activeTableId)) {
    activeTableId = tables[0]?.id || null;
  }
}

function normalizeTables(rawTables) {
  return rawTables.slice(0, maxTables).map((table) => ({
    id: table.id || createId(),
    name: table.name || "Untitled table",
    players: Array.isArray(table.players) ? table.players : [],
    results: table.results && typeof table.results === "object" ? table.results : {},
    backup: table.backup || null,
    finishStatus: table.finishStatus || "",
  }));
}

function queueSaveTables() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTables().catch((error) => setError(error.message));
  }, 150);
}

async function saveTables({ replace = false } = {}) {
  if (!canEdit()) {
    setError("Admin login required.");
    return;
  }

  const table = currentTable();
  const payloadTables = replace || !table ? tables : [table];
  const response = await fetch("/api/tables", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tables: payloadTables, replace }),
  });
  const state = await response.json();
  if (!response.ok) {
    throw new Error(state.error || "Could not save tables.");
  }
  lastServerUpdate = state.updatedAt || lastServerUpdate;
}

function canEdit() {
  return !adminConfigured || isAdmin;
}

async function loadAdminStatus() {
  const response = await fetch("/api/admin/status");
  const status = await response.json();
  adminConfigured = Boolean(status.configured);
  isAdmin = Boolean(status.admin);
  renderAdmin();
}

function renderAdmin() {
  const editable = canEdit();
  adminState.textContent = editable ? "Admin" : "Viewer";
  adminState.className = editable ? "admin-ok" : "admin-locked";
  adminForm.hidden = !adminConfigured || isAdmin;
  adminLogout.hidden = !adminConfigured || !isAdmin;
  adminPin.value = "";
  adminHint.textContent = adminConfigured
    ? editable
      ? "Editing is enabled."
      : "Login to edit tables and results."
    : "ADMIN_PIN is not configured; editing is open.";
}

async function loginAdmin(pin) {
  const response = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  const status = await response.json();
  if (!response.ok) {
    setError(status.error || "Admin login failed.");
    return;
  }
  adminConfigured = Boolean(status.configured);
  isAdmin = Boolean(status.admin);
  setError("");
  renderAdmin();
  renderApp({ persist: false });
}

async function logoutAdmin() {
  const response = await fetch("/api/admin/logout", { method: "POST" });
  const status = await response.json();
  adminConfigured = Boolean(status.configured);
  isAdmin = Boolean(status.admin);
  setError(response.ok ? "" : status.error || "Admin logout failed.");
  renderAdmin();
  renderApp({ persist: false });
}

function legacyTables() {
  try {
    const raw = window.localStorage.getItem("roundRobinChessTables");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? normalizeTables(parsed) : [];
  } catch {
    return [];
  }
}

function isEditing() {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
}

async function refreshTablesFromServer() {
  if (isEditing()) {
    return;
  }

  const response = await fetch("/api/tables");
  const state = await response.json();
  if (!response.ok || (state.updatedAt || 0) <= lastServerUpdate) {
    return;
  }

  tables = normalizeTables(state.tables || []);
  lastServerUpdate = state.updatedAt || 0;
  if (!tables.some((table) => table.id === activeTableId)) {
    activeTableId = tables[0]?.id || null;
  }
  renderApp({ persist: false });
}

async function initApp() {
  await loadAdminStatus();
  await loadTablesFromServer({ preserveActive: false });
  const oldTables = legacyTables();
  if (!tables.length && oldTables.length) {
    tables = oldTables;
    activeTableId = tables[0]?.id || null;
    await saveTables({ replace: true });
  }
  renderApp({ persist: false });
  window.setInterval(refreshTablesFromServer, 3000);
}

function createTable(name) {
  if (!canEdit()) {
    setError("Admin login required.");
    return;
  }

  if (tables.length >= maxTables) {
    setError("You can keep up to 3 tables at the same time.");
    return;
  }

  const cleanedName = name.trim();
  if (!cleanedName) {
    setError("Add a table name first.");
    return;
  }

  const table = {
    id: createId(),
    name: cleanedName,
    players: [...defaultPlayers],
    results: {},
    backup: null,
    finishStatus: "",
  };
  tables.push(table);
  activeTableId = table.id;
  tableName.value = "";
  queueSaveTables();
  renderApp();
}

function renderApp({ persist = true } = {}) {
  renderTableTabs();
  renderPlayers();
  renderBackupStatus();
  finishStatus.textContent = currentTable()?.finishStatus || "";
  buildSchedule({ persist });
}

function renderTableTabs() {
  const table = currentTable();
  tableName.disabled = !canEdit();
  tableForm.querySelector("button").disabled = !canEdit() || tables.length >= maxTables;
  closeTable.disabled = !canEdit() || !table;
  tableHint.textContent = table
    ? `Active table: ${table.name}`
    : "Create up to 3 tables.";

  tableTabs.replaceChildren(
    ...tables.map((item) => {
      const button = document.createElement("button");
      button.className = item.id === activeTableId ? "table-tab active" : "table-tab";
      button.type = "button";
      button.textContent = item.name;
      button.title = item.name;
      button.addEventListener("click", () => {
        activeTableId = item.id;
        renderApp({ persist: false });
      });
      return button;
    }),
  );
}

function closeActiveTable() {
  if (!canEdit()) {
    setError("Admin login required.");
    return;
  }

  const tableIndex = tables.findIndex((table) => table.id === activeTableId);
  if (tableIndex === -1) {
    return;
  }

  tables.splice(tableIndex, 1);
  activeTableId = tables[Math.min(tableIndex, tables.length - 1)]?.id || null;
  saveTables({ replace: true });
  renderApp();
}

function renderPlayers() {
  const table = currentTable();
  const disabled = !table || !canEdit();
  playerName.disabled = disabled;
  playerForm.querySelector("button").disabled = disabled;
  resetPlayers.disabled = disabled;
  saveBackup.disabled = disabled;
  finishTournament.disabled = disabled;

  if (!table) {
    playerList.replaceChildren();
    return;
  }

  playerList.replaceChildren(
    ...table.players.map((name, index) => {
      const row = document.createElement("div");
      row.className = "player-row";

      const input = document.createElement("input");
      input.value = name;
      input.ariaLabel = `Player ${index + 1}`;
      input.disabled = !canEdit();
      input.addEventListener("input", () => {
        table.players[index] = input.value;
        queueSaveTables();
        queueBuildSchedule();
      });

      const remove = document.createElement("button");
      remove.className = "remove-player";
      remove.type = "button";
      remove.textContent = "×";
      remove.disabled = !canEdit();
      remove.title = "Remove player";
      remove.ariaLabel = `Remove ${name || `player ${index + 1}`}`;
      remove.addEventListener("click", () => {
        table.players.splice(index, 1);
        queueSaveTables();
        renderPlayers();
        buildSchedule();
      });

      row.append(input, remove);
      return row;
    }),
  );
}

function renderBackupStatus() {
  const table = currentTable();
  restoreBackup.disabled = !table?.backup;

  if (!table) {
    backupStatus.textContent = "Create a table to begin";
    return;
  }

  if (!table.backup) {
    backupStatus.textContent = "No saved backup";
    return;
  }

  backupStatus.textContent = `Saved ${table.backup.completed}/${table.backup.totalGames} results`;
}

function cleanPlayers() {
  const table = currentTable();
  return table ? table.players.map((name) => name.trim()).filter(Boolean) : [];
}

function activeResults() {
  return currentTable()?.results || {};
}

function setError(message) {
  errorMessage.textContent = message;
}

function queueBuildSchedule() {
  window.clearTimeout(buildTimer);
  buildTimer = window.setTimeout(buildSchedule, 250);
}

async function buildSchedule({ persist = true } = {}) {
  setError("");
  const table = currentTable();

  if (!table) {
    latestRounds = [];
    renderSchedule();
    renderStandings();
    renderBackupStatus();
    return;
  }

  if (cleanPlayers().length < 2) {
    latestRounds = [];
    table.results = {};
    if (persist) queueSaveTables();
    renderSchedule();
    renderStandings();
    renderBackupStatus();
    return;
  }

  const response = await fetch("/api/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ players: cleanPlayers() }),
  });
  const body = await response.json();

  if (!response.ok) {
    latestRounds = [];
    table.results = {};
    if (persist) queueSaveTables();
    renderSchedule();
    renderStandings();
    setError(body.error || "Could not generate table.");
    return;
  }

  latestRounds = body.rounds;
  keepCurrentResultsOnly();
  renderSchedule();
  renderStandings();
  renderBackupStatus();
  if (persist) queueSaveTables();
}

function renderSchedule() {
  const table = currentTable();
  const names = cleanPlayers();
  const totalGames = latestRounds.flat().length;
  const completed = submittedResults().length;

  if (!table) {
    summaryTitle.textContent = "Create a table";
  } else {
    summaryTitle.textContent = latestRounds.length
      ? `${table.name}: ${names.length} players, ${latestRounds.length} rounds`
      : `${table.name}: no table yet`;
  }

  summaryGrid.replaceChildren(
    stat("Players", names.length),
    stat("Rounds", latestRounds.length),
    stat("Results", `${completed}/${totalGames}`),
  );
  completedGames.textContent = `${completed} submitted`;

  if (!table) {
    schedule.innerHTML = '<p class="empty-state">Create a named table to begin.</p>';
    return;
  }

  if (!latestRounds.length) {
    schedule.innerHTML = '<p class="empty-state">Add at least two players to generate pairings.</p>';
    return;
  }

  schedule.replaceChildren(
    ...latestRounds.map((round, roundIndex) => {
      const card = document.createElement("article");
      card.className = "round-card";

      const heading = document.createElement("div");
      heading.className = "round-heading";
      heading.innerHTML = `
        <h3>Round ${roundIndex + 1}</h3>
        <span class="board-count">${round.length} boards</span>
      `;

      const games = round.map((game, boardIndex) => {
        const key = gameKey(roundIndex, boardIndex, game);
        const row = document.createElement("div");
        row.className = "game-row";
        row.innerHTML = `
          <span class="board">${boardIndex + 1}</span>
          <div class="players">
            <span class="player-slot" title="${escapeHtml(game.white)}">
              <span class="color-chip light">White</span>
              <span class="player-name white">${escapeHtml(game.white)}</span>
            </span>
            <span class="versus">vs</span>
            <span class="player-slot black-slot" title="${escapeHtml(game.black)}">
              <span class="color-chip dark">Black</span>
              <span class="player-name black">${escapeHtml(game.black)}</span>
            </span>
          </div>
        `;
        const result = document.createElement("select");
        result.className = "result-select";
        result.ariaLabel = `Result for ${game.white} vs ${game.black}`;
        result.innerHTML = `
          <option value="">Result</option>
          <option value="white">${escapeHtml(game.white)} wins</option>
          <option value="draw">Draw</option>
          <option value="black">${escapeHtml(game.black)} wins</option>
        `;
        result.value = activeResults()[key] || "";
        result.disabled = !canEdit();
        result.addEventListener("change", () => {
          const table = currentTable();
          if (!table) {
            return;
          }
          if (result.value) {
            table.results[key] = result.value;
          } else {
            delete table.results[key];
          }
          queueSaveTables();
          renderSchedule();
          renderStandings();
        });
        row.append(result);
        return row;
      });

      card.append(heading, ...games);
      return card;
    }),
  );
}

function renderStandings() {
  const table = calculateStandings();

  if (!currentTable()) {
    standings.innerHTML = '<p class="empty-state compact">Create a table to see standings.</p>';
    return;
  }

  if (!table.length) {
    standings.innerHTML = '<p class="empty-state compact">Add at least two players to see standings.</p>';
    return;
  }

  standings.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Player</th>
          <th>Pts</th>
          <th>Pl</th>
          <th>W</th>
          <th>D</th>
          <th>L</th>
          <th>Wh</th>
          <th>Bl</th>
          <th>BH</th>
        </tr>
      </thead>
      <tbody>
        ${table
          .map(
            (row, index) => `
              <tr>
                <td>${index + 1}</td>
                <td>${escapeHtml(row.player)}</td>
                <td>${formatPoints(row.points)}</td>
                <td>${row.played}</td>
                <td>${row.wins}</td>
                <td>${row.draws}</td>
                <td>${row.losses}</td>
                <td>${row.whiteGames}</td>
                <td>${row.blackGames}</td>
                <td>${formatPoints(row.buchholz)}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;
}

function calculateStandings() {
  const table = Object.fromEntries(
    cleanPlayers().map((player) => [
      player,
      {
        player,
        points: 0,
        played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        whiteGames: 0,
        blackGames: 0,
        opponents: [],
        headToHead: {},
        direct: 0,
        buchholz: 0,
      },
    ]),
  );

  latestRounds.forEach((round, roundIndex) => {
    round.forEach((game, boardIndex) => {
      if (!table[game.white] || !table[game.black]) {
        return;
      }

      table[game.white].whiteGames += 1;
      table[game.black].blackGames += 1;

      const result = activeResults()[gameKey(roundIndex, boardIndex, game)];
      if (!result) {
        return;
      }

      table[game.white].played += 1;
      table[game.black].played += 1;
      table[game.white].opponents.push(game.black);
      table[game.black].opponents.push(game.white);

      if (result === "white") {
        table[game.white].points += 1;
        table[game.white].wins += 1;
        table[game.black].losses += 1;
        addHeadToHead(table, game.white, game.black, 1);
        addHeadToHead(table, game.black, game.white, 0);
      } else if (result === "black") {
        table[game.black].points += 1;
        table[game.black].wins += 1;
        table[game.white].losses += 1;
        addHeadToHead(table, game.white, game.black, 0);
        addHeadToHead(table, game.black, game.white, 1);
      } else {
        table[game.white].points += 0.5;
        table[game.black].points += 0.5;
        table[game.white].draws += 1;
        table[game.black].draws += 1;
        addHeadToHead(table, game.white, game.black, 0.5);
        addHeadToHead(table, game.black, game.white, 0.5);
      }
    });
  });

  const rows = Object.values(table);
  rows.forEach((row) => {
    row.direct = rows
      .filter((other) => other.player !== row.player && other.points === row.points)
      .reduce((total, opponent) => total + directScore(row, opponent), 0);
    row.buchholz = row.opponents.reduce(
      (total, opponent) => total + (table[opponent]?.points || 0),
      0,
    );
  });

  return rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.direct !== a.direct) return b.direct - a.direct;
    if (b.buchholz !== a.buchholz) return b.buchholz - a.buchholz;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.player.localeCompare(b.player);
  });
}

function addHeadToHead(table, player, opponent, points) {
  table[player].headToHead[opponent] = (table[player].headToHead[opponent] || 0) + points;
}

function directScore(playerRow, opponentRow) {
  return playerRow.headToHead[opponentRow.player] || 0;
}

function submittedResults() {
  return latestRounds
    .flatMap((round, roundIndex) =>
      round.map((game, boardIndex) => activeResults()[gameKey(roundIndex, boardIndex, game)]),
    )
    .filter(Boolean);
}

function currentBackup() {
  return {
    players: cleanPlayers(),
    results: { ...activeResults() },
    completed: submittedResults().length,
    totalGames: latestRounds.flat().length,
    savedAt: new Date().toISOString(),
  };
}

function writeBackup() {
  if (!canEdit()) {
    setError("Admin login required.");
    return;
  }

  const table = currentTable();
  if (!table) {
    return;
  }
  table.backup = currentBackup();
  queueSaveTables();
  renderBackupStatus();
}

async function finishCurrentTournament() {
  if (!canEdit()) {
    setError("Admin login required.");
    return;
  }

  const table = currentTable();
  setError("");
  finishStatus.textContent = "";

  if (!table || !latestRounds.length) {
    setError("Add at least two players before finishing.");
    return;
  }

  const response = await fetch("/api/finish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(finalTournamentPayload()),
  });
  const body = await response.json();

  if (!response.ok) {
    setError(body.error || "Could not finish tournament.");
    return;
  }

  table.finishStatus = `Final table saved: ${body.htmlName}`;
  queueSaveTables();
  finishStatus.textContent = table.finishStatus;
}

function finalTournamentPayload() {
  const table = currentTable();
  return {
    title: table?.name || "Perser Chess Club",
    players: cleanPlayers(),
    rounds: roundsForExport(),
    standings: calculateStandings().map((row) => ({
      player: row.player,
      points: formatPoints(row.points),
      played: row.played,
      wins: row.wins,
      draws: row.draws,
      losses: row.losses,
      whiteGames: row.whiteGames,
      blackGames: row.blackGames,
      buchholz: formatPoints(row.buchholz),
    })),
    completed: submittedResults().length,
    totalGames: latestRounds.flat().length,
    finishedAt: new Date().toLocaleString(),
  };
}

function roundsForExport() {
  return latestRounds.map((round, roundIndex) =>
    round.map((game, boardIndex) => {
      const result = activeResults()[gameKey(roundIndex, boardIndex, game)] || "";
      return {
        white: game.white,
        black: game.black,
        result,
        resultLabel: displayResultLabel(result, game),
      };
    }),
  );
}

function displayResultLabel(result, game) {
  if (result === "white") return `${game.white} wins`;
  if (result === "draw") return "Draw";
  if (result === "black") return `${game.black} wins`;
  return "";
}

function restoreLastBackup() {
  if (!canEdit()) {
    setError("Admin login required.");
    return;
  }

  const table = currentTable();
  if (!table?.backup) {
    renderBackupStatus();
    return;
  }

  table.players = Array.isArray(table.backup.players) ? [...table.backup.players] : [...defaultPlayers];
  table.results = table.backup.results && typeof table.backup.results === "object" ? { ...table.backup.results } : {};
  queueSaveTables();
  renderPlayers();
  buildSchedule();
}

function keepCurrentResultsOnly() {
  const table = currentTable();
  if (!table) {
    return;
  }
  const currentKeys = new Set(
    latestRounds.flatMap((round, roundIndex) =>
      round.map((game, boardIndex) => gameKey(roundIndex, boardIndex, game)),
    ),
  );
  table.results = Object.fromEntries(
    Object.entries(table.results).filter(([key]) => currentKeys.has(key)),
  );
}

function gameKey(roundIndex, boardIndex, game) {
  return `${roundIndex}:${boardIndex}:${game.white}:${game.black}`;
}

function formatPoints(points) {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

function stat(label, value) {
  const item = document.createElement("div");
  item.className = "stat";
  item.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
  return item;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}

tableForm.addEventListener("submit", (event) => {
  event.preventDefault();
  createTable(tableName.value);
});

adminForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loginAdmin(adminPin.value);
});

adminLogout.addEventListener("click", logoutAdmin);

closeTable.addEventListener("click", closeActiveTable);

playerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!canEdit()) {
    setError("Admin login required.");
    return;
  }

  const table = currentTable();
  const name = playerName.value.trim();
  if (!table || !name) {
    return;
  }
  table.players.push(name);
  playerName.value = "";
  queueSaveTables();
  renderPlayers();
  buildSchedule();
});

resetPlayers.addEventListener("click", () => {
  if (!canEdit()) {
    setError("Admin login required.");
    return;
  }

  const table = currentTable();
  if (!table) {
    return;
  }
  table.players = [...defaultPlayers];
  table.results = {};
  table.backup = null;
  table.finishStatus = "";
  queueSaveTables();
  renderApp();
});

saveBackup.addEventListener("click", writeBackup);
restoreBackup.addEventListener("click", restoreLastBackup);
finishTournament.addEventListener("click", finishCurrentTournament);

initApp();
