""" MCP сервер для P6Matrix.
Один порт 3201, маршруты:
  GET /sse - SSE транспорт (Claude Desktop, MCP Inspector)
  POST /messages - обратный канал SSE
  POST /mcp - Streamable HTTP транспорт (браузерные MCP клиенты)
Запуск:
  uvicorn mcp_server:app --host 0.0.0.0 --port 3201
Подключение:
  SSE: http://localhost:3201/sse (transport=sse)
  Streamable HTTP: http://localhost:3201/mcp (transport=streamable-http) """

from __future__ import annotations
import contextlib, pathlib, re
from typing import Any, AsyncIterator, Optional

from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Route, Mount

SHARED_PXP = pathlib.Path(__file__).parent / "shared.pxp"

def _load_pxp() -> str:
    if not SHARED_PXP.exists():
        raise FileNotFoundError(
            "shared.pxp not found. Use the Share button in P6Matrix UI first.")
    return SHARED_PXP.read_text(encoding="utf-8")

def _parse_pxp(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "meta": {}, "activities": [], "relations": [],
        "resources": [], "assignments": []}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("@"):
            section = line
            continue
        if section == "@META":
            if "=" in line:
                k, v = line.split("=", 1)
                out["meta"][k.strip()] = v.strip()
        elif section == "@ACTIVITIES":
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 4 and parts[0]:
                def g(i: int, d: Any = None) -> Any:
                    return parts[i] if len(parts) > i and parts[i] else d
                def flt(i: int, d: float = 0.0) -> float:
                    try: return float(g(i, d) or d)
                    except: return float(d) if d is not None else 0.0
                out["activities"].append({
                    "id": g(0), "name": g(1, ""),
                    "duration": flt(2), "act_type": g(3, "task_dependent"),
                    "cal_id": g(4), "parent_id": g(5),
                    "constraint_es": g(6), "constraint_type": g(7),
                    "actual_start": g(8), "actual_finish": g(9),
                    "pct_complete": flt(10), "priority": g(11, "0"), "notes": g(12, ""),
                    "actual_duration":    float(g(13)) if g(13) else None,
                    "remaining_duration": float(g(14)) if g(14) else None})
        elif section == "@RELATIONS":
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 3 and parts[0] and parts[1]:
                try: lag = float(parts[3]) if len(parts) > 3 and parts[3] else 0.0
                except: lag = 0.0
                out["relations"].append({
                    "pred": parts[0], "succ": parts[1],
                    "type": (parts[2] or "FS").upper(), "lag": lag})
        elif section == "@RESOURCES":
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 3 and parts[0]:
                try: max_u = float(parts[2])
                except: max_u = 1.0
                try: cost = float(parts[3]) if len(parts) > 3 and parts[3] else 0.0
                except: cost = 0.0
                out["resources"].append({
                    "id": parts[0], "name": parts[1] if len(parts) > 1 else parts[0],
                    "max_units": max_u, "cost_per_unit": cost})
        elif section == "@ASSIGNMENTS":
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 2 and parts[0] and parts[1]:
                is_new = len(parts) >= 4 and (
                    parts[2] == "" or not parts[2].replace(".", "").isdigit()
                )
                raw_u = parts[3] if is_new else (parts[2] if len(parts) > 2 else "")
                try: units = float(raw_u) if raw_u else 0.0
                except: units = 0.0
                out["assignments"].append({
                    "activity_id": parts[0], "resource_id": parts[1], "units": units})
    return out

def _parse_schedule_results(text: str) -> dict[str, dict]:
    """ Парсит секцию @SCHEDULE_RESULTS, записанную фронтом при шаринге.
    Формат строки:
      act_id | es_date | ef_date | ls_date | lf_date | tf | ff | on_critical | pct_complete | actual_start | actual_finish | status
    Возвращает dict: act_id → dict с рассчитанными полями """
    results: dict[str, dict] = {}
    in_section = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            if line.startswith('@'):
                in_section = line == '@SCHEDULE_RESULTS'
            continue
        if line.startswith('@'):
            in_section = line == '@SCHEDULE_RESULTS'
            continue
        if not in_section:
            continue
        parts = [p.strip() for p in line.split('|')]
        if len(parts) < 12 or not parts[0]:
            continue
        def g(i: int, d: Any = None) -> Any:
            return parts[i] if len(parts) > i and parts[i] else d
        def flt(i: int, d: float = 0.0) -> float:
            try: return float(g(i, d) or d)
            except: return d
        results[parts[0]] = {
            'es_date':      g(1),
            'ef_date':      g(2),
            'ls_date':      g(3),
            'lf_date':      g(4),
            'tf':           flt(5),
            'ff':           flt(6),
            'on_critical':  g(7) == '1',
            'pct_complete': flt(8),
            'actual_start': g(9),
            'actual_finish':g(10),
            'status':       g(11, 'not_started')}
    return results

