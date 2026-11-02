"""Append-only event log. Each entry is hash-chained and signed with the sender's ed25519 key.

Entries carry no wall-clock time, so two branches that do identical work have identical chains.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

GENESIS = "0" * 64


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def agent_key(experiment_seed: int, experiment_id: str, agent: str) -> Ed25519PrivateKey:
    digest = hashlib.sha256(f"{experiment_id}:{experiment_seed}:{agent}".encode()).digest()
    return Ed25519PrivateKey.from_private_bytes(digest)


def public_hex(key: Ed25519PrivateKey) -> str:
    return key.public_key().public_bytes_raw().hex()


def entry_hash(body: dict) -> str:
    return hashlib.sha256(canonical(body).encode("utf-8")).hexdigest()


class SignedLog:
    def __init__(self, path: str | Path, keys: dict[str, Ed25519PrivateKey], head: str = GENESIS, seq: int = 0):
        self.path = Path(path)
        self.keys = keys
        self.head = head
        self.seq = seq
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.buffer: list[str] = []

    def append(self, step: int, agent: str, kind: str, payload: dict) -> dict:
        self.seq += 1
        body = {"seq": self.seq, "step": step, "agent": agent, "kind": kind, "payload": payload, "prev_hash": self.head}
        h = entry_hash(body)
        entry = dict(body, hash=h, signature=self.keys[agent].sign(bytes.fromhex(h)).hex())
        self.buffer.append(canonical(entry))
        self.head = h
        return entry

    def flush(self) -> None:
        if self.buffer:
            with self.path.open("a", encoding="utf-8") as f:
                f.write("\n".join(self.buffer) + "\n")
            self.buffer = []


def verify(path: str | Path, public_keys: dict[str, str], start_head: str = GENESIS) -> dict:
    """Recompute the chain and every signature. Reports the first bad line, if any."""
    prev = start_head
    n = 0
    with Path(path).open(encoding="utf-8") as f:
        for lineno, line in enumerate(f, start=1):
            n = lineno
            try:
                e = json.loads(line)
                body = {k: e[k] for k in ("seq", "step", "agent", "kind", "payload", "prev_hash")}
                if e["prev_hash"] != prev or e["hash"] != entry_hash(body):
                    return {"ok": False, "entries": n, "first_bad_line": lineno, "reason": "hash"}
                Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_keys[e["agent"]])).verify(
                    bytes.fromhex(e["signature"]), bytes.fromhex(e["hash"]))
            except InvalidSignature:
                return {"ok": False, "entries": n, "first_bad_line": lineno, "reason": "signature"}
            except (KeyError, ValueError, json.JSONDecodeError):
                return {"ok": False, "entries": n, "first_bad_line": lineno, "reason": "format"}
            prev = e["hash"]
    return {"ok": True, "entries": n, "first_bad_line": None, "head": prev}
