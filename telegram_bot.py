#!/usr/bin/env python3
"""Telegram bot for managing Perser Chess Club round-robin tables.

Set TELEGRAM_BOT_TOKEN before running:
    TELEGRAM_BOT_TOKEN=123:abc python3 telegram_bot.py
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from app import (
    build_report_html,
    next_tournament_index,
    read_tables_state,
    sanitize_tables,
    write_tables_state,
)
from round_robin_chess import create_round_robin


ROOT = Path(__file__).resolve().parent
BOT_STATE_FILE = ROOT / "telegram_bot_state.json"
OUTPUTS_DIR = ROOT / "outputs"
MAX_TABLES = 3


def main() -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN before running the bot.")

    bot = TelegramBot(token)
    offset = load_bot_state().get("offset", 0)
    print("Telegram chess bot is running.")

    while True:
        try:
            updates = bot.get_updates(offset)
            for update in updates:
                offset = max(offset, update["update_id"] + 1)
                handle_update(bot, update)
            save_bot_state({"offset": offset})
        except Exception as error:  # Keep the bot alive during transient API issues.
            print(f"Bot error: {error}")
            time.sleep(3)


class TelegramBot:
    def __init__(self, token: str) -> None:
        self.base_url = f"https://api.telegram.org/bot{token}"

    def request(self, method: str, payload: dict | None = None) -> dict:
        data = None
        if payload is not None:
            data = urllib.parse.urlencode(payload).encode("utf-8")
        request = urllib.request.Request(f"{self.base_url}/{method}", data=data)
        with urllib.request.urlopen(request, timeout=35) as response:
            body = json.loads(response.read().decode("utf-8"))
        if not body.get("ok"):
            raise RuntimeError(body)
        return body

    def get_updates(self, offset: int) -> list[dict]:
        payload = {"timeout": 25, "offset": offset}
        return self.request("getUpdates", payload).get("result", [])

    def send_message(self, chat_id: int, text: str) -> None:
        self.request(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
        )


def handle_update(bot: TelegramBot, update: dict) -> None:
    message = update.get("message") or update.get("edited_message") or {}
    text = (message.get("text") or "").strip()
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if not chat_id or not text:
        return

    command, _, rest = text.partition(" ")
    command = command.split("@", 1)[0].lower()

    try:
        response = dispatch(chat_id, command, rest.strip())
    except ValueError as error:
        response = str(error)
    except urllib.error.URLError:
        response = "Telegram/network connection failed. Try again in a moment."

    bot.send_message(chat_id, response)


def dispatch(chat_id: int, command: str, rest: str) -> str:
    if command in {"/start", "/help"}:
        return help_text()
    if command == "/new":
        return create_table(rest)
    if command == "/tables":
        return list_tables()
    if command == "/use":
        return use_table(chat_id, rest)
    if command == "/add":
        return add_player(chat_id, rest)
    if command == "/players":
        return list_players(chat_id)
    if command == "/pairings":
        return show_pairings(chat_id)
    if command == "/result":
        return submit_result(chat_id, rest)
    if command == "/standings":
        return show_standings(chat_id)
    if command == "/save":
        return save_backup(chat_id)
    if command == "/back":
        return restore_backup(chat_id)
    if command == "/finish":
        return finish_table(chat_id)
    return "Unknown command. Send /help to see what I can do."


def help_text() -> str:
    return (
        "<b>Perser Chess Club Bot</b>\n"
        "/new Table Name - create a table\n"
        "/tables - list tables\n"
        "/use 1 - select a table\n"
        "/add Player Name - add player\n"
        "/players - list players\n"
        "/pairings - show rounds\n"
        "/result 1 2 white - result for round 1 board 2\n"
        "/result 1 2 black - black wins\n"
        "/result 1 2 draw - draw\n"
        "/standings - show standings\n"
        "/save - save backup\n"
        "/back - restore backup\n"
        "/finish - export final table"
    )


def create_table(name: str) -> str:
    if not name:
        raise ValueError("Usage: /new Table Name")

    state = read_tables_state()
    tables = state["tables"]
    if len(tables) >= MAX_TABLES:
        raise ValueError("You can keep up to 3 tables at the same time.")

    table = {
        "id": create_id(),
        "name": name[:80],
        "players": [],
        "results": {},
        "backup": None,
        "finishStatus": "",
    }
    tables.append(table)
    write_tables_state({"tables": sanitize_tables(tables), "updatedAt": time.time()})
    return f"Created table <b>{escape(name)}</b>. Use /tables to see all tables."


def list_tables() -> str:
    tables = read_tables_state()["tables"]
    if not tables:
        return "No tables yet. Create one with /new Table Name."
    lines = ["<b>Tables</b>"]
    for index, table in enumerate(tables, start=1):
        lines.append(f"{index}. {escape(table['name'])} ({len(table['players'])} players)")
    return "\n".join(lines)


def use_table(chat_id: int, value: str) -> str:
    tables = read_tables_state()["tables"]
    table = table_from_value(tables, value)
    set_active_table(chat_id, table["id"])
    return f"Active table: <b>{escape(table['name'])}</b>"


def add_player(chat_id: int, name: str) -> str:
    if not name:
        raise ValueError("Usage: /add Player Name")
    state, table = active_table(chat_id)
    if name in table["players"]:
        raise ValueError("That player is already in this table.")
    table["players"].append(name[:80])
    table["results"] = keep_current_results(table)
    save_state(state)
    return f"Added <b>{escape(name)}</b> to <b>{escape(table['name'])}</b>."


def list_players(chat_id: int) -> str:
    _, table = active_table(chat_id)
    if not table["players"]:
        return "No players yet. Add one with /add Player Name."
    players = "\n".join(f"{index}. {escape(name)}" for index, name in enumerate(table["players"], start=1))
    return f"<b>{escape(table['name'])} players</b>\n{players}"


def show_pairings(chat_id: int) -> str:
    _, table = active_table(chat_id)
    rounds = pairings_for_table(table)
    lines = [f"<b>{escape(table['name'])} pairings</b>"]
    for round_index, round_pairings in enumerate(rounds, start=1):
        lines.append(f"\n<b>Round {round_index}</b>")
        for board_index, game in enumerate(round_pairings, start=1):
            result = table["results"].get(game_key(round_index - 1, board_index - 1, game), "")
            label = result_label(result, game)
            suffix = f" - {escape(label)}" if label else ""
            lines.append(
                f"{board_index}. {escape(game.white)} (White) vs {escape(game.black)} (Black){suffix}"
            )
    return "\n".join(lines)


def submit_result(chat_id: int, text: str) -> str:
    parts = text.split()
    if len(parts) < 3:
        raise ValueError("Usage: /result ROUND BOARD white|black|draw")
    try:
        round_index = int(parts[0]) - 1
        board_index = int(parts[1]) - 1
    except ValueError as error:
        raise ValueError("Round and board must be numbers.") from error
    result = parts[2].lower()
    if result not in {"white", "black", "draw"}:
        raise ValueError("Result must be white, black, or draw.")

    state, table = active_table(chat_id)
    rounds = pairings_for_table(table)
    try:
        game = rounds[round_index][board_index]
    except IndexError as error:
        raise ValueError("That round/board does not exist.") from error

    table["results"][game_key(round_index, board_index, game)] = result
    save_state(state)
    return f"Saved result: {escape(result_label(result, game))}."


def show_standings(chat_id: int) -> str:
    _, table = active_table(chat_id)
    standings = calculate_standings(table)
    if not standings:
        return "Add at least two players to see standings."
    lines = [f"<b>{escape(table['name'])} standings</b>"]
    for index, row in enumerate(standings, start=1):
        lines.append(
            f"{index}. {escape(row['player'])} - {format_points(row['points'])} pts "
            f"({row['wins']}W {row['draws']}D {row['losses']}L)"
        )
    return "\n".join(lines)


def save_backup(chat_id: int) -> str:
    state, table = active_table(chat_id)
    total_games = sum(len(round_pairings) for round_pairings in pairings_for_table(table))
    table["backup"] = {
        "players": list(table["players"]),
        "results": dict(table["results"]),
        "completed": len(table["results"]),
        "totalGames": total_games,
        "savedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    save_state(state)
    return f"Backup saved for <b>{escape(table['name'])}</b>."


def restore_backup(chat_id: int) -> str:
    state, table = active_table(chat_id)
    backup = table.get("backup")
    if not backup:
        raise ValueError("No backup saved for this table.")
    table["players"] = list(backup.get("players", []))
    table["results"] = dict(backup.get("results", {}))
    save_state(state)
    return f"Restored backup for <b>{escape(table['name'])}</b>."


def finish_table(chat_id: int) -> str:
    state, table = active_table(chat_id)
    rounds = pairings_for_table(table)
    standings = calculate_standings(table)
    if not rounds or not standings:
        raise ValueError("Add at least two players before finishing.")

    payload = {
        "title": table["name"],
        "players": table["players"],
        "rounds": rounds_for_export(table, rounds),
        "standings": [{**row, "points": format_points(row["points"])} for row in standings],
        "completed": len(table["results"]),
        "totalGames": sum(len(round_pairings) for round_pairings in rounds),
        "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    index = next_tournament_index()
    base_name = f"tournament-{index:03d}"
    OUTPUTS_DIR.mkdir(exist_ok=True)
    (OUTPUTS_DIR / f"{base_name}.html").write_text(build_report_html(index, payload), encoding="utf-8")
    (OUTPUTS_DIR / f"{base_name}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    table["finishStatus"] = f"Final table saved: {base_name}.html"
    save_state(state)
    return f"Finished <b>{escape(table['name'])}</b>: {base_name}.html"


def active_table(chat_id: int) -> tuple[dict, dict]:
    state = read_tables_state()
    tables = state["tables"]
    if not tables:
        raise ValueError("No tables yet. Create one with /new Table Name.")

    active_id = load_bot_state().get("activeTables", {}).get(str(chat_id))
    table = next((item for item in tables if item["id"] == active_id), None) or tables[0]
    set_active_table(chat_id, table["id"])
    return state, table


def table_from_value(tables: list[dict], value: str) -> dict:
    if not tables:
        raise ValueError("No tables yet. Create one with /new Table Name.")
    if not value:
        raise ValueError("Usage: /use TABLE_NUMBER")
    try:
        index = int(value) - 1
        return tables[index]
    except (ValueError, IndexError) as error:
        raise ValueError("That table number does not exist.") from error


def set_active_table(chat_id: int, table_id: str) -> None:
    state = load_bot_state()
    active_tables = state.setdefault("activeTables", {})
    active_tables[str(chat_id)] = table_id
    save_bot_state(state)


def pairings_for_table(table: dict):
    if len(table["players"]) < 2:
        raise ValueError("Add at least two players first.")
    return create_round_robin(table["players"])


def keep_current_results(table: dict) -> dict:
    if len(table["players"]) < 2:
        return {}
    valid_keys = {
        game_key(round_index, board_index, game)
        for round_index, round_pairings in enumerate(create_round_robin(table["players"]))
        for board_index, game in enumerate(round_pairings)
    }
    return {key: value for key, value in table["results"].items() if key in valid_keys}


def calculate_standings(table: dict) -> list[dict]:
    if len(table["players"]) < 2:
        return []
    standings = {
        player: {
            "player": player,
            "points": 0,
            "played": 0,
            "wins": 0,
            "draws": 0,
            "losses": 0,
            "whiteGames": 0,
            "blackGames": 0,
        }
        for player in table["players"]
    }
    for round_index, round_pairings in enumerate(create_round_robin(table["players"])):
        for board_index, game in enumerate(round_pairings):
            standings[game.white]["whiteGames"] += 1
            standings[game.black]["blackGames"] += 1
            result = table["results"].get(game_key(round_index, board_index, game))
            if not result:
                continue
            standings[game.white]["played"] += 1
            standings[game.black]["played"] += 1
            if result == "white":
                standings[game.white]["points"] += 1
                standings[game.white]["wins"] += 1
                standings[game.black]["losses"] += 1
            elif result == "black":
                standings[game.black]["points"] += 1
                standings[game.black]["wins"] += 1
                standings[game.white]["losses"] += 1
            else:
                standings[game.white]["points"] += 0.5
                standings[game.black]["points"] += 0.5
                standings[game.white]["draws"] += 1
                standings[game.black]["draws"] += 1
    return sorted(
        standings.values(),
        key=lambda row: (-row["points"], -row["wins"], row["player"].lower()),
    )


def rounds_for_export(table: dict, rounds) -> list[list[dict]]:
    exported = []
    for round_index, round_pairings in enumerate(rounds):
        exported_round = []
        for board_index, game in enumerate(round_pairings):
            result = table["results"].get(game_key(round_index, board_index, game), "")
            exported_round.append(
                {
                    "white": game.white,
                    "black": game.black,
                    "result": result,
                    "resultLabel": result_label(result, game),
                }
            )
        exported.append(exported_round)
    return exported


def game_key(round_index: int, board_index: int, game) -> str:
    return f"{round_index}:{board_index}:{game.white}:{game.black}"


def result_label(result: str, game) -> str:
    if result == "white":
        return f"{game.white} wins"
    if result == "black":
        return f"{game.black} wins"
    if result == "draw":
        return "Draw"
    return ""


def format_points(points: float) -> str:
    return str(int(points)) if points == int(points) else f"{points:.1f}"


def save_state(state: dict) -> None:
    state["updatedAt"] = time.time()
    write_tables_state(state)


def load_bot_state() -> dict:
    if not BOT_STATE_FILE.exists():
        return {}
    try:
        return json.loads(BOT_STATE_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_bot_state(state: dict) -> None:
    BOT_STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def create_id() -> str:
    return f"telegram-{int(time.time() * 1000)}"


def escape(value: object) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


if __name__ == "__main__":
    main()
