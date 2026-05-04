""" Конвертер XER (tab-separated) в PXP формат

Структура: секции %T <TABLE_NAME>, колонки %F, строки %R, конец секции %E.

Поддерживаем таблицы:
  PROJECT   - META (project_id, project_name, start_date)
  TASK  - ACTIVITIES (task_id, task_name, target_drtn_hr_cnt, task_type)
  TASKPRED  - RELATIONS  (task_id, pred_task_id, pred_type, lag_hr_cnt)
  RSRC  - RESOURCES  (rsrc_id, rsrc_name, max_qty_per_hr)
  TASKRSRC  - ASSIGNMENTS (task_id, rsrc_id, target_qty_per_hr)

Всё остальное - пропускаем, добавляем в warnings """

from __future__ import annotations
from typing import Optional

def _parse_xer_tables(xer_text: str) -> dict[str, list[dict[str, str]]]:
    """ Парсит XER в dict[table_name -> list[row_dict]] """
    tables: dict[str, list[dict[str, str]]] = {}
    current_table: Optional[str] = None
    current_fields: list[str] = []

    for raw_line in xer_text.splitlines():
        line = raw_line.rstrip("\r")
        if line.startswith("%T"):
            current_table = line[2:].strip()
            current_fields = []
            tables[current_table] = []
        elif line.startswith("%F") and current_table:
            current_fields = line[2:].strip().split("\t")
        elif line.startswith("%R") and current_table and current_fields:
            values = line[2:].strip().split("\t")
            while len(values) < len(current_fields):
                values.append("")
            row = dict(zip(current_fields, values))
            tables[current_table].append(row)
        elif line.startswith("%E"):
            current_table = None
    return tables

def _safe(row: dict, *keys: str, default: str = "") -> str:
    """ Возвращает первое непустое значение из ключей """
    for k in keys:
        v = row.get(k, "").strip()
        if v and v not in ("0", ""):
            return v
    return default

def _hours_to_days(hr_str: str, hours_per_day: float = 8.0) -> float:
    """ Конвертирует часы (строка) в дни """
    try:
        return round(float(hr_str) / hours_per_day, 2)
    except (ValueError, ZeroDivisionError):
        return 0.0

def _xer_type_to_pxp(pred_type: str) -> str:
    mapping = {
        "PR_FS": "FS", "PR_SS": "SS",
        "PR_FF": "FF", "PR_SF": "SF",}
    return mapping.get(pred_type.strip(), "FS")

def _xer_task_type(task_type: str) -> str:
    mapping = {
        "TT_Task": "task_dependent",
        "TT_Rsrc": "resource_dependent",
        "TT_FixedDrtn": "fixed_duration",
        "TT_Mile": "milestone",
        "TT_FinMile": "milestone",
        "TT_LOE": "task_dependent",
        "TT_WBS": "task_dependent",}
    return mapping.get(task_type.strip(), "task_dependent")

