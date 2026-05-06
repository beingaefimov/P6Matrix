""" Бэкенд только парсит PXP и возвращает структуры данных.
Никаких расчётов CPM - всё это делает клиент на WebGPU.
Возвращает минимальные данные для расчёта на клиенте:
  - Для каждой задачи: id, duration, constraint_es,
    actual_start, actual_finish, pct_complete,
    actual_duration, remaining_duration
  - Все связи (pred, succ, type, lag)
  - Все назначения ресурсов (activity_id, resource_id, units)
  - Ресурсы (id, name, max_units).
Не включает в минимальные данные: name, notes, UDF, wbs_id, cal_id -
они приходят отдельно при клике через /activity/detail """

from typing import Any

def parse_minimal(pxp_text: str) -> dict[str, Any]:
    """ Парсит PXP и возвращает минимальные данные для клиентского CPM-движка """
    lines = pxp_text.splitlines()
    section = None
    warnings: list[str] = []

    meta: dict[str, str] = {}

    # Минимальные данные по задачам для расчёта
    activities_min: list[dict] = []
    # Полные данные задач - хранятся на сервере для lazy detail
    activities_detail: dict[str, dict] = {}

    relations: list[dict] = []
    resources: list[dict] = []
    assignments: list[dict] = []

    act_ids: set[str] = set()

    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('@'):
            section = line
            continue

        if section == '@META':
            if '=' in line:
                k, v = line.split('=', 1)
                meta[k.strip()] = v.strip()

        elif section == '@ACTIVITIES':
            parts = [p.strip() for p in line.split('|')]
            if len(parts) < 4:
                continue

            act_id   = parts[0]
            name     = parts[1]
            try:
                dur = float(parts[2])
            except ValueError:
                dur = 0.0
            act_type     = parts[3] if parts[3] else 'task_dependent'
            cal_id       = parts[4] if len(parts) > 4 else ''
            parent_id    = parts[5] if len(parts) > 5 else ''

            constraint_es = None
            if len(parts) > 6 and parts[6]:
                try:
                    constraint_es = float(parts[6])
                except ValueError:
                    pass

            constraint_type = parts[7] if len(parts) > 7 else ''
            actual_start    = parts[8] if len(parts) > 8  and parts[8]  else None
            actual_finish   = parts[9] if len(parts) > 9  and parts[9]  else None

            pct = 0.0
            if len(parts) > 10 and parts[10]:
                try:
                    pct = float(parts[10])
                except ValueError:
                    pass

            priority = 0
            if len(parts) > 11 and parts[11]:
                try:
                    priority = int(parts[11])
                except ValueError:
                    pass

            notes = parts[12] if len(parts) > 12 else ''

            actual_dur = None
            if len(parts) > 13 and parts[13]:
                try:
                    actual_dur = float(parts[13])
                except ValueError:
                    pass

            remain_dur = None
            if len(parts) > 14 and parts[14]:
                try:
                    remain_dur = float(parts[14])
                except ValueError:
                    pass

            act_ids.add(act_id)

            # Минимум для CPM + выравнивания + отображения полосы
            activities_min.append({
                'id':                 act_id,
                'duration':           dur,
                'constraint_es':      constraint_es,
                'actual_start':       actual_start,
                'actual_finish':      actual_finish,
                'pct_complete':       pct,
                'actual_duration':    actual_dur,
                'remaining_duration': remain_dur,
                # Нужны для отображения строки Ганта и дерева WBS
                'name':       name,
                'parent_id':  parent_id or None,
                'act_type':   act_type})

            # Полные детали - только по запросу /activity/detail
            activities_detail[act_id] = {
                'id':               act_id,
                'name':             name,
                'duration':         dur,
                'act_type':         act_type,
                'cal_id':           cal_id,
                'parent_id':        parent_id or None,
                'constraint_es':    constraint_es,
                'constraint_type':  constraint_type,
                'actual_start':     actual_start,
                'actual_finish':    actual_finish,
                'pct_complete':     pct,
                'priority':         priority,
                'notes':            notes,
                'actual_duration':  actual_dur,
                'remaining_duration': remain_dur}
                # UDF и прочее можно добавить при расширении

        elif section == '@RELATIONS':
            parts = [p.strip() for p in line.split('|')]
            if len(parts) < 3:
                continue
            pred = parts[0]; succ = parts[1]
            rtype = parts[2].upper() if parts[2] else 'FS'
            try:
                lag = float(parts[3]) if len(parts) > 3 and parts[3] else 0.0
            except ValueError:
                lag = 0.0

            if pred not in act_ids:
                warnings.append(f"Relation skipped: predecessor '{pred}' not found")
                continue
            if succ not in act_ids:
                warnings.append(f"Relation skipped: successor '{succ}' not found")
                continue
            if pred == succ:
                warnings.append(f"Relation skipped: self-loop on '{pred}'")
                continue

            relations.append({'pred': pred, 'succ': succ, 'type': rtype, 'lag': lag})

        elif section == '@RESOURCES':
            parts = [p.strip() for p in line.split('|')]
            if len(parts) < 3:
                continue
            try:
                max_u = float(parts[2])
            except ValueError:
                max_u = 1.0
            cost = 0.0
            if len(parts) > 3 and parts[3]:
                try:
                    cost = float(parts[3])
                except ValueError:
                    pass
            resources.append({
                'id':           parts[0],
                'name':         parts[1],
                'max_units':    max_u,
                'cost_per_unit': cost})

        elif section == '@ASSIGNMENTS':
            parts = [p.strip() for p in line.split('|')]
            if len(parts) < 2:
                continue
            act_id = parts[0]; res_id = parts[1]

            # Поддержка обоих форматов:
            # Новый: act | res | role | units | budget | actual_qty | rate_type | remaining_qty
            # Старый: act | res | units
            if len(parts) >= 4 and parts[2] != '' and _is_role(parts[2]) or (len(parts) >= 4 and parts[3] != ''):
                # Новый формат
                try:
                    units = float(parts[3]) if len(parts) > 3 and parts[3] else 1.0
                except ValueError:
                    units = 1.0
                try:
                    actual_qty = float(parts[5]) if len(parts) > 5 and parts[5] else None
                except ValueError:
                    actual_qty = None
                try:
                    remain_qty = float(parts[7]) if len(parts) > 7 and parts[7] else None
                except ValueError:
                    remain_qty = None
            else:
                # Старый компактный формат
                try:
                    units = float(parts[2]) if len(parts) > 2 and parts[2] else 1.0
                except ValueError:
                    units = 1.0
                actual_qty = None
                remain_qty = None

            assignments.append({
                'activity_id':   act_id,
                'resource_id':   res_id,
                'units':         units,
                'actual_qty':    actual_qty,
                'remaining_qty': remain_qty})

    project = {
        'project_id':    meta.get('project_id', 'PROJ-001'),
        'project_name':  meta.get('project_name', 'Untitled'),
        'start_date':    meta.get('start_date', '2024-01-01'),
        'data_date':     meta.get('data_date', '2024-01-01'),
        'must_finish':   meta.get('must_finish', 'NULL'),
        'calendar':      meta.get('calendar', '5d8h'),
        'duration_unit': meta.get('duration_unit', 'days')}

    # activities_detail хранится в памяти только на время запроса -
    # для lazy detail нужен отдельный POST /activity/detail с pxp_text.
    # Здесь сохраняем полный текст для этого

    return {
        'project':     project,
        'activities':  activities_min,
        'relations':   relations,
        'resources':   resources,
        'assignments': assignments,
        'pxp_text':    pxp_text,
        'warnings':    warnings}