def _load_with_results() -> tuple[dict[str, Any], dict[str, dict]]:
    """ Загружает PXP и результаты расчёта вместе """
    text = _load_pxp()
    data = _parse_pxp(text)
    sched = _parse_schedule_results(text)
    return data, sched


# ─── Auth stub (Keycloak) ─────────────────────────────────────────────────────
# Раскомментировать для реальной интеграции:
#
# from python_keycloak import KeycloakOpenID
# from mcp.server.auth.provider import TokenVerifier
#
# KC = KeycloakOpenID(server_url="https://keycloak.example.com/",
#                     realm_name="p6matrix", client_id="mcp-server",
#                     client_secret_key="SECRET")
#
# class KeycloakVerifier(TokenVerifier):
#     async def verify_token(self, token: str) -> dict:
#         info = KC.introspect(token)
#         if not info.get("active"): raise ValueError("Token inactive")
#         return {"sub": info["sub"], "username": info.get("preferred_username", "")}
#
# mcp = FastMCP(..., token_verifier=KeycloakVerifier())


def _impl_get_schedule_summary() -> dict:
    data, sched = _load_with_results()
    acts = data["activities"]
    total = len(acts)
    # Используем рассчитанные статусы из @SCHEDULE_RESULTS если есть
    def _st(a: dict) -> str:
        sr = sched.get(a["id"])
        if sr: return sr["status"]
        if a["actual_finish"] or a["pct_complete"] >= 100: return "completed"
        if a["actual_start"]: return "in_progress"
        return "not_started"
    completed   = sum(1 for a in acts if _st(a) == "completed")
    in_progress = sum(1 for a in acts if _st(a) == "in_progress")
    return {
        "project_id":        data["meta"].get("project_id", ""),
        "project_name":      data["meta"].get("project_name", ""),
        "start_date":        data["meta"].get("start_date", ""),
        "data_date":         data["meta"].get("data_date", ""),
        "must_finish":       data["meta"].get("must_finish", ""),
        "total_activities":  total,
        "milestones":        sum(1 for a in acts if a["act_type"] == "milestone" or a["duration"] == 0),
        "completed":         completed,
        "in_progress":       in_progress,
        "not_started":       max(0, total - completed - in_progress),
        "total_relations":   len(data["relations"]),
        "total_resources":   len(data["resources"]),
        "total_assignments": len(data["assignments"]),
        "has_schedule_results": bool(sched)}

def _impl_get_project_activities(
    status: Optional[str], task_type: Optional[str],
    name_contains: Optional[str], limit: int) -> list[dict]:
    data, sched = _load_with_results()
    def _st(a: dict) -> str:
        sr = sched.get(a["id"])
        if sr: return sr["status"]
        if a["actual_finish"] or a["pct_complete"] >= 100: return "completed"
        if a["actual_start"]: return "in_progress"
        return "not_started"
    result = []
    for a in data["activities"]:
        st = _st(a)
        if status and st != status: continue
        if task_type and a["act_type"] != task_type: continue
        if name_contains and name_contains.lower() not in (a["name"] or "").lower(): continue
        sr = sched.get(a["id"], {})
        pct = sr.get("pct_complete", a["pct_complete"])
        result.append({
            "id": a["id"], "name": a["name"], "duration": a["duration"],
            "act_type": a["act_type"], "status": st, "pct_complete": pct,
            "es_date": sr.get("es_date"), "ef_date": sr.get("ef_date"),
            "ls_date": sr.get("ls_date"), "lf_date": sr.get("lf_date"),
            "total_float": sr.get("tf"),  "free_float": sr.get("ff"),
            "on_critical": sr.get("on_critical"),
            "actual_start":  sr.get("actual_start") or a["actual_start"],
            "actual_finish": sr.get("actual_finish") or a["actual_finish"],
            "actual_duration": a["actual_duration"],
            "remaining_duration": a["remaining_duration"]})
        if len(result) >= limit: break
    return result

