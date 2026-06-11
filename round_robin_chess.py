#!/usr/bin/env python3
"""Generate a round-robin chess pairing table."""

from __future__ import annotations

import argparse
from dataclasses import dataclass


BYE = "BYE"


@dataclass(frozen=True)
class Pairing:
    white: str
    black: str


def create_round_robin(players: list[str]) -> list[list[Pairing]]:
    """Return rounds of chess pairings for the given players.

    Odd-sized fields receive one bye per round. Bye pairings are omitted from
    the returned table.
    """
    if len(players) < 2:
        raise ValueError("At least two players are required.")

    names = [player.strip() for player in players]
    if any(not name for name in names):
        raise ValueError("Player names cannot be empty.")
    if len(set(names)) != len(names):
        raise ValueError("Player names must be unique.")

    if len(names) % 2 == 1:
        names.append(BYE)

    rounds: list[list[Pairing]] = []
    color_balance = {name: 0 for name in names if name != BYE}
    field_size = len(names)
    half = field_size // 2
    rotation = names[:]

    for round_number in range(field_size - 1):
        round_pairings: list[Pairing] = []

        for board in range(half):
            first = rotation[board]
            second = rotation[field_size - 1 - board]
            if BYE in (first, second):
                continue

            if color_balance[first] < color_balance[second]:
                white, black = first, second
            elif color_balance[second] < color_balance[first]:
                white, black = second, first
            elif (round_number + board) % 2 == 0:
                white, black = first, second
            else:
                white, black = second, first

            color_balance[white] += 1
            color_balance[black] -= 1
            round_pairings.append(Pairing(white=white, black=black))

        rounds.append(round_pairings)
        rotation = [rotation[0], rotation[-1], *rotation[1:-1]]

    return rounds


def format_table(rounds: list[list[Pairing]]) -> str:
    """Format rounds as a readable plain-text table."""
    lines: list[str] = []
    for round_index, pairings in enumerate(rounds, start=1):
        lines.append(f"Round {round_index}")
        for board_index, pairing in enumerate(pairings, start=1):
            lines.append(f"  Board {board_index}: {pairing.white} - {pairing.black}")
        lines.append("")
    return "\n".join(lines).rstrip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a round-robin chess pairing table."
    )
    parser.add_argument(
        "players",
        nargs="+",
        help="Player names. Wrap names containing spaces in quotes.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rounds = create_round_robin(args.players)
    print(format_table(rounds))


if __name__ == "__main__":
    main()
