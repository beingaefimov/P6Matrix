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
import contextlib, pathlib, re, math
from collections import defaultdict, deque
from typing import Any, AsyncIterator, Optional, Literal
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Route, Mount

LANGUAGE = "ru"  # Set to "ru" for Russian or "en" for English

def _t(ru: str, en: str) -> str:
    """Return translated string based on LANGUAGE setting (для динамического контента)"""
    return ru if LANGUAGE == "ru" else en

SHARED_PXP = pathlib.Path(__file__).parent / "shared.pxp"

def _load_pxp() -> str:
    if not SHARED_PXP.exists():
        raise FileNotFoundError(
            _t("shared.pxp not found. Use the Share button in P6Matrix UI first.",
               "shared.pxp not found. Use the Share button in P6Matrix UI first."))
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
            'es_date': g(1), 'ef_date': g(2), 'ls_date': g(3), 'lf_date': g(4),
            'tf': flt(5), 'ff': flt(6), 'on_critical': g(7) == '1',
            'pct_complete': flt(8), 'actual_start': g(9), 'actual_finish': g(10),
            'status': g(11, 'not_started')}
    return results

def _load_with_results() -> tuple[dict[str, Any], dict[str, dict]]:
    text = _load_pxp()
    data = _parse_pxp(text)
    sched = _parse_schedule_results(text)
    return data, sched

# Auth stub (Keycloak)
# from python_keycloak import KeycloakOpenID
# from mcp.server.auth.provider import TokenVerifier
# KC = KeycloakOpenID(server_url="https://keycloak.example.com/",
#                     realm_name="p6matrix", client_id="mcp-server",
#                     client_secret_key="SECRET")
# class KeycloakVerifier(TokenVerifier):
#     async def verify_token(self, token: str) -> dict:
#         info = KC.introspect(token)
#         if not info.get("active"): raise ValueError("Token inactive")
#         return {"sub": info["sub"], "username": info.get("preferred_username", "")}
# mcp = FastMCP(..., token_verifier=KeycloakVerifier())
# или...
# @app.middleware("http")
# async def auth_middleware(request: Request, call_next):
#     auth = request.headers.get("Authorization", "")
#     if not auth.startswith("Bearer "):
#         return JSONResponse({"error": "Unauthorized"}, status_code=401)
#     try:
#         token_info = KC.introspect(auth[7:])
#         if not token_info.get("active"):
#             return JSONResponse({"error": "Token inactive"}, status_code=401)
#     except Exception as e:
#         return JSONResponse({"error": str(e)}, status_code=401)
#     return await call_next(request)

def _get_status(a: dict, sched: dict) -> str:
    sr = sched.get(a["id"])
    if sr and sr.get("status"): return sr["status"]
    if a["actual_finish"] or a["pct_complete"] >= 100: return "completed"
    if a["actual_start"]: return "in_progress"
    return "not_started"

def _build_graph(data: dict) -> tuple[dict, dict, dict, dict]:
    """ Строит граф зависимостей для аналитики """
    acts = {a["id"]: a for a in data["activities"]}
    succs: dict[str, list[tuple[str, float]]] = {aid: [] for aid in acts}
    preds: dict[str, list[tuple[str, float]]] = {aid: [] for aid in acts}
    for r in data["relations"]:
        if r["pred"] in acts and r["succ"] in acts:
            succs[r["pred"]].append((r["succ"], r["lag"]))
            preds[r["succ"]].append((r["pred"], r["lag"]))
    return acts, succs, preds, {a["id"]: a["duration"] for a in data["activities"]}

def _compute_float_distribution(acts: list[dict], sched: dict) -> dict[str, float]:
    """ Вычисляет процентили total_float для анализа «почти критических» работ """
    floats = sorted([sched.get(a["id"], {}).get("tf", 0.0) or 0.0 for a in acts])
    if not floats: return {"p10": 0, "p50": 0, "p90": 0}
    def pctile(p: float) -> float:
        k = (len(floats) - 1) * p / 100
        f = math.floor(k); c = math.ceil(k)
        return floats[f] if f == c else floats[f] + (k - f) * (floats[c] - floats[f])
    return {"p10": round(pctile(10), 2), "p50": round(pctile(50), 2), "p90": round(pctile(90), 2)}

def _get_wbs_level(aid: str, acts: dict, max_level: int = 5) -> int:
    """ Определяет уровень WBS для работы (1 = верхний уровень) """
    level = 1
    current = acts.get(aid, {})
    while current.get("parent_id") and level < max_level:
        level += 1
        current = acts.get(current["parent_id"], {})
    return level

def _impl_raw_get_schedule_summary() -> dict:
    data, sched = _load_with_results()
    acts = data["activities"]
    total = len(acts)
    completed   = sum(1 for a in acts if _get_status(a, sched) == "completed")
    in_progress = sum(1 for a in acts if _get_status(a, sched) == "in_progress")
    tip_msg = _t(
        "Для больших графиков (>1000 работ) используйте analytics.schedule_health_dashboard",
        "For large schedules (>1000 activities) use analytics.schedule_health_dashboard")
    return {
        "project_id": data["meta"].get("project_id", ""),
        "project_name": data["meta"].get("project_name", ""),
        "start_date": data["meta"].get("start_date", ""),
        "data_date": data["meta"].get("data_date", ""),
        "must_finish": data["meta"].get("must_finish", ""),
        "total_activities": total,
        "milestones": sum(1 for a in acts if a["act_type"] == "milestone" or a["duration"] == 0),
        "completed": completed, "in_progress": in_progress,
        "not_started": max(0, total - completed - in_progress),
        "total_relations": len(data["relations"]),
        "total_resources": len(data["resources"]),
        "total_assignments": len(data["assignments"]),
        "has_schedule_results": bool(sched),
        "_tip": tip_msg}