def _impl_get_critical_path() -> list[dict]:
    """ Critical path - из @SCHEDULE_RESULTS (рассчитано фронтом).
    Если @SCHEDULE_RESULTS нет - запускаем CPM здесь """
    data, sched = _load_with_results()
    acts = data["activities"]

    if not acts:
        return []

    # Если есть рассчитанные данные фронта - используем их
    if sched:
        result = []
        for a in acts:
            sr = sched.get(a["id"])
            if not sr or not sr.get("on_critical"):
                continue
            result.append({
                "id": a["id"], "name": a["name"], "duration": a["duration"],
                "es_date": sr["es_date"], "ef_date": sr["ef_date"],
                "ls_date": sr["ls_date"], "lf_date": sr["lf_date"],
                "total_float": sr["tf"], "free_float": sr["ff"],
                "act_type": a["act_type"],
                "pct_complete": sr.get("pct_complete", a["pct_complete"]),
                "status": sr["status"],
                "actual_start":  sr.get("actual_start") or a["actual_start"],
                "actual_finish": sr.get("actual_finish") or a["actual_finish"]})
        result.sort(key=lambda x: x.get("es_date") or "")
        return result

    # Fallback CPM (для файлов без @SCHEDULE_RESULTS)
    acts = data["activities"]
    rels = data["relations"]
    act_map = {a["id"]: a for a in acts}
    dur = {a["id"]: a["duration"] for a in acts}
    # Построим список преемников и подсчитаем ES/EF через топологический прямой проход
    succs: dict[str, list[tuple[str, float]]] = {a["id"]: [] for a in acts}
    preds: dict[str, list[tuple[str, float]]] = {a["id"]: [] for a in acts}
    in_deg: dict[str, int] = {a["id"]: 0 for a in acts}
    for r in rels:
        if r["pred"] in succs and r["succ"] in preds:
            succs[r["pred"]].append((r["succ"], r["lag"]))
            preds[r["succ"]].append((r["pred"], r["lag"]))
            in_deg[r["succ"]] += 1
    # Топологическая сортировка (Kahn)
    from collections import deque
    queue: deque[str] = deque(a["id"] for a in acts if in_deg[a["id"]] == 0)
    topo: list[str] = []
    deg = dict(in_deg)
    while queue:
        u = queue.popleft()
        topo.append(u)
        for v, _ in succs.get(u, []):
            deg[v] -= 1
            if deg[v] == 0:
                queue.append(v)
    if len(topo) < len(acts):
        # Цикл - возвращаем все работы с constraint_es как fallback
        result = []
        for a in acts:
            if a["constraint_es"] is not None:
                try: es = float(a["constraint_es"])
                except: es = 0.0
                result.append({
                    "id": a["id"], "name": a["name"], "duration": a["duration"],
                    "es": es, "ef": es + a["duration"], "total_float": 0.0,
                    "act_type": a["act_type"], "pct_complete": a["pct_complete"]})
        result.sort(key=lambda x: x["es"])
        return result
    # Прямой проход - вычисляем ES (Early Start) и EF (Early Finish)
    es: dict[str, float] = {}
    ef: dict[str, float] = {}
    for aid in topo:
        a = act_map[aid]
        # constraint_es как нижняя граница
        constraint = float(a["constraint_es"]) if a["constraint_es"] else 0.0
        earliest = constraint
        for pred_id, lag in preds.get(aid, []):
            earliest = max(earliest, ef.get(pred_id, 0.0) + lag)
        es[aid] = earliest
        ef[aid] = earliest + dur[aid]
    project_finish = max(ef.values()) if ef else 0.0
    # Обратный проход - LF (Late Finish) и LS (Late Start)
    lf: dict[str, float] = {aid: project_finish for aid in act_map}
    for aid in reversed(topo):
        for succ_id, lag in succs.get(aid, []):
            lf[aid] = min(lf[aid], lf.get(succ_id, project_finish) - dur.get(succ_id, 0.0) - lag)
    ls: dict[str, float] = {aid: lf[aid] - dur[aid] for aid in act_map}
    # Total float = LS - ES
    result = []
    for a in acts:
        aid = a["id"]
        tf = round(ls.get(aid, 0.0) - es.get(aid, 0.0), 4)
        if abs(tf) < 0.01:   # критический путь: TF ≈ 0
            result.append({
                "id": a["id"], "name": a["name"], "duration": a["duration"],
                "es": round(es.get(aid, 0.0), 2), "ef": round(ef.get(aid, 0.0), 2),
                "ls": round(ls.get(aid, 0.0), 2), "lf": round(lf.get(aid, 0.0), 2),
                "total_float": tf,
                "act_type": a["act_type"], "pct_complete": a["pct_complete"],
                "actual_start": a["actual_start"], "actual_finish": a["actual_finish"]})
    result.sort(key=lambda x: x["es"])
    return result