def parse_activity_detail(pxp_text: str, activity_id: str) -> dict | None:
    """ Парсит PXP и возвращает полные данные одной задачи.
    Вызывается только при клике на задачу """
    result = parse_minimal(pxp_text)
    # activities_detail не возвращается из parse_minimal публично,
    # поэтому делаем отдельный быстрый проход только по @ACTIVITIES
    lines = pxp_text.splitlines()
    section = None
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('@'):
            section = line
            continue
        if section != '@ACTIVITIES':
            continue
        parts = [p.strip() for p in line.split('|')]
        if not parts or parts[0] != activity_id:
            continue

        # Собираем полные поля
        name            = parts[1] if len(parts) > 1 else ''
        dur             = float(parts[2]) if len(parts) > 2 and parts[2] else 0.0
        act_type        = parts[3] if len(parts) > 3 else 'task_dependent'
        cal_id          = parts[4] if len(parts) > 4 else ''
        parent_id       = parts[5] if len(parts) > 5 else ''
        constraint_es   = float(parts[6]) if len(parts) > 6 and parts[6] else None
        constraint_type = parts[7] if len(parts) > 7 else ''
        actual_start    = parts[8] if len(parts) > 8  and parts[8]  else None
        actual_finish   = parts[9] if len(parts) > 9  and parts[9]  else None
        pct             = float(parts[10]) if len(parts) > 10 and parts[10] else 0.0
        priority        = int(parts[11]) if len(parts) > 11 and parts[11] else 0
        notes           = parts[12] if len(parts) > 12 else ''
        actual_dur      = float(parts[13]) if len(parts) > 13 and parts[13] else None
        remain_dur      = float(parts[14]) if len(parts) > 14 and parts[14] else None

        # Назначения для этой задачи
        assignments = _parse_assignments_for(pxp_text, activity_id)
        # Связи для этой задачи
        relations = _parse_relations_for(pxp_text, activity_id)

        return {
            'id':                 activity_id,
            'name':               name,
            'duration':           dur,
            'act_type':           act_type,
            'cal_id':             cal_id,
            'parent_id':          parent_id or None,
            'constraint_es':      constraint_es,
            'constraint_type':    constraint_type,
            'actual_start':       actual_start,
            'actual_finish':      actual_finish,
            'pct_complete':       pct,
            'priority':           priority,
            'notes':              notes,
            'actual_duration':    actual_dur,
            'remaining_duration': remain_dur,
            'assignments':        assignments,
            'predecessors':       relations['preds'],
            'successors':         relations['succs']}
    return None

