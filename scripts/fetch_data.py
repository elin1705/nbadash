"""
Pulls NBA stats from NBA.com (via nba_api) and the NBA CDN, then writes
compact JSON files into docs/data/ for the dashboard to read.

Run locally:   pip install -r requirements.txt && python scripts/fetch_data.py
Run on GitHub: the "Update NBA data" workflow runs this automatically.

Each section is independent: if one endpoint fails, the others still save,
and the failure is listed in docs/data/meta.json so the dashboard can show it.
"""

import json
import os
import sys
import time
import traceback
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import requests
from nba_api.stats.endpoints import (
    leaguedashplayershotlocations,
    leaguedashplayerstats,
    leaguedashptstats,
    leaguedashteamshotlocations,
    leaguedashteamstats,
    leaguegamelog,
    leagueseasonmatchups,
    playerindex,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data")
os.makedirs(OUT, exist_ok=True)

TIMEOUT = 60
PAUSE = 1.0  # seconds between calls, to be polite to NBA.com
ERRORS = []

# Optional proxy (set NBA_PROXY as a GitHub secret if NBA.com blocks GitHub's servers)
PROXY = os.environ.get("NBA_PROXY") or None

HEADERS = {
    "Host": "stats.nba.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://www.nba.com",
    "Referer": "https://www.nba.com/",
    "Connection": "keep-alive",
}


# ---------------------------------------------------------------- helpers
def season_str(dt):
    y = dt.year if dt.month >= 9 else dt.year - 1
    return f"{y}-{(y + 1) % 100:02d}"


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def call(endpoint_cls, label, **kwargs):
    """Call an nba_api endpoint with retries; return the raw response dict."""
    last = None
    for attempt in range(4):
        try:
            ep = endpoint_cls(timeout=TIMEOUT, headers=HEADERS, proxy=PROXY, **kwargs)
            data = ep.get_dict()
            time.sleep(PAUSE)
            return data
        except Exception as e:  # noqa: BLE001
            last = e
            wait = 5 * (attempt + 1)
            log(f"  {label}: attempt {attempt + 1} failed ({type(e).__name__}: {e}); retry in {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"{label} failed after retries: {last}")


def rows(data, index=0):
    """Turn a standard NBA resultSet into a list of dicts."""
    rs = data.get("resultSets", data.get("resultSet"))
    if isinstance(rs, dict):
        rs = [rs]
    s = rs[index]
    cols = s["headers"]
    return [dict(zip(cols, r)) for r in s["rowSet"]]


def zone_rows(data):
    """Parse the shot-location endpoints, which use two-level headers."""
    rs = data["resultSets"]
    if isinstance(rs, list):
        rs = rs[0]
    top, sub = rs["headers"][0], rs["headers"][1]
    skip = top.get("columnsToSkip", 0)
    span = top.get("columnSpan", 3)
    zones = top["columnNames"]
    subcols = sub["columnNames"]
    out = []
    for r in rs["rowSet"]:
        base = dict(zip(subcols[:skip], r[:skip]))
        z = {}
        for i, zone in enumerate(zones):
            vals = r[skip + i * span: skip + (i + 1) * span]
            names = subcols[skip + i * span: skip + (i + 1) * span]
            z[zone] = {n.replace("OPP_", ""): v for n, v in zip(names, vals)}
        base["zones"] = z
        out.append(base)
    return out


def r2(v):
    return round(v, 2) if isinstance(v, float) else v


def save(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    log(f"  saved {name} ({os.path.getsize(path) / 1024:.0f} KB)")


def section(name):
    def deco(fn):
        def wrapper(*a, **k):
            log(f"== {name}")
            try:
                return fn(*a, **k)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                ERRORS.append({"section": name, "error": f"{type(e).__name__}: {e}"[:300]})
                return None
        return wrapper
    return deco


def pos_group(pos):
    if not pos:
        return None
    p = pos.strip().upper()[0]
    return p if p in "GFC" else None


# ---------------------------------------------------------------- sections
@section("Player index (positions)")
def get_positions(season):
    data = call(playerindex.PlayerIndex, "playerindex", season=season, league_id="00")
    out = {}
    for r in rows(data):
        pid = r.get("PERSON_ID")
        pos = r.get("POSITION")
        out[pid] = {
            "pos": pos,
            "grp": pos_group(pos),
            "name": f"{r.get('PLAYER_FIRST_NAME', '')} {r.get('PLAYER_LAST_NAME', '')}".strip(),
            "team": r.get("TEAM_ABBREVIATION"),
            "height": r.get("HEIGHT"),
            "jersey": r.get("JERSEY_NUMBER"),
        }
    return out


@section("Player stats")
def get_player_stats(season):
    def pull(**kw):
        d = call(leaguedashplayerstats.LeagueDashPlayerStats, "playerstats",
                 season=season, per_mode_detailed="PerGame", **kw)
        return {r["PLAYER_ID"]: r for r in rows(d)}

    base = pull()
    l10 = pull(last_n_games=10)
    l5 = pull(last_n_games=5)
    adv = pull(measure_type_detailed_defense="Advanced")
    usage = pull(measure_type_detailed_defense="Usage")
    return base, l10, l5, adv, usage


@section("Tracking (rebound + assist opportunities)")
def get_tracking(season):
    out = {}
    for measure in ("Rebounding", "Passing", "Possessions", "Drives"):
        for label, n in (("season", 0), ("l10", 10), ("l5", 5)):
            d = call(leaguedashptstats.LeagueDashPtStats, f"pt {measure} {label}",
                     season=season, pt_measure_type=measure, player_or_team="Player",
                     per_mode_simple="PerGame", last_n_games=n)
            for r in rows(d):
                out.setdefault(r["PLAYER_ID"], {}).setdefault(label, {}).update(r)
    return out


@section("Player shot zones")
def get_player_zones(season):
    out = {}
    for label, n in (("season", 0), ("l10", 10)):
        d = call(leaguedashplayershotlocations.LeagueDashPlayerShotLocations, f"player zones {label}",
                 season=season, distance_range="By Zone", per_mode_detailed="PerGame", last_n_games=n)
        for r in zone_rows(d):
            out.setdefault(r["PLAYER_ID"], {})[label] = r["zones"]
    return out


@section("Team stats")
def get_team_stats(season):
    def pull(**kw):
        d = call(leaguedashteamstats.LeagueDashTeamStats, "teamstats",
                 season=season, per_mode_detailed="PerGame", **kw)
        return {r["TEAM_ID"]: r for r in rows(d)}

    return {
        "base": pull(),
        "adv": pull(measure_type_detailed_defense="Advanced"),
        "adv_l10": pull(measure_type_detailed_defense="Advanced", last_n_games=10),
        "opp": pull(measure_type_detailed_defense="Opponent"),
        "opp_l10": pull(measure_type_detailed_defense="Opponent", last_n_games=10),
    }


@section("Team opponent shot zones")
def get_team_zones(season):
    out = {}
    for label, n in (("season", 0), ("l10", 10)):
        for kind in ("Base", "Opponent"):
            d = call(leaguedashteamshotlocations.LeagueDashTeamShotLocations, f"team zones {kind} {label}",
                     season=season, distance_range="By Zone", measure_type_simple=kind,
                     per_mode_detailed="PerGame", last_n_games=n)
            for r in zone_rows(d):
                key = "own" if kind == "Base" else "allowed"
                out.setdefault(r["TEAM_ID"], {}).setdefault(label, {})[key] = r["zones"]
    return out


@section("Game logs")
def get_gamelogs(season):
    d = call(leaguegamelog.LeagueGameLog, f"gamelog {season}", season=season,
             player_or_team_abbreviation="P")
    return rows(d)


@section("Defender matchups")
def get_matchups(season, team_ids, min_poss):
    out = []
    for tid in team_ids:
        d = call(leagueseasonmatchups.LeagueSeasonMatchups, f"matchups {season} {tid}",
                 season=season, off_team_id_nullable=tid, per_mode_simple="Totals")
        for r in rows(d):
            poss = r.get("PARTIAL_POSS") or 0
            if poss < min_poss:
                continue
            out.append([
                r.get("OFF_PLAYER_ID"), r.get("DEF_PLAYER_ID"), r.get("DEF_PLAYER_NAME"),
                r.get("GP"), r2(r.get("MATCHUP_MIN")), r2(poss), r.get("PLAYER_PTS"),
                r.get("MATCHUP_AST"), r.get("MATCHUP_TOV"), r.get("MATCHUP_FGM"),
                r.get("MATCHUP_FGA"), r.get("MATCHUP_FG3M"), r.get("MATCHUP_FG3A"),
                r.get("MATCHUP_BLK"), r.get("SFL"),
            ])
    return out


@section("Schedule")
def get_schedule():
    url = "https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json"
    resp = requests.get(url, timeout=TIMEOUT, headers={"User-Agent": HEADERS["User-Agent"]},
                        proxies={"https": PROXY, "http": PROXY} if PROXY else None)
    resp.raise_for_status()
    data = resp.json()
    now = datetime.now(timezone.utc)
    lo, hi = now - timedelta(hours=14), now + timedelta(days=4)
    games = []
    for gd in data["leagueSchedule"]["gameDates"]:
        for g in gd["games"]:
            t = g.get("gameDateTimeUTC")
            if not t:
                continue
            dt = datetime.fromisoformat(t.replace("Z", "+00:00"))
            if lo <= dt <= hi and g["homeTeam"].get("teamId") and g["awayTeam"].get("teamId"):
                games.append({
                    "id": g["gameId"], "utc": t, "status": g.get("gameStatusText"),
                    "home": g["homeTeam"]["teamId"], "away": g["awayTeam"]["teamId"],
                    "homeTri": g["homeTeam"].get("teamTricode"), "awayTri": g["awayTeam"].get("teamTricode"),
                    "homeScore": g["homeTeam"].get("score"), "awayScore": g["awayTeam"].get("score"),
                })
    games.sort(key=lambda g: g["utc"])
    return games


# ---------------------------------------------------------------- derived
LOG_COLS = ["date", "opp", "home", "wl", "min", "pts", "reb", "oreb", "dreb", "ast", "fg3m", "fg3a",
            "fgm", "fga", "ftm", "fta", "stl", "blk", "tov", "pf", "pm", "gid"]


def compact_logs(raw):
    by_player = defaultdict(list)
    for r in raw:
        m = r["MATCHUP"]
        home = 1 if "vs." in m else 0
        opp = m.split(" ")[-1]
        by_player[r["PLAYER_ID"]].append([
            r["GAME_DATE"], opp, home, r["WL"], r2(r["MIN"]), r["PTS"], r["REB"], r["OREB"], r["DREB"],
            r["AST"], r["FG3M"], r["FG3A"], r["FGM"], r["FGA"], r["FTM"], r["FTA"], r["STL"], r["BLK"],
            r["TOV"], r["PF"], r["PLUS_MINUS"], r["GAME_ID"],
        ])
    for pid in by_player:
        by_player[pid].sort(key=lambda x: x[0], reverse=True)  # newest first
    return by_player


DVP_STATS = ["PTS", "REB", "AST", "FG3M", "STL", "BLK", "TOV", "FGA", "MIN"]


def build_dvp(raw, positions, team_abbr_to_id):
    """Per defending team: average stats allowed per game to G / F / C."""
    # game -> defending team -> group -> summed stats
    agg = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    game_dates = {}
    for r in raw:
        grp = (positions.get(r["PLAYER_ID"]) or {}).get("grp")
        if not grp:
            continue
        opp_abbr = r["MATCHUP"].split(" ")[-1]
        def_id = team_abbr_to_id.get(opp_abbr)
        if not def_id:
            continue
        key = (r["GAME_ID"], def_id)
        game_dates[key] = r["GAME_DATE"]
        for s in DVP_STATS:
            agg[key][grp][s] += r.get(s) or 0
    per_team = defaultdict(list)
    for (gid, tid), groups in agg.items():
        per_team[tid].append((game_dates[(gid, tid)], groups))

    out = {}
    for tid, games in per_team.items():
        games.sort(key=lambda x: x[0], reverse=True)
        out[tid] = {}
        for label, subset in (("season", games), ("l10", games[:10])):
            n = len(subset)
            out[tid][label] = {"gp": n}
            for grp in "GFC":
                out[tid][label][grp] = {
                    s: round(sum(g[1][grp][s] for g in subset) / n, 2) if n else None for s in DVP_STATS
                }
                v = out[tid][label][grp]
                if n:
                    v["PRA"] = round(v["PTS"] + v["REB"] + v["AST"], 2)
    # ranks: 30 = allows the most (best matchup for the offence)
    for label in ("season", "l10"):
        for grp in "GFC":
            for s in DVP_STATS + ["PRA"]:
                vals = sorted(
                    [(out[t][label][grp].get(s), t) for t in out if out[t][label][grp].get(s) is not None]
                )
                for rank, (_, t) in enumerate(vals, start=1):
                    out[t][label][grp].setdefault("rank", {})[s] = rank
    return out


def slim(d, keep):
    if not d:
        return None
    return {k: r2(d[k]) for k in keep if k in d and d[k] is not None}


BASE_KEEP = ["GP", "MIN", "PTS", "REB", "OREB", "DREB", "AST", "STL", "BLK", "TOV", "FGM", "FGA", "FG_PCT",
             "FG3M", "FG3A", "FG3_PCT", "FTM", "FTA", "FT_PCT", "PLUS_MINUS", "PF", "W", "L"]
ADV_KEEP = ["USG_PCT", "TS_PCT", "EFG_PCT", "OFF_RATING", "DEF_RATING", "NET_RATING", "AST_PCT", "REB_PCT",
            "OREB_PCT", "DREB_PCT", "PACE", "PIE", "POSS"]
USG_KEEP = ["PCT_FGA", "PCT_FG3A", "PCT_FTA", "PCT_REB", "PCT_AST", "PCT_PTS"]
TRACK_KEEP = ["REB_CHANCES", "REB_CHANCE_PCT", "REB_CHANCE_PCT_ADJ", "REB_CONTEST", "REB_UNCONTEST",
              "REB_CONTEST_PCT", "OREB_CHANCES", "DREB_CHANCES", "AVG_REB_DIST", "PASSES_MADE",
              "PASSES_RECEIVED", "POTENTIAL_AST", "SECONDARY_AST", "FT_AST", "AST_POINTS_CREATED",
              "AST_ADJ", "AST_TO_PASS_PCT", "TOUCHES", "FRONT_CT_TOUCHES", "TIME_OF_POSS",
              "ELBOW_TOUCHES", "POST_TOUCHES", "PAINT_TOUCHES", "DRIVES", "DRIVE_PTS", "DRIVE_FGA",
              "DRIVE_AST", "DRIVE_PASSES"]
TEAM_ADV = ["PACE", "OFF_RATING", "DEF_RATING", "NET_RATING", "EFG_PCT", "TS_PCT", "REB_PCT", "AST_PCT",
            "TM_TOV_PCT", "OREB_PCT", "DREB_PCT"]
TEAM_OPP = ["OPP_PTS", "OPP_REB", "OPP_OREB", "OPP_AST", "OPP_FG3M", "OPP_FG3A", "OPP_FGA", "OPP_FG_PCT",
            "OPP_FG3_PCT", "OPP_TOV", "OPP_STL", "OPP_BLK", "OPP_FTA"]


def zones_slim(z):
    if not z:
        return None
    return {zone: {k: r2(v) for k, v in vals.items()} for zone, vals in z.items()}


# ---------------------------------------------------------------- main
def main():
    now = datetime.now(timezone.utc)
    season = os.environ.get("NBA_SEASON") or season_str(now)
    prev = season_str(datetime(int(season[:4]) - 1, 12, 1))
    log(f"Season {season} (previous {prev})")

    positions = get_positions(season) or {}
    ps = get_player_stats(season)
    tracking = get_tracking(season) or {}
    pzones = get_player_zones(season) or {}
    teams = get_team_stats(season)
    tzones = get_team_zones(season) or {}
    logs_now = get_gamelogs(season) or []
    logs_prev = get_gamelogs(prev) or []
    schedule = get_schedule()

    if ps is None and not logs_now:
        log("Nothing could be fetched — NBA.com is probably blocking this machine.")
        save("meta.json", {"updated": now.isoformat(), "season": season, "errors": ERRORS, "ok": False})
        sys.exit(1)

    base, l10, l5, adv, usage = ps if ps else ({}, {}, {}, {}, {})

    # ---- teams
    team_out = {}
    abbr_to_id = {}
    if teams:
        for tid, b in teams["base"].items():
            abbr = None
            # find abbreviation from any player on that team
            for r in base.values():
                if r["TEAM_ID"] == tid:
                    abbr = r["TEAM_ABBREVIATION"]
                    break
            if abbr is None:
                for r in logs_now:
                    if r["TEAM_ID"] == tid:
                        abbr = r["TEAM_ABBREVIATION"]
                        break
            abbr_to_id[abbr] = tid
            team_out[tid] = {
                "id": tid, "abbr": abbr, "name": b["TEAM_NAME"],
                "base": slim(b, BASE_KEEP),
                "adv": slim(teams["adv"].get(tid), TEAM_ADV),
                "adv_l10": slim(teams["adv_l10"].get(tid), TEAM_ADV),
                "opp": slim(teams["opp"].get(tid), TEAM_OPP),
                "opp_l10": slim(teams["opp_l10"].get(tid), TEAM_OPP),
                "zones": {lbl: {k: zones_slim(v) for k, v in d.items()} for lbl, d in tzones.get(tid, {}).items()},
            }
    else:
        for r in logs_now:
            abbr_to_id[r["TEAM_ABBREVIATION"]] = r["TEAM_ID"]

    # ---- dvp
    dvp = build_dvp(logs_now, positions, abbr_to_id) if logs_now and positions else {}
    if dvp:
        for tid, d in dvp.items():
            team_out.setdefault(tid, {"id": tid})["dvp"] = d

    # ---- players
    player_out = {}
    for pid, b in base.items():
        tr = tracking.get(pid, {})
        player_out[pid] = {
            "id": pid,
            "name": b["PLAYER_NAME"],
            "team": b["TEAM_ABBREVIATION"],
            "teamId": b["TEAM_ID"],
            "age": b.get("AGE"),
            "pos": (positions.get(pid) or {}).get("pos"),
            "grp": (positions.get(pid) or {}).get("grp"),
            "season": slim(b, BASE_KEEP),
            "l10": slim(l10.get(pid), BASE_KEEP),
            "l5": slim(l5.get(pid), BASE_KEEP),
            "adv": slim(adv.get(pid), ADV_KEEP),
            "usage": slim(usage.get(pid), USG_KEEP),
            "track": {lbl: slim(tr.get(lbl), TRACK_KEEP) for lbl in ("season", "l10", "l5") if tr.get(lbl)},
            "zones": {lbl: zones_slim(z) for lbl, z in pzones.get(pid, {}).items()},
        }

    save("players.json", list(player_out.values()))
    save("teams.json", list(team_out.values()))

    logs = {"cols": LOG_COLS, "current": compact_logs(logs_now), "previous": compact_logs(logs_prev)}
    save("gamelogs.json", logs)

    if schedule is not None:
        save("schedule.json", schedule)

    # matchups last: slowest and the most optional
    team_ids = sorted(t for t in team_out if t)
    m_now = get_matchups(season, team_ids, 5) or []
    m_prev = get_matchups(prev, team_ids, 20) or []
    save("matchups.json", {
        "cols": ["off", "def", "defName", "gp", "min", "poss", "pts", "ast", "tov", "fgm", "fga",
                 "fg3m", "fg3a", "blk", "sfl"],
        "current": m_now, "previous": m_prev,
    })

    save("meta.json", {
        "updated": now.isoformat(), "season": season, "previous": prev,
        "errors": ERRORS, "ok": True,
        "counts": {"players": len(player_out), "teams": len(team_out), "games_today": len(schedule or [])},
    })
    log(f"Done with {len(ERRORS)} section error(s).")


if __name__ == "__main__":
    main()