def _impl_raw_get_project_activities(
    status: Optional[str], task_type: Optional[str],
    name_contains: Optional[str], limit: int,
    aggregate_by: Optional[Literal["wbs_level", "status", "act_type"]] = None,
    return_only_anomalies: bool = False) -> dict:
    """ Возвращает либо список работ, либо агрегированные метрики """
    data, sched = _load_with_results()
    
    # Фильтрация
    def _matches(a: dict) -> bool:
        if status and _get_status(a, sched) != status: return False
        if task_type and a["act_type"] != task_type: return False
        if name_contains and name_contains.lower() not in (a["name"] or "").lower(): return False
        return True
    
    filtered = [a for a in data["activities"] if _matches(a)]
    
    # Агрегация если запрошена
    if aggregate_by:
        groups: dict[str, dict] = {}
        for a in filtered:
            if aggregate_by == "wbs_level":
                key = f"level_{_get_wbs_level(a['id'], {x['id']: x for x in data['activities']})}"
            elif aggregate_by == "status":
                key = _get_status(a, sched)
            elif aggregate_by == "act_type":
                key = a["act_type"]
            else:
                key = "other"
            if key not in groups:
                groups[key] = {"count": 0, "total_duration": 0, "avg_pct": 0, "critical_count": 0}
            g = groups[key]
            g["count"] += 1
            g["total_duration"] += a["duration"]
            g["avg_pct"] = (g["avg_pct"] * (g["count"]-1) + (sched.get(a["id"], {}).get("pct_complete") or a["pct_complete"])) / g["count"]
            if sched.get(a["id"], {}).get("on_critical"): g["critical_count"] += 1
        return {"aggregated_by": aggregate_by, "groups": groups, "total_filtered": len(filtered)}
    
    # Аномалии если запрошено
    if return_only_anomalies:
        anomalies = []
        for a in filtered:
            sr = sched.get(a["id"], {})
            is_anomaly = (
                (sr.get("tf") is not None and sr["tf"] < 0) or  # отрицательный резерв
                (a["duration"] > 44 and a["act_type"] != "milestone") or  # очень длинная работа
                (sr.get("on_critical") and (sched.get(a["id"], {}).get("pct_complete") or 0) < 50)  # критическая и мало сделана
            )
            if is_anomaly:
                anomalies.append({
                    "id": a["id"], "name": a["name"], "duration": a["duration"],
                    "status": _get_status(a, sched), "pct_complete": sr.get("pct_complete", a["pct_complete"]),
                    "total_float": sr.get("tf"), "on_critical": sr.get("on_critical"),
                    "anomaly_reasons": [
                        "negative_float" if sr.get("tf") is not None and sr["tf"] < 0 else None,
                        "long_duration" if a["duration"] > 44 and a["act_type"] != "milestone" else None,
                        "critical_low_progress" if sr.get("on_critical") and (sr.get("pct_complete") or 0) < 50 else None
                    ]
                })
        return {"anomalies": anomalies[:limit], "total_anomalies": len(anomalies)}
    
    # Обычный список с защитой от больших объёмов
    if len(filtered) > limit:
        warning_msg = _t(
            f"Найдено {len(filtered)} работ. Показываем первые {limit}. Для анализа используйте: агрегацию (параметр aggregate_by) или analytics.risk_hotspots для выявления проблемных зон.",
            f"Found {len(filtered)} activities. Showing first {limit}. For analysis use: aggregation (aggregate_by parameter) or analytics.risk_hotspots to identify problem areas.")
        return {
            "warning": warning_msg,
            "total_matched": len(filtered), "returned": limit,
            "activities": [
                {
                    "id": a["id"], "name": a["name"], "duration": a["duration"],
                    "act_type": a["act_type"], "status": _get_status(a, sched),
                    "pct_complete": sched.get(a["id"], {}).get("pct_complete", a["pct_complete"]),
                    "es_date": sched.get(a["id"], {}).get("es_date"),
                    "ef_date": sched.get(a["id"], {}).get("ef_date"),
                    "total_float": sched.get(a["id"], {}).get("tf"),
                    "on_critical": sched.get(a["id"], {}).get("on_critical")
                } for a in filtered[:limit]]}
    
    return {"activities": [
        {
            "id": a["id"], "name": a["name"], "duration": a["duration"],
            "act_type": a["act_type"], "status": _get_status(a, sched),
            "pct_complete": sched.get(a["id"], {}).get("pct_complete", a["pct_complete"]),
            "es_date": sched.get(a["id"], {}).get("es_date"),
            "ef_date": sched.get(a["id"], {}).get("ef_date"),
            "ls_date": sched.get(a["id"], {}).get("ls_date"),
            "lf_date": sched.get(a["id"], {}).get("lf_date"),
            "total_float": sched.get(a["id"], {}).get("tf"),
            "free_float": sched.get(a["id"], {}).get("ff"),
            "on_critical": sched.get(a["id"], {}).get("on_critical"),
            "actual_start": sched.get(a["id"], {}).get("actual_start") or a["actual_start"],
            "actual_finish": sched.get(a["id"], {}).get("actual_finish") or a["actual_finish"]
        } for a in filtered]}

def _impl_raw_get_critical_path() -> dict:
    data, sched = _load_with_results()
    acts = data["activities"]
    if not acts:
        tip_msg = _t(
            "Используйте analytics.critical_path_analytics для статистики по КП",
            "Use analytics.critical_path_analytics for critical path statistics")
        return {"activities": [], "total": 0, "_tip": tip_msg}
    # Если есть рассчитанные данные - используем их
    if sched:
        cp_acts = [a for a in acts if sched.get(a["id"], {}).get("on_critical")]
        tip_msg = _t(
            "Для статистики по КП (длина, бутылочные горлышки) используйте analytics.critical_path_analytics",
            "For CP statistics (length, bottlenecks) use analytics.critical_path_analytics")
        return {
            "activities": [{
                "id": a["id"], "name": a["name"], "duration": a["duration"],
                "es_date": sched[a["id"]]["es_date"], "ef_date": sched[a["id"]]["ef_date"],
                "total_float": sched[a["id"]]["tf"],
                "pct_complete": sched[a["id"]].get("pct_complete", a["pct_complete"]),
                "status": sched[a["id"]].get("status", _get_status(a, sched))
            } for a in sorted(cp_acts, key=lambda x: sched.get(x["id"], {}).get("es_date") or "")],
            "total": len(cp_acts),
            "_tip": tip_msg}
    # Fallback CPM (для файлов без @SCHEDULE_RESULTS)
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
        tip_msg = _t(
            "Обнаружен цикл в зависимостях. Возвращён упрощённый расчёт по constraint_es.",
            "Cycle detected in dependencies. Returned simplified calculation based on constraint_es."
        )
        return {"activities": result, "total": len(result), "_tip": tip_msg}
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
    tip_msg = _t(
        "Для статистики по КП используйте analytics.critical_path_analytics",
        "For CP statistics use analytics.critical_path_analytics")
    return {"activities": result, "total": len(result), "_tip": tip_msg}

def _impl_raw_get_resources() -> list[dict]:
    return _parse_pxp(_load_pxp())["resources"]

def _impl_raw_get_resource_assignments(resource_id: Optional[str]) -> list[dict]:
    data = _parse_pxp(_load_pxp())
    act_map = {a["id"]: a["name"] for a in data["activities"]}
    res_map = {r["id"]: r["name"] for r in data["resources"]}
    return [
        {"activity_id": a["activity_id"], "activity_name": act_map.get(a["activity_id"], ""),
         "resource_id": a["resource_id"], "resource_name": res_map.get(a["resource_id"], ""),
         "units": a["units"]}
        for a in data["assignments"]
        if not resource_id or a["resource_id"] == resource_id]

