"""The agent population and the edges along which messages travel."""

from __future__ import annotations

import random

from mosaic.schemas import Agent, ExperimentConfig


def build_agents(cfg: ExperimentConfig) -> list[Agent]:
    p = cfg.population
    agents: list[Agent] = []
    n = 0

    def add(role, team):
        nonlocal n
        aid = f"A{n:03d}"
        n += 1
        agents.append(Agent(id=aid, role=role, team=team, model=cfg.model.model_id, persona=f"synthetic-{role.lower()}"))

    for _ in range(p.coordinator):
        add("Coordinator", 0)
    for team in range(1, p.teams + 1):
        add("Lead", team)
        for _ in range(p.provers_per_team):
            add("Prover", team)
        for _ in range(p.verifiers_per_team):
            add("Verifier", team)
    return agents


def build_edges(agents: list[Agent], kind: str, seed: int = 0) -> dict[str, list[str]]:
    """Undirected adjacency. A hierarchy links coordinator to leads, leads to members, and members in a ring."""
    ids = [a.id for a in agents]
    adj: dict[str, set[str]] = {i: set() for i in ids}

    def link(a, b):
        if a != b:
            adj[a].add(b)
            adj[b].add(a)

    if kind == "full":
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                link(a, b)
    elif kind == "hub":
        for a in ids[1:]:
            link(ids[0], a)
    elif kind in ("ring", "small_world"):
        for i, a in enumerate(ids):
            link(a, ids[(i + 1) % len(ids)])
        if kind == "small_world":
            rng = random.Random(seed)
            for a in ids:
                if rng.random() < 0.1:
                    link(a, rng.choice(ids))
    else:
        coords = [a for a in agents if a.role == "Coordinator"]
        leads = [a for a in agents if a.role == "Lead"]
        for c in coords:
            for lead in leads:
                link(c.id, lead.id)
        for lead in leads:
            members = [a for a in agents if a.team == lead.team and a.role not in ("Lead", "Coordinator")]
            for m in members:
                link(lead.id, m.id)
            for i, m in enumerate(members):
                link(m.id, members[(i + 1) % len(members)].id)
    return {k: sorted(v) for k, v in adj.items()}


def hop_distances(adj: dict[str, list[str]], sources: list[str]) -> dict[str, int]:
    dist = {s: 0 for s in sources}
    frontier = list(sources)
    while frontier:
        nxt = []
        for a in frontier:
            for b in adj.get(a, []):
                if b not in dist:
                    dist[b] = dist[a] + 1
                    nxt.append(b)
        frontier = nxt
    return dist
