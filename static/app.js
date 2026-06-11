const defaultPlayers = [];
const maxTables = 3;
const storageKey = "roundRobinChessTables";

let tables = loadTables();
let activeTableId = tables[0]?.id || null;
let latestRounds = [];
let buildTimer = null;

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

function loadTables() {
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.slice(0, maxTables).map((table) => ({
      id: table.id || createId(),
      name: table.name || "Untitled table",
      players: Array.isArray(table.players) ? table.players : [],
      results: table.results && typeof table.results === "object" ? table.results : {},
      backup: table.backup || null,
      finishStatus: table.finishStatus || "",
    }));
  } catch {
    return [];
  }
}

function saveTables() {
  window.localStorage.setItem(storageKey, JSON.stringify(tables));
}

function createId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `table-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createTable(name) {
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
  saveTables();
  renderApp();
}

function renderApp() {
  renderTableTabs();
  renderPlayers();
  renderBackupStatus();
  finishStatus.textContent = currentTable()?.finishStatus || "";
  buildSchedule();
}

function renderTableTabs() {
  const table = currentTable();
  tableForm.querySelector("button").disabled = tables.length >= maxTables;
  closeTable.disabled = !table;
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
        renderApp();
      });
      return button;
    }),
  );
}

function closeActiveTable() {
  const tableIndex = tables.findIndex((table) => table.id === activeTableId);
  if (tableIndex === -1) {
    return;
  }

  tables.splice(tableIndex, 1);
  activeTableId = tables[Math.min(tableIndex, tables.length - 1)]?.id || null;
  saveTables();
  renderApp();
}

function renderPlayers() {
  const table = currentTable();
  const disabled = !table;
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
      input.addEventListener("input", () => {
        table.players[index] = input.value;
        saveTables();
        queueBuildSchedule();
      });

      const remove = document.createElement("button");
      remove.className = "remove-player";
      remove.type = "button";
      remove.textContent = "×";
      remove.title = "Remove player";
      remove.ariaLabel = `Remove ${name || `player ${index + 1}`}`;
      remove.addEventListener("click", () => {
        table.players.splice(index, 1);
        saveTables();
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

async function buildSchedule() {
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
    saveTables();
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
    saveTables();
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
  saveTables();
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
          saveTables();
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

      if (result === "white") {
        table[game.white].points += 1;
        table[game.white].wins += 1;
        table[game.black].losses += 1;
      } else if (result === "black") {
        table[game.black].points += 1;
        table[game.black].wins += 1;
        table[game.white].losses += 1;
      } else {
        table[game.white].points += 0.5;
        table[game.black].points += 0.5;
        table[game.white].draws += 1;
        table[game.black].draws += 1;
      }
    });
  });

  return Object.values(table).sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.player.localeCompare(b.player);
  });
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
  const table = currentTable();
  if (!table) {
    return;
  }
  table.backup = currentBackup();
  saveTables();
  renderBackupStatus();
}

async function finishCurrentTournament() {
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
  saveTables();
  finishStatus.textContent = table.finishStatus;
}

function finalTournamentPayload() {
  const table = currentTable();
  return {
    title: table?.name || "Perser Chess Club",
    players: cleanPlayers(),
    rounds: roundsForExport(),
    standings: calculateStandings().map((row) => ({
      ...row,
      points: formatPoints(row.points),
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
  const table = currentTable();
  if (!table?.backup) {
    renderBackupStatus();
    return;
  }

  table.players = Array.isArray(table.backup.players) ? [...table.backup.players] : [...defaultPlayers];
  table.results = table.backup.results && typeof table.backup.results === "object" ? { ...table.backup.results } : {};
  saveTables();
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

closeTable.addEventListener("click", closeActiveTable);

playerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const table = currentTable();
  const name = playerName.value.trim();
  if (!table || !name) {
    return;
  }
  table.players.push(name);
  playerName.value = "";
  saveTables();
  renderPlayers();
  buildSchedule();
});

resetPlayers.addEventListener("click", () => {
  const table = currentTable();
  if (!table) {
    return;
  }
  table.players = [...defaultPlayers];
  table.results = {};
  table.backup = null;
  table.finishStatus = "";
  saveTables();
  renderApp();
});

saveBackup.addEventListener("click", writeBackup);
restoreBackup.addEventListener("click", restoreLastBackup);
finishTournament.addEventListener("click", finishCurrentTournament);

renderApp();