def _parse_assignments_for(pxp_text: str, activity_id: str) -> list[dict]:
    lines = pxp_text.splitlines()
    section = None
    result = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('@'):
            section = line
            continue
        if section != '@ASSIGNMENTS':
            continue
        parts = [p.strip() for p in line.split('|')]
        if not parts or parts[0] != activity_id:
            continue
        res_id = parts[1] if len(parts) > 1 else ''
        if not res_id:
            continue
        # Определяем формат
        if len(parts) >= 4 and (parts[2] == '' or _is_role(parts[2])) :
            units = float(parts[3]) if parts[3] else 1.0
            actual_qty = float(parts[5]) if len(parts) > 5 and parts[5] else None
            remain_qty = float(parts[7]) if len(parts) > 7 and parts[7] else None
        else:
            units = float(parts[2]) if len(parts) > 2 and parts[2] else 1.0
            actual_qty = None
            remain_qty = None
        result.append({
            'resource_id':   res_id,
            'units':         units,
            'actual_qty':    actual_qty,
            'remaining_qty': remain_qty})
    return result

def _parse_relations_for(pxp_text: str, activity_id: str) -> dict:
    lines = pxp_text.splitlines()
    section = None
    preds = []
    succs = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('@'):
            section = line
            continue
        if section != '@RELATIONS':
            continue
        parts = [p.strip() for p in line.split('|')]
        if len(parts) < 2:
            continue
        pred = parts[0]; succ = parts[1]
        rtype = parts[2].upper() if len(parts) > 2 and parts[2] else 'FS'
        lag = float(parts[3]) if len(parts) > 3 and parts[3] else 0.0
        if succ == activity_id:
            preds.append({'pred': pred, 'type': rtype, 'lag': lag})
        if pred == activity_id:
            succs.append({'succ': succ, 'type': rtype, 'lag': lag})
    return {'preds': preds, 'succs': succs}

def _is_role(s: str) -> bool:
    """ Эвристика: строка похожа на role_id (не число) """
    if not s:
        return False
    try:
        float(s)
        return False
    except ValueError:
        return True

def validate_pxp(pxp_text: str) -> None:
    """ Минимальная валидация PXP перед сохранением """
    if '@ACTIVITIES' not in pxp_text and '@META' not in pxp_text:
        raise ValueError("Not a valid PXP file: missing @META or @ACTIVITIES section")