def _impl_get_resources() -> list[dict]:
    return _parse_pxp(_load_pxp())["resources"]

def _impl_get_resource_assignments(resource_id: Optional[str]) -> list[dict]:
    data = _parse_pxp(_load_pxp())
    act_map = {a["id"]: a["name"] for a in data["activities"]}
    res_map = {r["id"]: r["name"] for r in data["resources"]}
    return [
        {"activity_id": a["activity_id"], "activity_name": act_map.get(a["activity_id"], ""),
         "resource_id": a["resource_id"],  "resource_name": res_map.get(a["resource_id"], ""),
         "units": a["units"]}
        for a in data["assignments"]
        if not resource_id or a["resource_id"] == resource_id]

def _impl_analyze_resource_utilization() -> list[dict]:
    data = _parse_pxp(_load_pxp())
    res_map = {r["id"]: r for r in data["resources"]}
    util: dict[str, dict] = {
        r["id"]: {"resource_id": r["id"], "resource_name": r["name"],
                  "max_units": r["max_units"], "total_assigned_units": 0.0,
                  "activity_count": 0, "overallocated": False}
        for r in data["resources"]}
    for a in data["assignments"]:
        rid = a["resource_id"]
        if rid not in util: continue
        util[rid]["total_assigned_units"] += a["units"]
        util[rid]["activity_count"] += 1
        if rid in res_map and a["units"] > res_map[rid]["max_units"]:
            util[rid]["overallocated"] = True
    return sorted(util.values(), key=lambda x: -x["total_assigned_units"])

def _impl_check_schedule_quality() -> dict:
    data, sched = _load_with_results()
    acts  = data["activities"]
    if sched:
        acts = [{**a, **{k: v for k, v in sched.get(a["id"], {}).items()
                         if k in ("pct_complete","actual_start","actual_finish","status")}}
                for a in acts]
    rels  = data["relations"]
    asgns = data["assignments"]
    has_pred = {r["succ"] for r in rels}
    has_succ = {r["pred"] for r in rels}
    has_res  = {a["activity_id"] for a in asgns}
    non_mile = [a for a in acts if a["act_type"] != "milestone"]
    total = len(acts)
    score = 100
    issues: list[dict] = []
    def _chk(lst: list, label: str, weight: int = 5) -> None:
        nonlocal score
        pct = len(lst) / total * 100 if total else 0
        if pct > 0:
            score -= min(weight, int(pct))
            issues.append({"check": label, "count": len(lst), "pct": round(pct, 1), "ids": lst[:10]})
    _chk([a["id"] for a in non_mile if a["id"] not in has_pred], "missing_predecessors", 10)
    _chk([a["id"] for a in non_mile if a["id"] not in has_succ], "missing_successors", 10)
    _chk([a["id"] for a in non_mile if a["duration"] > 44], "long_durations_gt_44d", 5)
    _chk([a["id"] for a in non_mile if a["id"] not in has_res], "unresourced_tasks", 5)
    _chk([a["id"] for a in non_mile if a["duration"] == 0], "zero_duration_non_milestone", 5)
    _chk([a["id"] for a in acts if a["actual_finish"] and a["pct_complete"] < 100],
         "actual_finish_but_pct_lt_100", 3)
    all_checks = ["missing_predecessors","missing_successors","long_durations_gt_44d",
                  "unresourced_tasks","zero_duration_non_milestone","actual_finish_but_pct_lt_100"]
    return {"overall_score": max(0, score), "total_activities": total, "issues": issues,
            "passed": [c for c in all_checks if not any(i["check"] == c for i in issues)]}