def _impl_raw_analyze_resource_utilization() -> dict:
    data = _parse_pxp(_load_pxp())
    res_map = {r["id"]: r for r in data["resources"]}
    util = {
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
    overloads = [u for u in util.values() if u["overallocated"]]
    tip_msg = _t(
        "Для агрегации по командам/периодам используйте analytics.resource_aggregate_utilization",
        "For aggregation by teams/periods use analytics.resource_aggregate_utilization")
    return {
        "resources": sorted(util.values(), key=lambda x: -x["total_assigned_units"]),
        "overallocated_count": len(overloads),
        "_tip": tip_msg}

def _impl_raw_check_schedule_quality() -> dict:
    data, sched = _load_with_results()
    acts = [{**a, **{k: v for k, v in sched.get(a["id"], {}).items()
                     if k in ("pct_complete","actual_start","actual_finish","status")}}
            for a in data["activities"]]
    rels, asgns = data["relations"], data["assignments"]
    has_pred = {r["succ"] for r in rels}; has_succ = {r["pred"] for r in rels}; has_res = {a["activity_id"] for a in asgns}
    non_mile = [a for a in acts if a["act_type"] != "milestone"]
    total = len(acts); score = 100; issues = []
    def _chk(lst: list, label: str, weight: int = 5):
        nonlocal score
        pct = len(lst) / total * 100 if total else 0
        if pct > 0:
            score -= min(weight, int(pct))
            issues.append({"check": label, "count": len(lst), "pct": round(pct, 1), "sample_ids": lst[:10]})
    _chk([a["id"] for a in non_mile if a["id"] not in has_pred], "missing_predecessors", 10)
    _chk([a["id"] for a in non_mile if a["id"] not in has_succ], "missing_successors", 10)
    _chk([a["id"] for a in non_mile if a["duration"] > 44], "long_durations_gt_44d", 5)
    _chk([a["id"] for a in non_mile if a["id"] not in has_res], "unresourced_tasks", 5)
    _chk([a["id"] for a in non_mile if a["duration"] == 0], "zero_duration_non_milestone", 5)
    _chk([a["id"] for a in acts if a["actual_finish"] and a["pct_complete"] < 100], "actual_finish_but_pct_lt_100", 3)
    all_checks = ["missing_predecessors","missing_successors","long_durations_gt_44d","unresourced_tasks","zero_duration_non_milestone","actual_finish_but_pct_lt_100"]
    tip_msg = _t(
        "Для приоритизации исправлений используйте analytics.risk_hotspots",
        "To prioritize fixes use analytics.risk_hotspots")
    return {
        "overall_score": max(0, score), "total_activities": total,
        "issues": issues, "passed": [c for c in all_checks if not any(i["check"] == c for i in issues)],
        "_tip": tip_msg}

def _impl_raw_get_wbs() -> list[dict]:
    return [{"id": a["id"], "name": a["name"], "parent_id": a["parent_id"],
             "act_type": a["act_type"], "duration": a["duration"]}
            for a in _parse_pxp(_load_pxp())["activities"]]

def _impl_raw_get_relationships(activity_id: Optional[str]) -> dict:
    data = _parse_pxp(_load_pxp())
    act_map = {a["id"]: a["name"] for a in data["activities"]}
    rels = [
        {"pred": r["pred"], "pred_name": act_map.get(r["pred"], ""),
         "succ": r["succ"], "succ_name": act_map.get(r["succ"], ""),
         "type": r["type"], "lag": r["lag"]}
        for r in data["relations"]
        if not activity_id or r["pred"] == activity_id or r["succ"] == activity_id]
    if len(rels) > 500:
        warning_msg = _t(
            f"Найдено {len(rels)} связей. Показываем первые 500. Для анализа плотности используйте analytics.dependency_complexity_map",
            f"Found {len(rels)} relationships. Showing first 500. For density analysis use analytics.dependency_complexity_map"
        )
        return {"warning": warning_msg,
                "total": len(rels), "returned": 500, "relationships": rels[:500]}
    return {"relationships": rels, "total": len(rels)}

def _impl_raw_get_calendars() -> dict:
    meta = _parse_pxp(_load_pxp())["meta"]
    cal = meta.get("calendar", "5d8h")
    dm = re.search(r"(\d+)d", cal); hm = re.search(r"(\d+)h", cal)
    dpw = int(dm.group(1)) if dm else 5; hpd = int(hm.group(1)) if hm else 8
    return {"calendar_code": cal, "days_per_week": dpw, "hours_per_day": hpd,
            "hours_per_week": dpw * hpd, "duration_unit": meta.get("duration_unit", "days")}

def _impl_raw_get_earned_value() -> dict:
    data = _parse_pxp(_load_pxp())
    acts = {a["id"]: a for a in data["activities"]}
    BAC = PV = EV = AC = 0.0
    for asgn in data["assignments"]:
        act = acts.get(asgn["activity_id"])
        if not act: continue
        bac_a = act["duration"] * asgn["units"]
        BAC += bac_a; PV += bac_a
        EV += (act["pct_complete"] / 100.0) * bac_a
        AC += (act["actual_duration"] or 0.0) * asgn["units"]
    CV, SV = EV - AC, EV - PV
    CPI = round(EV / AC, 3) if AC > 0 else None
    SPI = round(EV / PV, 3) if PV > 0 else None
    EAC = round(AC + (BAC - EV) / CPI, 2) if CPI and CPI > 0 else None
    tip_msg = _t(
        "Для трендов и прогнозов используйте analytics.evm_trend_analysis",
        "For trends and forecasts use analytics.evm_trend_analysis"
    )
    return {"BAC": round(BAC, 2), "PV": round(PV, 2), "EV": round(EV, 2), "AC": round(AC, 2),
            "CV": round(CV, 2), "SV": round(SV, 2), "CPI": CPI, "SPI": SPI, "EAC": EAC,
            "pct_complete_overall": round(EV / BAC * 100, 1) if BAC > 0 else 0.0,
            "_tip": tip_msg}

def _impl_raw_get_activity_detail(activity_id: str) -> dict:
    data, sched = _load_with_results()
    act_map = {a["id"]: a for a in data["activities"]}
    res_map = {r["id"]: r["name"] for r in data["resources"]}
    act = act_map.get(activity_id)
    if not act: raise ValueError(f"Activity '{activity_id}' not found in shared.pxp")
    sr = sched.get(activity_id, {})
    return {
        **act,
        "es_date": sr.get("es_date"), "ef_date": sr.get("ef_date"),
        "ls_date": sr.get("ls_date"), "lf_date": sr.get("lf_date"),
        "total_float": sr.get("tf"), "free_float": sr.get("ff"),
        "on_critical": sr.get("on_critical"),
        "pct_complete": sr.get("pct_complete", act["pct_complete"]),
        "actual_start": sr.get("actual_start") or act["actual_start"],
        "actual_finish": sr.get("actual_finish") or act["actual_finish"],
        "status": sr.get("status") or _get_status(act, sched),
        "schedule_results_available": bool(sr),
        "predecessors": [
            {"pred": r["pred"], "pred_name": act_map.get(r["pred"], {}).get("name", ""),
             "type": r["type"], "lag": r["lag"]}
            for r in data["relations"] if r["succ"] == activity_id],
        "successors": [
            {"succ": r["succ"], "succ_name": act_map.get(r["succ"], {}).get("name", ""),
             "type": r["type"], "lag": r["lag"]}
            for r in data["relations"] if r["pred"] == activity_id],
        "assignments": [
            {"resource_id": a["resource_id"],
             "resource_name": res_map.get(a["resource_id"], a["resource_id"]),
             "units": a["units"]}
            for a in data["assignments"] if a["activity_id"] == activity_id]}

def _impl_analytics_schedule_health_dashboard() -> dict:
    """ Композитная оценка здоровья расписания """
    data, sched = _load_with_results()
    acts = data["activities"]
    total = len(acts)
    
    # DCMA-style compliance
    quality = _impl_raw_check_schedule_quality()
    dcma_rate = quality["overall_score"]
    
    # Критический путь
    cp_data = _impl_raw_get_critical_path()
    cp_count = cp_data.get("total", 0)
    cp_density = round(cp_count / total * 100, 1) if total else 0
    
    # Ресурсы
    util = _impl_raw_analyze_resource_utilization()
    overload_ratio = round(util["overallocated_count"] / len(util["resources"]) * 100, 1) if util["resources"] else 0
    
    # Прогресс и риски
    completed = sum(1 for a in acts if _get_status(a, sched) == "completed")
    critical_low_progress = sum(1 for a in acts 
                               if sched.get(a["id"], {}).get("on_critical") 
                               and (sched.get(a["id"], {}).get("pct_complete") or 0) < 50)
    
    # Топ-3 риска (упрощённо)
    risks = []
    if LANGUAGE == "ru":
        if cp_density > 30: risks.append(f"Высокая плотность КП ({cp_density}%): малый резерв для манёвра")
        if overload_ratio > 20: risks.append(f"Перегрузка ресурсов ({overload_ratio}%): риск задержек")
        if critical_low_progress > 0: risks.append(f"{critical_low_progress} критических работ с прогрессом <50%")
        if dcma_rate < 80: risks.append(f"Низкое качество расписания (DCMA: {dcma_rate}/100)")
        if not risks: risks.append("Критических рисков не выявлено")
    else:
        if cp_density > 30: risks.append(f"High CP density ({cp_density}%): little room for maneuver")
        if overload_ratio > 20: risks.append(f"Resource overload ({overload_ratio}%): delay risk")
        if critical_low_progress > 0: risks.append(f"{critical_low_progress} critical activities with progress <50%")
        if dcma_rate < 80: risks.append(f"Low schedule quality (DCMA: {dcma_rate}/100)")
        if not risks: risks.append("No critical risks identified")
    
    # Композитный скор (0-100)
    score = int(dcma_rate * 0.4 + (100 - min(cp_density, 50)) * 0.3 + (100 - overload_ratio) * 0.3)
    
    next_steps = _t(
        [
            "analytics.risk_hotspots - для детализации рисков",
            "analytics.wbs_rollup_metrics - для анализа по уровням иерархии",
            "raw.get_activity_detail - для точечной проверки конкретных работ"],
        [
            "analytics.risk_hotspots - for risk details",
            "analytics.wbs_rollup_metrics - for hierarchy level analysis",
            "raw.get_activity_detail - for detailed check of specific activities"])
    
    return {
        "overall_health_score": score,
        "dcma_compliance_rate": dcma_rate,
        "critical_path_density_pct": cp_density,
        "resource_overload_ratio_pct": overload_ratio,
        "progress": {"completed_pct": round(completed/total*100,1) if total else 0},
        "top_3_risks": risks[:3],
        "recommendation": "focus_on_risk_hotspots" if score < 70 else "monitor_critical_path" if score < 85 else "on_track",
        "data_timestamp": data["meta"].get("data_date", ""),
        "_next_steps": next_steps}

def _impl_analytics_risk_hotspots(top_n: int = 5) -> dict:
    """ Выявление зон повышенного риска в графике """
    data, sched = _load_with_results()
    acts_map = {a["id"]: a for a in data["activities"]}
    
    hotspots = []
    for a in data["activities"]:
        sr = sched.get(a["id"], {})
        risk_score = 0
        factors = []
        
        # Факторы риска
        if sr.get("tf") is not None and sr["tf"] < 0:
            risk_score += 30; factors.append("negative_total_float")
        elif sr.get("tf") is not None and sr["tf"] < 2:
            risk_score += 15; factors.append("low_total_float")
        
        if a["duration"] > 44 and a["act_type"] != "milestone":
            risk_score += 20; factors.append("long_duration")
        
        if sr.get("on_critical") and (sr.get("pct_complete") or 0) < 50:
            risk_score += 25; factors.append("critical_low_progress")
        
        # Зависимости
        pred_count = sum(1 for r in data["relations"] if r["succ"] == a["id"])
        succ_count = sum(1 for r in data["relations"] if r["pred"] == a["id"])
        if pred_count > 5 or succ_count > 5:
            risk_score += 10; factors.append("high_dependency_complexity")
        
        # Ресурсы
        assignments = [asgn for asgn in data["assignments"] if asgn["activity_id"] == a["id"]]
        if not assignments and a["act_type"] != "milestone":
            risk_score += 15; factors.append("unresourced")
        
        if risk_score > 0:
            hotspots.append({
                "activity_id": a["id"], "activity_name": a["name"],
                "wbs_path": a.get("parent_id", ""),
                "risk_score": min(risk_score, 100),
                "contributing_factors": factors,
                "current_status": sr.get("status", _get_status(a, sched)),
                "pct_complete": sr.get("pct_complete", a["pct_complete"]),
                "total_float": sr.get("tf"),
                "on_critical": sr.get("on_critical")})
    
    hotspots.sort(key=lambda x: -x["risk_score"])
    tip_msg = _t(
        "Используйте raw.get_activity_detail для детального разбора конкретного activity_id",
        "Use raw.get_activity_detail for detailed analysis of a specific activity_id")
    return {
        "hotspots": hotspots[:top_n],
        "total_risky_activities": len(hotspots),
        "scoring_method": "weighted_factors: negative_float(30), critical_low_progress(25), long_duration(20), unresourced(15), low_float(15), high_deps(10)",
        "_tip": tip_msg}

def _impl_analytics_wbs_rollup_metrics(wbs_level: int = 2) -> dict:
    """ Агрегированные метрики по уровням WBS """
    data, sched = _load_with_results()
    acts = {a["id"]: a for a in data["activities"]}
    
    # Группировка по уровням
    groups: dict[str, dict] = {}
    for a in data["activities"]:
        level = _get_wbs_level(a["id"], acts, max_level=5)
        if level != wbs_level: continue
        key = a["parent_id"] or "root"
        if key not in groups:
            groups[key] = {
                "wbs_id": key, "name": acts.get(key, {}).get("name", key) if key != "root" else "Project",
                "level": level, "activities": [], "metrics": {}}
        groups[key]["activities"].append(a["id"])
    
    # Расчёт метрик для каждой группы
    for gid, grp in groups.items():
        ids = grp["activities"]
        grp_metrics = grp["metrics"]
        grp_metrics["activity_count"] = len(ids)
        grp_metrics["total_duration"] = sum(acts[i]["duration"] for i in ids)
        pct_vals = [sched.get(i, {}).get("pct_complete") or acts[i]["pct_complete"] for i in ids]
        grp_metrics["avg_completion_pct"] = round(sum(pct_vals)/len(pct_vals), 1) if pct_vals else 0
        cp_count = sum(1 for i in ids if sched.get(i, {}).get("on_critical"))
        grp_metrics["critical_path_ratio_pct"] = round(cp_count/len(ids)*100, 1) if ids else 0
        float_vals = [sched.get(i, {}).get("tf") for i in ids if sched.get(i, {}).get("tf") is not None]
        grp_metrics["avg_total_float"] = round(sum(float_vals)/len(float_vals), 2) if float_vals else None
    
    tip_msg = _t(
        "Увеличьте wbs_level для более детального разбора, или используйте analytics.risk_hotspots для фокуса на рисках",
        "Increase wbs_level for more detailed breakdown, or use analytics.risk_hotspots to focus on risks")
    return {
        "wbs_level": wbs_level,
        "rollups": sorted(groups.values(), key=lambda x: -x["metrics"]["activity_count"]),
        "_tip": tip_msg}

def _impl_analytics_critical_path_analytics() -> dict:
    """ Статистический анализ критического пути """
    data, sched = _load_with_results()
    cp_data = _impl_raw_get_critical_path()
    cp_acts = cp_data.get("activities", [])
    
    if not cp_acts:
        error_msg = _t(
            "Критический путь не найден или не рассчитан",
            "Critical path not found or not calculated")
        return {"error": "critical_path_empty", "message": error_msg}
    
    # Статистика
    durations = [a["duration"] for a in cp_acts]
    pct_vals = [a.get("pct_complete", 0) for a in cp_acts]
    
    # Бутылочные горлышки
    bottlenecks = []
    for a in cp_acts:
        reasons = []
        if a["duration"] > 30: reasons.append("long_duration")
        if a.get("pct_complete", 0) < 30: reasons.append("low_progress")
        # Проверка на ресурсные конфликты
        assignments = [asgn for asgn in data["assignments"] if asgn["activity_id"] == a["id"]]
        if len(assignments) > 2:
            reasons.append("multi_resource")
        if reasons:
            bottlenecks.append({
                "activity_id": a["id"], "activity_name": a["name"],
                "duration": a["duration"], "pct_complete": a.get("pct_complete", 0),
                "delay_impact_days": a["duration"] * (100 - a.get("pct_complete", 0)) / 100,
                "bottleneck_reasons": reasons})
    bottlenecks.sort(key=lambda x: -x["delay_impact_days"])
    
    tip_msg = _t(
        "Для детализации конкретной работы используйте raw.get_activity_detail(activity_id=...)",
        "For details on a specific activity use raw.get_activity_detail(activity_id=...)")
    return {
        "critical_path_stats": {
            "total_activities": len(cp_acts),
            "total_duration_days": sum(durations),
            "avg_completion_pct": round(sum(pct_vals)/len(pct_vals), 1) if pct_vals else 0,
            "float_distribution": _compute_float_distribution(data["activities"], sched)
        },
        "bottleneck_activities": bottlenecks[:5],
        "_tip": tip_msg}

def _impl_analytics_resource_aggregate_utilization(
    group_by: Literal["resource_type", "team", "all"] = "all",
    time_bucket: Optional[Literal["week", "month"]] = None) -> dict:
    """ Агрегированная загрузка ресурсов по группам/периодам """
    data = _parse_pxp(_load_pxp())
    res_map = {r["id"]: r for r in data["resources"]}
    
    # Простая группировка
    groups: dict[str, dict] = {}
    for asgn in data["assignments"]:
        rid = asgn["resource_id"]
        res = res_map.get(rid)
        if not res: continue
        # Ключ группировки
        if group_by == "resource_type":
            key = res.get("name", "").split()[0] if res.get("name") else "unknown"
        elif group_by == "team":
            key = "team_default"  # заглушка: добавьте логику маппинга ресурсов в команды
        else:
            key = "all_resources"
        
        if key not in groups:
            groups[key] = {"group_name": key, "resource_count": 0, "total_units": 0, "max_capacity": 0}
        g = groups[key]
        g["resource_count"] += 1
        g["total_units"] += asgn["units"]
        g["max_capacity"] += res["max_units"]
    
    result = []
    for g in groups.values():
        util_pct = round(g["total_units"] / g["max_capacity"] * 100, 1) if g["max_capacity"] else 0
        result.append({
            "group": g["group_name"], "resource_count": g["resource_count"],
            "total_assigned_units": round(g["total_units"], 2),
            "total_capacity": round(g["max_capacity"], 2),
            "utilization_pct": util_pct,
            "status": "overloaded" if util_pct > 100 else "high" if util_pct > 80 else "normal"})
    
    tip_msg = _t(
        "Для детальных назначений используйте raw.get_resource_assignments(resource_id=...)",
        "For detailed assignments use raw.get_resource_assignments(resource_id=...)")
    return {
        "grouped_by": group_by, "time_bucket": time_bucket,
        "aggregates": sorted(result, key=lambda x: -x["utilization_pct"]),
        "_tip": tip_msg}

def _impl_analytics_evm_trend_analysis() -> dict:
    """ Тренды освоенного объёма с прогнозом """
    ev = _impl_raw_get_earned_value()
    # Упрощённый тренд: линейная экстраполяция (расширяйте под исторические данные)
    spi = ev["SPI"] or 1.0
    cpi = ev["CPI"] or 1.0
    forecast_narrative = []
    if LANGUAGE == "ru":
        if spi < 0.9: forecast_narrative.append("Отставание по графику: при текущих темпах финиш сдвинется")
        elif spi > 1.1: forecast_narrative.append("Опережение графика: есть резерв для оптимизации")
        else: forecast_narrative.append("График в пределах плана")
        if cpi < 0.9: forecast_narrative.append("Перерасход бюджета: требуется контроль затрат")
        elif cpi > 1.1: forecast_narrative.append("Экономия бюджета: можно перераспределить ресурсы")
        else: forecast_narrative.append("Бюджет в пределах плана")
    else:
        if spi < 0.9: forecast_narrative.append("Behind schedule: at current pace, finish will be delayed")
        elif spi > 1.1: forecast_narrative.append("Ahead of schedule: room for optimization")
        else: forecast_narrative.append("Schedule within plan")
        if cpi < 0.9: forecast_narrative.append("Budget overrun: cost control required")
        elif cpi > 1.1: forecast_narrative.append("Budget savings: resources can be reallocated")
        else: forecast_narrative.append("Budget within plan")
    
    # Прогноз EAC с доверительным интервалом (упрощённо)
    eac_base = ev["EAC"] or ev["BAC"]
    tip_msg = _t(
        "Для детального расчёта по периодам добавьте исторические срезы в shared.pxp",
        "For detailed period-based calculation add historical snapshots to shared.pxp")
    return {
        "current_metrics": {"SPI": ev["SPI"], "CPI": ev["CPI"], "EAC": ev["EAC"], "BAC": ev["BAC"]},
        "trend_4w_estimate": {"spi_direction": "stable" if 0.95 <= (spi or 1) <= 1.05 else ("improving" if (spi or 1) > 1 else "declining")},
        "eac_confidence_interval": {
            "p10": round(eac_base * 0.9, 2) if eac_base else None,
            "p50": eac_base,
            "p90": round(eac_base * 1.15, 2) if eac_base else None
        },
        "forecast_narrative": "; ".join(forecast_narrative),
        "_tip": tip_msg}

def _impl_reports_executive_brief(
    audience: Literal["executive", "project_manager", "team_lead"] = "executive",
    focus_areas: Optional[list[Literal["schedule", "resources", "risks", "cost"]]] = None) -> dict:
    """ Предсгенерированный текстовый отчёт на естественном языке """
    # Нормализация: если None → дефолтное значение
    if focus_areas is None:
        focus_areas = ["schedule", "risks"]
    
    health = _impl_analytics_schedule_health_dashboard()
    risks = _impl_analytics_risk_hotspots(top_n=3)
    ev = _impl_raw_get_earned_value()
    
    # Формирование текста под аудиторию
    if audience == "executive":
        project_name = _impl_raw_get_schedule_summary()['project_name']
        if LANGUAGE == "ru":
            summary_parts = [f"Проект '{project_name}'"]
            if health["overall_health_score"] >= 85:
                summary_parts.append("выполняется в соответствии с планом.")
            elif health["overall_health_score"] >= 70:
                summary_parts.append("имеет умеренные риски, требующие внимания.")
            else:
                summary_parts.append("требует немедленного вмешательства из-за критических рисков.")
            if "risks" in focus_areas and risks["hotspots"]:
                summary_parts.append(f"Топ-риск: {risks['hotspots'][0]['contributing_factors'][0]} в работе '{risks['hotspots'][0]['activity_name']}'.")
            summary = " ".join(summary_parts)
            decisions = ["Утвердить план смягчения рисков" if health["overall_health_score"] < 80 else "Продолжить мониторинг"]
        else:
            summary_parts = [f"Project '{project_name}'"]
            if health["overall_health_score"] >= 85:
                summary_parts.append("is on track.")
            elif health["overall_health_score"] >= 70:
                summary_parts.append("has moderate risks requiring attention.")
            else:
                summary_parts.append("requires immediate intervention due to critical risks.")
            if "risks" in focus_areas and risks["hotspots"]:
                summary_parts.append(f"Top risk: {risks['hotspots'][0]['contributing_factors'][0]} in activity '{risks['hotspots'][0]['activity_name']}'.")
            summary = " ".join(summary_parts)
            decisions = ["Approve risk mitigation plan" if health["overall_health_score"] < 80 else "Continue monitoring"]
    else:  # project_manager / team_lead
        if LANGUAGE == "ru":
            summary = f"Здоровье графика: {health['overall_health_score']}/100. "
            summary += f"КП: {health['critical_path_density_pct']}%, Ресурсы: {health['resource_overload_ratio_pct']}% перегружены. "
            summary += "; ".join(health["top_3_risks"][:2])
            decisions = [f"Проверить работу {r['activity_id']}" for r in risks["hotspots"][:3]]
        else:
            summary = f"Schedule health: {health['overall_health_score']}/100. "
            summary += f"CP: {health['critical_path_density_pct']}%, Resources: {health['resource_overload_ratio_pct']}% overloaded. "
            summary += "; ".join(health["top_3_risks"][:2])
            decisions = [f"Check activity {r['activity_id']}" for r in risks["hotspots"][:3]]
    
    return {
        "audience": audience,
        "focus_areas": focus_areas,
        "summary": summary,
        "key_decisions_needed": decisions,
        "supporting_metrics": {
            "health_score": health["overall_health_score"],
            "dcma_rate": health["dcma_compliance_rate"],
            "spi": ev["SPI"], "cpi": ev["CPI"]
        },
        "data_sources": ["analytics.schedule_health_dashboard", "analytics.risk_hotspots", "raw.get_earned_value"],
        "generated_at": _impl_raw_get_schedule_summary().get("data_date")}

def _impl_reports_anomaly_alerts() -> dict:
    """ Только отклонения от ожидаемых паттернов """
    data, sched = _load_with_results()
    alerts = []
    
    for a in data["activities"]:
        sr = sched.get(a["id"], {})
        # Паттерн: отрицательный резерв
        if sr.get("tf") is not None and sr["tf"] < 0:
            suggested_action = _t("Проверить зависимости и длительность, рассмотреть ускорение", "Check dependencies and duration, consider acceleration")
            alerts.append({
                "type": "schedule_slip", "severity": "high",
                "location": {"activity_id": a["id"], "activity_name": a["name"], "wbs_path": a.get("parent_id", "")},
                "evidence": {"metric": "total_float", "expected": ">=0", "actual": sr["tf"]},
                "suggested_action": suggested_action})
        # Паттерн: критическая работа с низким прогрессом
        if sr.get("on_critical") and (sr.get("pct_complete") or 0) < 30 and a["duration"] > 10:
            suggested_action = _t("Усилить контроль, проверить доступность ресурсов", "Increase oversight, check resource availability")
            alerts.append({
                "type": "critical_progress_risk", "severity": "medium",
                "location": {"activity_id": a["id"], "activity_name": a["name"]},
                "evidence": {"metric": "pct_complete", "expected": ">50 for critical", "actual": sr.get("pct_complete", 0)},
                "suggested_action": suggested_action})
        # Паттерн: работа без ресурсов (не веха)
        if a["act_type"] != "milestone" and not any(asgn["activity_id"] == a["id"] for asgn in data["assignments"]):
            suggested_action = _t("Назначить ответственный ресурс", "Assign responsible resource")
            alerts.append({
                "type": "quality_issue", "severity": "low",
                "location": {"activity_id": a["id"], "activity_name": a["name"]},
                "evidence": {"metric": "resource_assignment", "expected": ">=1", "actual": 0},
                "suggested_action": suggested_action})
    
    # Группировка по типу и серьёзности
    alerts.sort(key=lambda x: {"high": 0, "medium": 1, "low": 2}.get(x["severity"], 3))
    tip_msg = _t(
        "Используйте raw.get_activity_detail для разбора конкретного alert",
        "Use raw.get_activity_detail to analyze a specific alert")
    return {
        "total_alerts": len(alerts),
        "by_severity": {
            "high": sum(1 for a in alerts if a["severity"] == "high"),
            "medium": sum(1 for a in alerts if a["severity"] == "medium"),
            "low": sum(1 for a in alerts if a["severity"] == "low")
        },
        "alerts": alerts[:20],  # лимит на вывод
        "_tip": tip_msg}

def _impl_guide_select_analysis_approach(
    task: str, graph_size: Literal["small", "medium", "large"] = "medium") -> dict:
    """ Помощник для выбора правильного инструмента под задачу """
    recommendations = []
    
    if "здоров" in task.lower() or "оцен" in task.lower() or "overview" in task.lower() or "health" in task.lower():
        recommendations.append("analytics.schedule_health_dashboard")
        if graph_size != "small": recommendations.append("analytics.risk_hotspots")
    elif "риск" in task.lower() or "проблем" in task.lower() or "delay" in task.lower() or "risk" in task.lower():
        recommendations.append("analytics.risk_hotspots")
        recommendations.append("analytics.critical_path_analytics")
    elif "ресурс" in task.lower() or "загрузк" in task.lower() or "resource" in task.lower() or "utilization" in task.lower():
        recommendations.append("analytics.resource_aggregate_utilization")
        if graph_size == "small": recommendations.append("raw.analyze_resource_utilization")
    elif "детал" in task.lower() or "конкретн" in task.lower() or "detail" in task.lower():
        recommendations.append("raw.get_activity_detail")
    elif "отчёт" in task.lower() or "summary" in task.lower() or "brief" in task.lower() or "report" in task.lower():
        recommendations.append("reports.executive_brief")
    elif "аномал" in task.lower() or "alert" in task.lower() or "anomaly" in task.lower():
        recommendations.append("reports.anomaly_alerts")
    else:
        recommendations.append("analytics.schedule_health_dashboard")
        recommendations.append("guide.select_analysis_approach (уточните задачу / clarify your task)")
    
    reasoning = _t(
        f"Для задачи '{task}' и размера графика '{graph_size}' оптимально начать с агрегированных метрик, затем детализировать при необходимости.",
        f"For task '{task}' and graph size '{graph_size}', it's optimal to start with aggregated metrics, then drill down if needed.")
    example_query = _t(
        f"Сначала вызовите {recommendations[0]}, затем при необходимости - raw.get_activity_detail для конкретных activity_id",
        f"First call {recommendations[0]}, then if needed - raw.get_activity_detail for specific activity_id")
    avoid_msg = _t(
        ["raw.get_project_activities без фильтров", "raw.get_relationships без activity_id"],
        ["raw.get_project_activities without filters", "raw.get_relationships without activity_id"])
    
    return {
        "task_interpreted": task,
        "graph_size": graph_size,
        "recommended_tools": recommendations,
        "reasoning": reasoning,
        "example_query": example_query,
        "avoid_for_large_graphs": avoid_msg if graph_size == "large" else []}

mcp = FastMCP(
    name="P6Matrix MCP",
    instructions=(
        "P6Matrix CPM Schedule server. "
        "RU: Используйте analytics.* для анализа больших графиков (>1000 работ), raw.* - для детального разбора. Начинайте с analytics.schedule_health_dashboard или guide.select_analysis_approach. "
        "EN: Use analytics.* for large schedules (>1000 activities), raw.* for detailed analysis. Start with analytics.schedule_health_dashboard or guide.select_analysis_approach."
    ),
    host="0.0.0.0",
    port=3201)

@mcp.tool(name="raw.get_schedule_summary")
def get_schedule_summary() -> dict:
    """[RAW] RU: Общие данные проекта, даты, счётчики статусов. Для графиков >1000 работ используйте analytics.schedule_health_dashboard вместо ручного подсчёта. | EN: General project data, dates, status counters. For schedules >1000 activities use analytics.schedule_health_dashboard instead of manual counting."""
    return _impl_raw_get_schedule_summary()

@mcp.tool(name="raw.get_project_activities")
def get_project_activities(
    status: Optional[str] = None,
    task_type: Optional[str] = None,
    name_contains: Optional[str] = None,
    limit: int = 1000,
    aggregate_by: Optional[Literal["wbs_level", "status", "act_type"]] = None,
    return_only_anomalies: bool = False) -> dict:
    """[RAW] RU: Список работ. Используйте только с точными фильтрами или для малых графиков (<500 работ). Для больших графиков ставьте aggregate_by="wbs_level" или return_only_anomalies=True, либо переходите на analytics.risk_hotspots. | EN: List of activities. Use only with precise filters or for small schedules (<500). For large: use aggregate_by="wbs_level", return_only_anomalies=True, or analytics.risk_hotspots."""
    return _impl_raw_get_project_activities(status, task_type, name_contains, limit, aggregate_by, return_only_anomalies)

@mcp.tool(name="raw.get_critical_path")
def get_critical_path() -> dict:
    """[RAW] RU: Список всех работ с TF=0. Возвращает много строк на больших графиках. Для оценки длины КП и поиска бутылочных горлышек используйте analytics.critical_path_analytics. | EN: List of all activities with TF=0. Returns many rows on large schedules. For CP length and bottlenecks use analytics.critical_path_analytics."""
    return _impl_raw_get_critical_path()

@mcp.tool(name="raw.get_resources")
def get_resources() -> list[dict]:
    """[RAW] RU: Справочник ресурсов и лимитов. Для анализа перегрузок по командам используйте analytics.resource_aggregate_utilization. | EN: Resource catalog and limits. For team overload analysis use analytics.resource_aggregate_utilization."""
    return _impl_raw_get_resources()

@mcp.tool(name="raw.get_resource_assignments")
def get_resource_assignments(resource_id: Optional[str] = None) -> list[dict]:
    """[RAW] RU: Таблица назначений ресурс→работа. При >1000 записей используйте analytics.resource_aggregate_utilization для сводки. | EN: Assignment table resource→activity. For >1000 records use analytics.resource_aggregate_utilization for summary."""
    return _impl_raw_get_resource_assignments(resource_id)

@mcp.tool(name="raw.analyze_resource_utilization")
def analyze_resource_utilization() -> dict:
    """[RAW] RU: Загрузка каждого ресурса отдельно. Для группировки по типам/командам используйте analytics.resource_aggregate_utilization. | EN: Load of each resource individually. For grouping by types/teams use analytics.resource_aggregate_utilization."""
    return _impl_raw_analyze_resource_utilization()

@mcp.tool(name="raw.check_schedule_quality")
def check_schedule_quality() -> dict:
    """[RAW] RU: DCMA-проверки и общий скор. Для приоритизации конкретных проблемных работ используйте analytics.risk_hotspots. | EN: DCMA checks and overall score. To prioritize specific problematic activities use analytics.risk_hotspots."""
    return _impl_raw_check_schedule_quality()

@mcp.tool(name="raw.get_wbs")
def get_wbs() -> list[dict]:
    """[RAW] RU: Плоский список parent-child связей. Для метрик по уровням иерархии используйте analytics.wbs_rollup_metrics. | EN: Flat list of parent-child links. For hierarchy level metrics use analytics.wbs_rollup_metrics."""
    return _impl_raw_get_wbs()

@mcp.tool(name="raw.get_relationships")
def get_relationships(activity_id: Optional[str] = None) -> dict:
    """[RAW] RU: Связи предшественник/последователь. Всегда указывайте activity_id. Без фильтра возвращает усечённый список. Для оценки плотности графа анализируйте сырые данные вручную или пишите кастомный агрегатор. | EN: Predecessor/successor relationships. Always specify activity_id. Without filter returns truncated list. For graph density analysis parse raw data manually or write custom aggregator."""
    return _impl_raw_get_relationships(activity_id)

@mcp.tool(name="raw.get_calendars")
def get_calendars() -> dict:
    """[RAW] RU: Параметры рабочего календаря. Статичные данные, безопасны для любого размера графика. | EN: Working calendar parameters. Static data, safe for any schedule size."""
    return _impl_raw_get_calendars()

@mcp.tool(name="raw.get_earned_value")
def get_earned_value() -> dict:
    """[RAW] RU: Точка EVM на дату среза. Для трендов и прогноза завершения используйте analytics.evm_trend_analysis. | EN: EVM snapshot as of data date. For trends and completion forecast use analytics.evm_trend_analysis."""
    return _impl_raw_get_earned_value()

@mcp.tool(name="raw.get_activity_detail")
def get_activity_detail(activity_id: str) -> dict:
    """[RAW] RU: Полная карточка одной работы. Используйте ТОЛЬКО после того, как analytics.* вернули конкретные activity_id для детализации. | EN: Full card of a single activity. Use ONLY after analytics.* returned specific activity_id for drill-down."""
    return _impl_raw_get_activity_detail(activity_id)

@mcp.tool(name="analytics.schedule_health_dashboard")
def analytics_schedule_health_dashboard() -> dict:
    """[ANALYTICS] RU: Стартовая точка для любого графика. Возвращает скор здоровья, плотность КП, перегрузку, топ-3 риска. Вызывайте первым при запросах «общий статус», «риски», «проблемы». | EN: Starting point for any schedule. Returns health score, CP density, overload, top-3 risks. Call first for queries like 'overall status', 'risks', 'problems'."""
    return _impl_analytics_schedule_health_dashboard()

@mcp.tool(name="analytics.risk_hotspots")
def analytics_risk_hotspots(top_n: int = 5) -> dict:
    """[ANALYTICS] RU: Топ-N самых проблемных работ. Рассчитывает риск по резерву, прогрессу и длительности. Используйте вместо перебора raw.get_project_activities. | EN: Top-N most problematic activities. Calculates risk by float, progress and duration. Use instead of iterating raw.get_project_activities."""
    return _impl_analytics_risk_hotspots(top_n)

@mcp.tool(name="analytics.wbs_rollup_metrics")
def analytics_wbs_rollup_metrics(wbs_level: int = 2) -> dict:
    """[ANALYTICS] RU: Сводка по пакетам работ: прогресс, доля КП, средний резерв. Используйте для ответа на вопросы «как идут дела по этапу/подсистеме?». | EN: Summary by work packages: progress, CP share, average float. Use to answer questions like 'how is phase/subsystem going?'."""
    return _impl_analytics_wbs_rollup_metrics(wbs_level)

@mcp.tool(name="analytics.critical_path_analytics")
def analytics_critical_path_analytics() -> dict:
    """[ANALYTICS] RU: Статистика КП: общая длина, % готовности, распределение резервов, топ-5 bottleneck. Используйте когда нужен вывод, а не список работ. | EN: CP statistics: total length, % complete, float distribution, top-5 bottlenecks. Use when you need insights, not activity list."""
    return _impl_analytics_critical_path_analytics()

@mcp.tool(name="analytics.resource_aggregate_utilization")
def analytics_resource_aggregate_utilization(
    group_by: Literal["resource_type", "team", "all"] = "all",
    time_bucket: Optional[Literal["week", "month"]] = None) -> dict:
    """[ANALYTICS] RU: Загрузка ресурсов группами. Используйте для вопросов «кто перегружен?», «как распределена нагрузка по ролям/командам?». | EN: Resource load by groups. Use for questions like 'who is overloaded?', 'how is load distributed by roles/teams?'."""
    return _impl_analytics_resource_aggregate_utilization(group_by, time_bucket)

@mcp.tool(name="analytics.evm_trend_analysis")
def analytics_evm_trend_analysis() -> dict:
    """[ANALYTICS] RU: Тренды SPI/CPI, прогноз EAC, текстовая интерпретация. Используйте для отчётов о сроках и бюджете. | EN: SPI/CPI trends, EAC forecast, text interpretation. Use for schedule and budget reports."""
    return _impl_analytics_evm_trend_analysis()

@mcp.tool(name="reports.executive_brief")
def reports_executive_brief(
    audience: Literal["executive", "project_manager", "team_lead"] = "executive",
    focus_areas: Optional[list[Literal["schedule", "resources", "risks", "cost"]]] = None) -> dict:
    """[REPORTS] RU: Готовый текстовый отчёт. Вызывайте когда пользователь просит «кратко», «для руководства», «подготовь сводку». Не требует последующих вызовов raw.*. | EN: Ready text report. Call when user asks for 'brief', 'for management', 'prepare summary'. Does not require subsequent raw.* calls."""
    return _impl_reports_executive_brief(audience, focus_areas)

@mcp.tool(name="reports.anomaly_alerts")
def reports_anomaly_alerts() -> dict:
    """[REPORTS] RU: Только отклонения: отрицательный резерв, критические работы без прогресса, работы без ресурсов. Используйте когда просят «что сломано?», «на что обратить внимание?». | EN: Only deviations: negative float, critical activities without progress, unresourced activities. Use when asked 'what's broken?', 'what to watch?'."""
    return _impl_reports_anomaly_alerts()

@mcp.tool(name="guide.select_analysis_approach")
def guide_select_analysis_approach(
    task: str, graph_size: Literal["small", "medium", "large"] = "medium") -> dict:
    """[GUIDE] RU: Маршрутизатор. Вызывайте ПЕРВЫМ, если запрос пользователя размыт («разбери график», «найди проблемы») или неизвестен размер файла. Вернёт точный план вызовов. | EN: Router. Call FIRST if user request is vague ('analyze schedule', 'find problems') or file size unknown. Returns precise call plan."""
    return _impl_guide_select_analysis_approach(task, graph_size)

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