def convert_xer_to_pxp(xer_text: str, hours_per_day: float = 8.0) -> tuple[str, list[str]]:
    warnings: list[str] = []
    tables = _parse_xer_tables(xer_text)

    lines: list[str] = ["# Converted from XER by p6matrix"]

    # META
    proj_rows = tables.get("PROJECT", [])
    project_id = "XER-PROJECT"
    project_name = "XER Project"
    start_date = "2024-01-01"
    must_finish = "NULL"

    if proj_rows:
        row = proj_rows[0]
        project_id   = _safe(row, "proj_short_name", "proj_id", default=project_id)
        project_name = _safe(row, "proj_name", "proj_short_name", default=project_name)

        for date_field in ("last_recalc_date", "plan_start_date",
                           "scd_start_date", "act_start_date"):
            raw = row.get(date_field, "").strip()
            if raw and len(raw) >= 10:
                start_date = raw[:10]
                break

        for date_field in ("scd_end_date", "plan_end_date", "anticip_end_date"):
            raw = row.get(date_field, "").strip()
            if raw and len(raw) >= 10:
                must_finish = raw[:10]
                break

        if len(proj_rows) > 1:
            warnings.append(
                f"{len(proj_rows)} projects here; w'l use first: {project_id}")

    lines += [
        "\n@META",
        f"project_id   = {project_id}",
        f"project_name = {project_name}",
        f"start_date   = {start_date}",
        f"data_date    = {start_date}",
        f"must_finish  = {must_finish}",
        "calendar     = 5d8h",
        "duration_unit = days",]

    # ACTIVITIES
    task_rows = tables.get("TASK", [])
    if not task_rows:
        warnings.append("XER: таблица TASK не найдена - работы отсутствуют")

    valid_tasks: list[dict] = []
    seen_ids: set[str] = set()
    dup_count = 0

    for row in task_rows:
        task_type = row.get("task_type", "TT_Task")
        pxp_type = _xer_task_type(task_type)

        dur_hr = _safe(row, "target_drtn_hr_cnt", "remain_drtn_hr_cnt",
                       "act_drtn_hr_cnt", default="0")
        dur_days = _hours_to_days(dur_hr, hours_per_day)

        task_id = _safe(row, "task_code", "task_id")
        task_name = _safe(row, "task_name", "task_code", default=task_id)

        if not task_id:
            warnings.append("XER: пропущена задача без ID")
            continue

        # Пропускаем повторяющиеся task_id
        if task_id in seen_ids:
            dup_count += 1
            continue
        seen_ids.add(task_id)

        valid_tasks.append({
            "id": task_id,
            "name": task_name.replace("|", "│"),
            "duration": dur_days,
            "type": pxp_type,})

    if dup_count > 0:
        warnings.append(f"XER: пропущено {dup_count} дублирующих задач (повторяющиеся task_id)")

    lines.append("\n@ACTIVITIES")
    lines.append("# id | name | duration | type")
    for t in valid_tasks:
        lines.append(f"  {t['id']}  |  {t['name']}  |  {t['duration']}  |  {t['type']}")

    # RELATIONS 
    pred_rows = tables.get("TASKPRED", [])
    lines.append("\n@RELATIONS")
    lines.append("# pred | succ | type | lag")

    skipped_rels = 0
    for row in pred_rows:
        succ_id = _safe(row, "task_id")
        pred_id = _safe(row, "pred_task_id")
        rel_type = _xer_type_to_pxp(row.get("pred_type", "PR_FS"))
        lag_hr   = _safe(row, "lag_hr_cnt", default="0")

        try:
            lag_days = _hours_to_days(lag_hr, hours_per_day)
        except Exception:
            lag_days = 0.0
            warnings.append(f"XER: не удалось прочитать лаг для связи {pred_id} в {succ_id}")

        if pred_id not in seen_ids or succ_id not in seen_ids:
            skipped_rels += 1
            continue

        lines.append(f"  {pred_id}  |  {succ_id}  |  {rel_type}  |  {lag_days}")

    if skipped_rels:
        warnings.append(
            f"XER: пропущено {skipped_rels} связей (ссылаются на неизвестные задачи)")

    # RESOURCES
    rsrc_rows = tables.get("RSRC", [])
    known_rsrc: set[str] = set()

    if rsrc_rows:
        lines.append("\n@RESOURCES")
        lines.append("# res_id | name | max_units | cost_per_unit")

        for row in rsrc_rows:
            rsrc_id   = _safe(row, "rsrc_id")
            rsrc_name = _safe(row, "rsrc_name", "rsrc_short_name",
                              default=rsrc_id).replace("|", "│")
            max_qty_hr = float(row.get("max_qty_per_hr", "0") or "0")
            max_units  = round(max_qty_hr * hours_per_day, 2) or 1.0
            cost_hr    = float(row.get("cost_per_qty", "0") or "0")
            cost_day   = round(cost_hr * hours_per_day, 2)

            if not rsrc_id:
                continue

            lines.append(f"  {rsrc_id}  |  {rsrc_name}  |  {max_units}  |  {cost_day}")
            known_rsrc.add(rsrc_id)

        # ASSIGNMENTS
        taskrsrc_rows = tables.get("TASKRSRC", [])
        if taskrsrc_rows:
            lines.append("\n@ASSIGNMENTS")
            lines.append("# activity | resource | units")
            skipped_asgn = 0
            for row in taskrsrc_rows:
                task_id  = _safe(row, "task_id")
                rsrc_id  = _safe(row, "rsrc_id")
                qty_hr   = float(row.get("target_qty_per_hr", "0") or "0")
                units    = round(qty_hr * hours_per_day, 2)

                if task_id not in seen_ids or rsrc_id not in known_rsrc:
                    skipped_asgn += 1
                    continue
                if units <= 0:
                    continue

                lines.append(f"  {task_id}  |  {rsrc_id}  |  {units}")

            if skipped_asgn:
                warnings.append(
                    f"XER: пропущено {skipped_asgn} назначений (неизвестная задача/ресурс)")

    # Неподдерживаемые таблицы 
    known_tables = {"PROJECT", "TASK", "TASKPRED", "RSRC", "TASKRSRC",
                    "CALENDAR", "RCATTYPE", "RCATVAL", "ROLES", "ACCOUNT"}
    extra = set(tables.keys()) - known_tables
    if extra:
        warnings.append(
            f"XER: следующие таблицы проигнорированы: {', '.join(sorted(extra))}")

    pxp_text = "\n".join(lines) + "\n"
    return pxp_text, warnings