def _impl_get_wbs() -> list[dict]:
    return [{"id": a["id"], "name": a["name"], "parent_id": a["parent_id"],
             "act_type": a["act_type"], "duration": a["duration"]}
            for a in _parse_pxp(_load_pxp())["activities"]]

def _impl_get_relationships(activity_id: Optional[str]) -> list[dict]:
    data = _parse_pxp(_load_pxp())
    act_map = {a["id"]: a["name"] for a in data["activities"]}
    return [
        {"pred": r["pred"], "pred_name": act_map.get(r["pred"], ""),
         "succ": r["succ"], "succ_name": act_map.get(r["succ"], ""),
         "type": r["type"], "lag": r["lag"]}
        for r in data["relations"]
        if not activity_id or r["pred"] == activity_id or r["succ"] == activity_id]

def _impl_get_calendars() -> dict:
    meta = _parse_pxp(_load_pxp())["meta"]
    cal = meta.get("calendar", "5d8h")
    dm = re.search(r"(\d+)d", cal); hm = re.search(r"(\d+)h", cal)
    dpw = int(dm.group(1)) if dm else 5; hpd = int(hm.group(1)) if hm else 8
    return {"calendar_code": cal, "days_per_week": dpw, "hours_per_day": hpd,
            "hours_per_week": dpw * hpd, "duration_unit": meta.get("duration_unit", "days")}

def _impl_get_earned_value() -> dict:
    data = _parse_pxp(_load_pxp())
    acts = {a["id"]: a for a in data["activities"]}
    BAC = PV = EV = AC = 0.0
    for asgn in data["assignments"]:
        act = acts.get(asgn["activity_id"])
        if not act: continue
        bac_a = act["duration"] * asgn["units"]
        BAC += bac_a; PV += bac_a
        EV  += (act["pct_complete"] / 100.0) * bac_a
        AC  += (act["actual_duration"] or 0.0) * asgn["units"]
    CV = EV - AC; SV = EV - PV
    CPI = round(EV / AC, 3) if AC > 0 else None
    SPI = round(EV / PV, 3) if PV > 0 else None
    EAC = round(AC + (BAC - EV) / CPI, 2) if CPI and CPI > 0 else None
    return {"BAC": round(BAC, 2), "PV": round(PV, 2), "EV": round(EV, 2), "AC": round(AC, 2),
            "CV": round(CV, 2), "SV": round(SV, 2), "CPI": CPI, "SPI": SPI, "EAC": EAC,
            "pct_complete_overall": round(EV / BAC * 100, 1) if BAC > 0 else 0.0}

def _impl_get_activity_detail(activity_id: str) -> dict:
    data, sched = _load_with_results()
    act_map = {a["id"]: a for a in data["activities"]}
    res_map = {r["id"]: r["name"] for r in data["resources"]}
    act = act_map.get(activity_id)
    if not act: raise ValueError(f"Activity '{activity_id}' not found in shared.pxp")
    sr = sched.get(activity_id, {})
    def _st(a: dict) -> str:
        s = sr.get("status")
        if s: return s
        if a["actual_finish"] or a["pct_complete"] >= 100: return "completed"
        if a["actual_start"]: return "in_progress"
        return "not_started"
    return {
        **act,
        # Плановые даты из @SCHEDULE_RESULTS
        "es_date":      sr.get("es_date"),
        "ef_date":      sr.get("ef_date"),
        "ls_date":      sr.get("ls_date"),
        "lf_date":      sr.get("lf_date"),
        "total_float":  sr.get("tf"),
        "free_float":   sr.get("ff"),
        "on_critical":  sr.get("on_critical"),
        "pct_complete": sr.get("pct_complete", act["pct_complete"]),
        "actual_start":  sr.get("actual_start") or act["actual_start"],
        "actual_finish": sr.get("actual_finish") or act["actual_finish"],
        "status": _st(act),
        "schedule_results_available": bool(sr),
        "predecessors": [
            {"pred": r["pred"], "pred_name": act_map.get(r["pred"], {}).get("name", ""),
             "type": r["type"], "lag": r["lag"]}
            for r in data["relations"] if r["succ"] == activity_id
        ],
        "successors": [
            {"succ": r["succ"], "succ_name": act_map.get(r["succ"], {}).get("name", ""),
             "type": r["type"], "lag": r["lag"]}
            for r in data["relations"] if r["pred"] == activity_id
        ],
        "assignments": [
            {"resource_id": a["resource_id"],
             "resource_name": res_map.get(a["resource_id"], a["resource_id"]),
             "units": a["units"]}
            for a in data["assignments"] if a["activity_id"] == activity_id]}

