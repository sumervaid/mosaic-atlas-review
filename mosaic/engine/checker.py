"""A deterministic stand-in for the Lean 4 proof checker. It evaluates closed arithmetic claims only."""

from __future__ import annotations

import ast
import operator as op
from pathlib import Path

import yaml

_BIN = {ast.Add: op.add, ast.Sub: op.sub, ast.Mult: op.mul, ast.Div: op.truediv, ast.Pow: op.pow}
_CMP = {ast.Eq: op.eq, ast.Lt: op.lt, ast.LtE: op.le, ast.Gt: op.gt, ast.GtE: op.ge}


def _ev(node):
    if isinstance(node, ast.Expression):
        return _ev(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        left, right = _ev(node.left), _ev(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > 16:
            raise ValueError("exponent too large")
        return _BIN[type(node.op)](left, right)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -_ev(node.operand)
    if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "abs" and len(node.args) == 1:
        return abs(_ev(node.args[0]))
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in _CMP:
        return _CMP[type(node.ops[0])](_ev(node.left), _ev(node.comparators[0]))
    raise ValueError("unsupported expression")


def check_claim(claim: str) -> bool | None:
    """True or False for a closed arithmetic comparison. None when the claim cannot be parsed."""
    try:
        result = _ev(ast.parse(claim.strip()[:200], mode="eval"))
    except (ValueError, SyntaxError, ZeroDivisionError, OverflowError, RecursionError, TypeError):
        return None
    return result if isinstance(result, bool) else None


def load_tasks(path: str | Path) -> list[dict]:
    with Path(path).open(encoding="utf-8") as f:
        return yaml.safe_load(f)
