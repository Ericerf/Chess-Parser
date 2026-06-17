#!/usr/bin/env python3
"""Small web UI for the round-robin chess table generator."""

from __future__ import annotations

import argparse
import html
import json
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from round_robin_chess import create_round_robin


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
OUTPUTS_DIR = ROOT / "outputs"
TABLES_FILE = ROOT / "tables.json"
MAX_TABLES = 3
tables_lock = threading.Lock()


class ChessTableHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/tables":
            self.get_tables()
            return
        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/schedule":
            self.create_schedule()
        elif path == "/api/finish":
            self.finish_tournament()
        else:
            self.send_error(404, "Not found")

    def do_PUT(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/tables":
            self.save_tables()
        else:
            self.send_error(404, "Not found")

    def get_tables(self) -> None:
        self.send_json(200, read_tables_state())

    def save_tables(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or "{}")
            tables = payload.get("tables", [])
            if not isinstance(tables, list):
                raise ValueError("Tables must be a list.")

            current_state = read_tables_state()
            replace_all = bool(payload.get("replace"))
            next_tables = sanitize_tables(tables)
            if not replace_all:
                next_tables = merge_tables(current_state.get("tables", []), next_tables)

            state = {
                "tables": next_tables,
                "updatedAt": time.time(),
            }
            write_tables_state(state)
            self.send_json(200, state)
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Request body must be valid JSON."})

    def create_schedule(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or "{}")
            players = payload.get("players", [])
            if not isinstance(players, list):
                raise ValueError("Players must be a list.")

            rounds = create_round_robin([str(player) for player in players])
            response = {
                "rounds": [
                    [
                        {"white": pairing.white, "black": pairing.black}
                        for pairing in round_pairings
                    ]
                    for round_pairings in rounds
                ]
            }
            self.send_json(200, response)
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Request body must be valid JSON."})

    def finish_tournament(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or "{}")
            players = payload.get("players", [])
            rounds = payload.get("rounds", [])
            standings = payload.get("standings", [])

            if not isinstance(players, list) or len(players) < 2:
                raise ValueError("Add at least two players before finishing.")
            if not isinstance(rounds, list) or not rounds:
                raise ValueError("There is no tournament table to save.")
            if not isinstance(standings, list) or not standings:
                raise ValueError("There are no standings to save.")

            index = next_tournament_index()
            base_name = f"tournament-{index:03d}"
            html_path = OUTPUTS_DIR / f"{base_name}.html"
            json_path = OUTPUTS_DIR / f"{base_name}.json"
            report = build_report_html(index, payload)

            OUTPUTS_DIR.mkdir(exist_ok=True)
            html_path.write_text(report, encoding="utf-8")
            json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

            self.send_json(
                200,
                {
                    "index": index,
                    "htmlFile": str(html_path),
                    "jsonFile": str(json_path),
                    "htmlName": html_path.name,
                    "jsonName": json_path.name,
                },
            )
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Request body must be valid JSON."})

    def send_json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def next_tournament_index() -> int:
    OUTPUTS_DIR.mkdir(exist_ok=True)
    indexes = []
    for path in OUTPUTS_DIR.glob("tournament-*.html"):
        match = re.fullmatch(r"tournament-(\d{3})\.html", path.name)
        if match:
            indexes.append(int(match.group(1)))
    return max(indexes, default=0) + 1


def read_tables_state() -> dict:
    with tables_lock:
        if not TABLES_FILE.exists():
            return {"tables": [], "updatedAt": 0}
        try:
            data = json.loads(TABLES_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"tables": [], "updatedAt": 0}
        if not isinstance(data, dict) or not isinstance(data.get("tables"), list):
            return {"tables": [], "updatedAt": 0}
        return {
            "tables": sanitize_tables(data.get("tables", [])),
            "updatedAt": data.get("updatedAt", 0),
        }


def write_tables_state(state: dict) -> None:
    with tables_lock:
        TABLES_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def sanitize_tables(tables: list) -> list[dict]:
    clean_tables = []
    for index, table in enumerate(tables[:MAX_TABLES], start=1):
        if not isinstance(table, dict):
            continue
        clean_tables.append(
            {
                "id": str(table.get("id") or f"table-{index}"),
                "name": str(table.get("name") or "Untitled table")[:80],
                "players": sanitize_players(table.get("players", [])),
                "results": sanitize_results(table.get("results", {})),
                "backup": sanitize_backup(table.get("backup")),
                "finishStatus": str(table.get("finishStatus") or "")[:160],
            }
        )
    return clean_tables


def merge_tables(existing_tables: list, incoming_tables: list) -> list[dict]:
    merged = sanitize_tables(existing_tables)
    by_id = {table["id"]: table for table in merged}
    order = [table["id"] for table in merged]

    for table in incoming_tables:
        table_id = table["id"]
        if table_id not in by_id:
            order.append(table_id)
        by_id[table_id] = table

    return [by_id[table_id] for table_id in order if table_id in by_id][:MAX_TABLES]


def sanitize_players(players: object) -> list[str]:
    if not isinstance(players, list):
        return []
    return [str(player)[:80] for player in players]


def sanitize_results(results: object) -> dict[str, str]:
    if not isinstance(results, dict):
        return {}
    allowed = {"white", "draw", "black"}
    return {
        str(key)[:240]: str(value)
        for key, value in results.items()
        if str(value) in allowed
    }


def sanitize_backup(backup: object) -> dict | None:
    if not isinstance(backup, dict):
        return None
    return {
        "players": sanitize_players(backup.get("players", [])),
        "results": sanitize_results(backup.get("results", {})),
        "completed": int(backup.get("completed", 0) or 0),
        "totalGames": int(backup.get("totalGames", 0) or 0),
        "savedAt": str(backup.get("savedAt") or ""),
    }


def build_report_html(index: int, payload: dict) -> str:
    title = str(payload.get("title") or "Perser Chess Club")
    players = payload.get("players", [])
    standings = payload.get("standings", [])
    rounds = payload.get("rounds", [])
    completed = int(payload.get("completed", 0))
    total_games = int(payload.get("totalGames", 0))
    finished_at = str(payload.get("finishedAt") or "")

    standings_rows = "\n".join(
        "<tr>"
        f"<td>{position}</td>"
        f"<td>{escape(row.get('player', ''))}</td>"
        f"<td>{escape(row.get('points', 0))}</td>"
        f"<td>{escape(row.get('played', 0))}</td>"
        f"<td>{escape(row.get('wins', 0))}</td>"
        f"<td>{escape(row.get('draws', 0))}</td>"
        f"<td>{escape(row.get('losses', 0))}</td>"
        f"<td>{escape(row.get('whiteGames', 0))}</td>"
        f"<td>{escape(row.get('blackGames', 0))}</td>"
        "</tr>"
        for position, row in enumerate(standings, start=1)
        if isinstance(row, dict)
    )

    round_cards = "\n".join(build_round_html(round_number, pairings) for round_number, pairings in enumerate(rounds, start=1))

    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{escape(title)} tournament {index:03d}</title>
    <style>
      body {{ margin: 0; background: #f3f1ea; color: #1d1f22; font-family: Arial, sans-serif; }}
      main {{ max-width: 1100px; margin: 0 auto; padding: 28px; }}
      h1, h2, h3 {{ margin: 0; }}
      .meta {{ color: #697077; margin: 8px 0 24px; }}
      table {{ width: 100%; border-collapse: collapse; background: white; margin-bottom: 24px; }}
      th, td {{ border: 1px solid #d9d3c4; padding: 9px 10px; text-align: right; }}
      th:nth-child(2), td:nth-child(2) {{ text-align: left; }}
      th {{ background: #f7f3ea; }}
      .rounds {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }}
      .round {{ border: 1px solid #d9d3c4; background: white; }}
      .round h3 {{ background: #f7f3ea; border-bottom: 1px solid #d9d3c4; padding: 12px; }}
      .game {{ display: grid; grid-template-columns: auto 1fr; gap: 10px; border-top: 1px solid #ece7dc; padding: 10px 12px; }}
      .game:first-of-type {{ border-top: 0; }}
      .board {{ color: #b98224; font-weight: bold; }}
      .result {{ color: #196f63; font-weight: bold; }}
    </style>
  </head>
  <body>
    <main>
      <h1>{escape(title)}</h1>
      <p class="meta">Tournament #{index:03d} · {len(players)} players · {completed}/{total_games} results · Finished {escape(finished_at)}</p>

      <h2>Final Standings</h2>
      <table>
        <thead>
          <tr><th>Rank</th><th>Player</th><th>Pts</th><th>Pl</th><th>W</th><th>D</th><th>L</th><th>Wh</th><th>Bl</th></tr>
        </thead>
        <tbody>
          {standings_rows}
        </tbody>
      </table>

      <h2>Rounds</h2>
      <section class="rounds">
        {round_cards}
      </section>
    </main>
  </body>
</html>
"""


def build_round_html(round_number: int, pairings: list) -> str:
    games = []
    for board_number, game in enumerate(pairings, start=1):
        if not isinstance(game, dict):
            continue
        result = str(game.get("resultLabel") or "Not submitted")
        games.append(
            '<div class="game">'
            f'<span class="board">{board_number}</span>'
            f'<span>{escape(game.get("white", ""))} (White) vs {escape(game.get("black", ""))} (Black) '
            f'<span class="result">{escape(result)}</span></span>'
            "</div>"
        )
    return f'<article class="round"><h3>Round {round_number}</h3>{"".join(games)}</article>'


def escape(value: object) -> str:
    return html.escape(str(value), quote=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the chess table web UI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), ChessTableHandler)
    print(f"Serving round-robin chess UI at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server.")


if __name__ == "__main__":
    main()