mcp = FastMCP(
    name="P6Matrix MCP",
    instructions=(
        "P6Matrix CPM Schedule server. "
        "get_schedule_summary for overview, get_project_activities for tasks, "
        "get_critical_path for critical path (real CPM calculation), "
        "get_earned_value for EVM metrics."
    ),
    host="0.0.0.0",
    port=3201)

@mcp.tool()
def get_general_data() -> dict:
    """General data: project meta, counts, status breakdown."""
    return _impl_get_schedule_summary()

@mcp.tool()
def get_schedule_summary() -> dict:
    """At-a-glance stats: total/completed/in-progress/not-started, dates."""
    return _impl_get_schedule_summary()

@mcp.tool()
def get_project_activities(
    status: Optional[str] = None,
    task_type: Optional[str] = None,
    name_contains: Optional[str] = None,
    limit: int = 1000) -> list[dict]:
    """Activities. Filters: status(not_started|in_progress|completed), task_type, name_contains."""
    return _impl_get_project_activities(status, task_type, name_contains, limit)

@mcp.tool()
def get_critical_path() -> list[dict]:
    """
    Critical path activities (total float = 0), computed via CPM forward+backward pass.
    Returns activities sorted by early start with ES, EF, LS, LF, total_float fields.
    """
    return _impl_get_critical_path()

@mcp.tool()
def get_resources() -> list[dict]:
    """All resources with max_units and cost_per_unit."""
    return _impl_get_resources()

@mcp.tool()
def get_resource_assignments(resource_id: Optional[str] = None) -> list[dict]:
    """Resource-activity assignments enriched with names. Filter by resource_id."""
    return _impl_get_resource_assignments(resource_id)

@mcp.tool()
def analyze_resource_utilization() -> list[dict]:
    """Per-resource utilization: total units, activity count, overallocation flag."""
    return _impl_analyze_resource_utilization()

@mcp.tool()
def check_schedule_quality() -> dict:
    """DCMA-style quality check: missing logic, long durations, unresourced tasks."""
    return _impl_check_schedule_quality()

@mcp.tool()
def get_wbs() -> list[dict]:
    """Work Breakdown Structure: parent-child activity hierarchy."""
    return _impl_get_wbs()

@mcp.tool()
def get_relationships(activity_id: Optional[str] = None) -> list[dict]:
    """Predecessor/successor relations enriched with names. Filter by activity_id."""
    return _impl_get_relationships(activity_id)

@mcp.tool()
def get_calendars() -> dict:
    """Calendar definition: days/week, hours/day, duration unit."""
    return _impl_get_calendars()

@mcp.tool()
def get_earned_value() -> dict:
    """EVM metrics: BAC, PV, EV, AC, CV, SV, CPI, SPI, EAC."""
    return _impl_get_earned_value()

@mcp.tool()
def get_activity_detail(activity_id: str) -> dict:
    """Full detail for one activity: all fields + predecessors + successors + assignments."""
    return _impl_get_activity_detail(activity_id)

_sse_starlette  = mcp.sse_app()
_http_starlette = mcp.streamable_http_app()

# Извлекаем StreamableHTTPASGIApp, он требует lifespan через session_manager.run()
_http_asgi = _http_starlette.routes[0].app
_session_manager = _http_asgi.session_manager

@contextlib.asynccontextmanager
async def _lifespan(app: Starlette) -> AsyncIterator[None]:
    """ Запускает session_manager для streamable-HTTP транспорта """
    async with _session_manager.run():
        yield

# Объединяем маршруты обоих транспортов в одно приложение
app = Starlette(
    lifespan=_lifespan,
    routes=[
        # SSE транспорт: GET /sse + POST /messages
        *_sse_starlette.routes,
        # Streamable HTTP транспорт: POST /mcp
        *_http_starlette.routes],
    middleware=[
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["*"],
            allow_headers=["*"],
            allow_credentials=True)])

if __name__ == "__main__":
    import uvicorn
    print("P6Matrix MCP Server - port 3201")
    print("  SSE:             http://localhost:3201/sse")
    print("  Streamable HTTP: http://localhost:3201/mcp")
    uvicorn.run(app, host="0.0.0.0", port=3201)
