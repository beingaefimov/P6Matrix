""" p6matrix.py - CPM-движок на матричной математике (numpy)
Формат входных файлов: .pxp (специальный формат - временное решение)

Архитектура матричного CPM:
  N = количество работ
  D - вектор длительностей, shape (N,)
  ADJ   - матрица смежности связей FS,  shape (N, N)    (ADJ[i,j]=1 -> i->j)
  LAG   - матрица лагов,    shape (N, N)
  SS    - матрица флагов Start-to-Start,    shape (N, N)
  FF    - матрица флагов Finish-to-Finish,  shape (N, N)
  SF    - матрица флагов Start-to-Finish,   shape (N, N)

  Прямой проход:
    ES[j] = max по всем pred i из:
        FS: EF[i] + lag = ES[i] + D[i] + lag
        SS: ES[i] + lag
        FF: EF[i] + lag - D[j] = ES[i] + D[i] + lag - D[j]
        SF: ES[i] + lag - D[j]

  Реализовано как итерируемые матричные broadcast-операции:
    для FS: candidate_ES = (ES + D)·ADJ_FS + LAG_FS (broadcast по столбцам)
    затем   ES[j] = max(candidate_ES[:, j])

  Обратный проход - аналогично в транспонированном графе """

import numpy as np
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Any, Tuple
from dataclasses import dataclass, field

@dataclass
class Activity:
    id: str
    name: str
    duration: float
    act_type: str
    cal_override: Optional[str] = None
    parent_id: Optional[str] = None
    constraint_es: Optional[float] = None
    es: float = 0.0
    ef: float = 0.0
    ls: float = 0.0
    lf: float = 0.0
    tf: float = 0.0
    ff: float = 0.0
    on_critical: bool = False

@dataclass
class Relation:
    pred: str
    succ: str
    type: str
    lag: float

@dataclass
class Resource:
    id: str
    name: str
    max_units: float
    cost_per_unit: float = 0.0

@dataclass
class Assignment:
    activity_id: str
    resource_id: str
    units: float

@dataclass
class LevelingOptions:
    level_within_float_only: bool = True
    preserve_early_dates: bool = False
    max_overload_pct: float = 100.0
    priority_field: str = "total_float"

class PXPParser:
    @staticmethod
    def parse(pxp_text: str) -> Tuple[Dict[str, Any], List[Activity], List[Relation], List[Resource], List[Assignment], LevelingOptions, List[str]]:
        lines = pxp_text.splitlines()
        section = None
        meta: Dict[str, str] = {}
        activities: List[Activity] = []
        relations: List[Relation] = []
        resources: List[Resource] = []
        assignments: List[Assignment] = []
        leveling = LevelingOptions()
        warnings: List[str] = []

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
                if len(parts) >= 4:
                    act_id = parts[0]
                    name = parts[1]
                    try:
                        dur = float(parts[2])
                    except ValueError:
                        dur = 0.0
                    act_type = parts[3] if parts[3] else 'task_dependent'
                    cal_ovr = parts[4] if len(parts) > 4 and parts[4] else None
                    parent = parts[5] if len(parts) > 5 and parts[5] else None
                    constraint_es = None
                    if len(parts) > 6 and parts[6]:
                        try:
                            constraint_es = float(parts[6])
                        except ValueError:
                            pass
                    activities.append(Activity(
                        id=act_id, name=name, duration=dur,
                        act_type=act_type, cal_override=cal_ovr, parent_id=parent,
                        constraint_es=constraint_es
                    ))

            elif section == '@RELATIONS':
                parts = [p.strip() for p in line.split('|')]
                if len(parts) >= 4:
                    try:
                        lag = float(parts[3])
                    except ValueError:
                        lag = 0.0
                    relations.append(Relation(
                        pred=parts[0], succ=parts[1], type=parts[2].upper(), lag=lag
                    ))

            elif section == '@RESOURCES':
                parts = [p.strip() for p in line.split('|')]
                if len(parts) >= 3:
                    try:
                        max_u = float(parts[2])
                    except ValueError:
                        max_u = 1.0
                    cost = float(parts[3]) if len(parts) > 3 and parts[3] else 0.0
                    resources.append(Resource(
                        id=parts[0], name=parts[1], max_units=max_u, cost_per_unit=cost
                    ))

            elif section == '@ASSIGNMENTS':
                parts = [p.strip() for p in line.split('|')]
                if len(parts) >= 3:
                    try:
                        units = float(parts[2])
                    except ValueError:
                        units = 1.0
                    assignments.append(Assignment(
                        activity_id=parts[0], resource_id=parts[1], units=units
                    ))

            elif section == '@LEVELING':
                if '=' in line:
                    k, v = line.split('=', 1)
                    k = k.strip()
                    v = v.strip()
                    if k == 'level_within_float_only':
                        leveling.level_within_float_only = v.lower() in ('true', '1', 'yes')
                    elif k == 'preserve_early_dates':
                        leveling.preserve_early_dates = v.lower() in ('true', '1', 'yes')
                    elif k == 'max_overload_pct':
                        try:
                            leveling.max_overload_pct = float(v)
                        except ValueError:
                            pass
                    elif k == 'priority_field':
                        leveling.priority_field = v

        act_ids = {a.id for a in activities}
        valid_relations = []
        for r in relations:
            if r.pred not in act_ids:
                warnings.append(f"Relation skipped: predecessor '{r.pred}' not found")
                continue
            if r.succ not in act_ids:
                warnings.append(f"Relation skipped: successor '{r.succ}' not found")
                continue
            if r.pred == r.succ:
                warnings.append(f"Relation skipped: self-loop on '{r.pred}'")
                continue
            valid_relations.append(r)

        project = {
            'project_id': meta.get('project_id', 'PROJ-001'),
            'project_name': meta.get('project_name', 'Untitled'),
            'start_date': meta.get('start_date', '2024-01-01'),
            'data_date': meta.get('data_date', '2024-01-01'),
            'must_finish': meta.get('must_finish', 'NULL'),
            'calendar': meta.get('calendar', '5d8h'),
            'duration_unit': meta.get('duration_unit', 'days'),
        }

        return project, activities, valid_relations, resources, assignments, leveling, warnings

class CPMEngine:
    def __init__(self, activities: List[Activity], relations: List[Relation]):
        self.activities = activities
        self.relations = relations
        self.N = len(activities)
        self.idx_map = {a.id: i for i, a in enumerate(activities)}
        self.D = np.array([a.duration for a in activities], dtype=float)

        # Matrices for relations (avoid name clash with float vector FF)
        self._fs = np.full((self.N, self.N), np.nan)
        self._ss = np.full((self.N, self.N), np.nan)
        self._ff = np.full((self.N, self.N), np.nan)
        self._sf = np.full((self.N, self.N), np.nan)

        for r in relations:
            i = self.idx_map[r.pred]
            j = self.idx_map[r.succ]
            if r.type == 'FS':
                self._fs[i, j] = r.lag
            elif r.type == 'SS':
                self._ss[i, j] = r.lag
            elif r.type == 'FF':
                self._ff[i, j] = r.lag
            elif r.type == 'SF':
                self._sf[i, j] = r.lag

        self.ES = np.zeros(self.N)
        self.EF = np.zeros(self.N)
        self.LS = np.zeros(self.N)
        self.LF = np.zeros(self.N)
        self.TF = np.zeros(self.N)
        self.FF = np.zeros(self.N)

    def forward_pass(self):
        ES = np.zeros(self.N)
        for i, a in enumerate(self.activities):
            if a.constraint_es is not None:
                ES[i] = a.constraint_es

        changed = True
        max_iter = self.N * 3 + 10
        iteration = 0
        while changed and iteration < max_iter:
            iteration += 1
            old_ES = ES.copy()
            EF = ES + self.D

            # FS: ES_j >= EF_i + lag
            mask = ~np.isnan(self._fs)
            if np.any(mask):
                EF_col = EF.reshape(self.N, 1)
                cand = np.where(mask, EF_col + self._fs, -np.inf)
                ES = np.maximum(ES, cand.max(axis=0))

            # SS: ES_j >= ES_i + lag
            mask = ~np.isnan(self._ss)
            if np.any(mask):
                ES_col = ES.reshape(self.N, 1)
                cand = np.where(mask, ES_col + self._ss, -np.inf)
                ES = np.maximum(ES, cand.max(axis=0))

            # FF: EF_j >= EF_i + lag  => ES_j >= EF_i + lag - D_j
            mask = ~np.isnan(self._ff)
            if np.any(mask):
                EF_col = EF.reshape(self.N, 1)
                cand = np.where(mask, EF_col + self._ff, -np.inf)
                ES = np.maximum(ES, (cand - self.D.reshape(1, self.N)).max(axis=0))

            # SF: EF_j >= ES_i + lag  => ES_j >= ES_i + lag - D_j
            mask = ~np.isnan(self._sf)
            if np.any(mask):
                ES_col = ES.reshape(self.N, 1)
                cand = np.where(mask, ES_col + self._sf, -np.inf)
                ES = np.maximum(ES, (cand - self.D.reshape(1, self.N)).max(axis=0))

            for i, a in enumerate(self.activities):
                if a.constraint_es is not None:
                    ES[i] = max(ES[i], a.constraint_es)

            changed = not np.allclose(ES, old_ES)

        self.ES = ES
        self.EF = ES + self.D

    def backward_pass(self):
        project_finish = self.EF.max()
        LF = np.full(self.N, project_finish)

        changed = True
        max_iter = self.N * 3 + 10
        iteration = 0
        while changed and iteration < max_iter:
            iteration += 1
            old_LF = LF.copy()
            LS = LF - self.D

            # FS: LF_i <= LS_j - lag
            mask = ~np.isnan(self._fs)
            if np.any(mask):
                LS_row = LS.reshape(1, self.N)
                cand = np.where(mask, LS_row - self._fs, np.inf)
                LF = np.minimum(LF, cand.min(axis=1))

            # SS: LF_i <= LS_j - lag + D_i
            mask = ~np.isnan(self._ss)
            if np.any(mask):
                LS_row = LS.reshape(1, self.N)
                cand = np.where(mask, LS_row - self._ss + self.D.reshape(self.N, 1), np.inf)
                LF = np.minimum(LF, cand.min(axis=1))

            # FF: LF_i <= LF_j - lag
            mask = ~np.isnan(self._ff)
            if np.any(mask):
                LF_row = LF.reshape(1, self.N)
                cand = np.where(mask, LF_row - self._ff, np.inf)
                LF = np.minimum(LF, cand.min(axis=1))

            # SF: LF_i <= LF_j + D_i - lag
            mask = ~np.isnan(self._sf)
            if np.any(mask):
                LF_row = LF.reshape(1, self.N)
                cand = np.where(mask, LF_row + self.D.reshape(self.N, 1) - self._sf, np.inf)
                LF = np.minimum(LF, cand.min(axis=1))

            changed = not np.allclose(LF, old_LF)

        self.LF = LF
        self.LS = LF - self.D

    def calculate_floats(self):
        self.TF = self.LF - self.EF
        self.TF = np.where(np.abs(self.TF) < 1e-9, 0.0, self.TF)

        FF_arr = np.full(self.N, np.inf)

        # FS successors
        mask = ~np.isnan(self._fs)
        if np.any(mask):
            ES_row = self.ES.reshape(1, self.N)
            EF_col = self.EF.reshape(self.N, 1)
            cand = np.where(mask, ES_row - EF_col - self._fs, np.inf)
            FF_arr = np.minimum(FF_arr, cand.min(axis=1))

        # SS successors
        mask = ~np.isnan(self._ss)
        if np.any(mask):
            ES_row = self.ES.reshape(1, self.N)
            ES_col = self.ES.reshape(self.N, 1)
            cand = np.where(mask, ES_row - ES_col - self._ss, np.inf)
            FF_arr = np.minimum(FF_arr, cand.min(axis=1))

        # FF successors
        mask = ~np.isnan(self._ff)
        if np.any(mask):
            EF_row = self.EF.reshape(1, self.N)
            EF_col = self.EF.reshape(self.N, 1)
            cand = np.where(mask, EF_row - EF_col - self._ff, np.inf)
            FF_arr = np.minimum(FF_arr, cand.min(axis=1))

        # SF successors
        mask = ~np.isnan(self._sf)
        if np.any(mask):
            EF_row = self.EF.reshape(1, self.N)
            ES_col = self.ES.reshape(self.N, 1)
            cand = np.where(mask, EF_row - ES_col - self._sf, np.inf)
            FF_arr = np.minimum(FF_arr, cand.min(axis=1))

        has_succ = (
            (~np.isnan(self._fs)).any(axis=1) |
            (~np.isnan(self._ss)).any(axis=1) |
            (~np.isnan(self._ff)).any(axis=1) |
            (~np.isnan(self._sf)).any(axis=1))
        FF_arr[~has_succ] = self.TF[~has_succ]
        FF_arr[np.isinf(FF_arr)] = self.TF[np.isinf(FF_arr)]
        FF_arr = np.where(np.abs(FF_arr) < 1e-9, 0.0, FF_arr)

        self.FF = FF_arr

    def run(self):
        self.forward_pass()
        self.backward_pass()
        self.calculate_floats()
        for i, a in enumerate(self.activities):
            a.es = float(self.ES[i])
            a.ef = float(self.EF[i])
            a.ls = float(self.LS[i])
            a.lf = float(self.LF[i])
            a.tf = float(self.TF[i])
            a.ff = float(self.FF[i])
            a.on_critical = abs(a.tf) < 1e-6

    def topological_sort(self) -> List[int]:
        in_degree = np.zeros(self.N, dtype=int)
        for r in self.relations:
            j = self.idx_map[r.succ]
            in_degree[j] += 1

        queue = [i for i in range(self.N) if in_degree[i] == 0]
        order = []
        while queue:
            queue.sort(key=lambda i: (self.TF[i], self.activities[i].id))
            u = queue.pop(0)
            order.append(u)
            for v in range(self.N):
                if (not np.isnan(self._fs[u, v]) or not np.isnan(self._ss[u, v]) or
                        not np.isnan(self._ff[u, v]) or not np.isnan(self._sf[u, v])):
                    in_degree[v] -= 1
                    if in_degree[v] == 0:
                        queue.append(v)
        return order

    def level_resources(self, resources: List[Resource], assignments: List[Assignment], options: LevelingOptions):
        """ Serial scheduling with resource constraints """
        if not resources or not assignments:
            return

        self.run()

        act_res: Dict[int, Dict[str, float]] = {i: {} for i in range(self.N)}
        for asgn in assignments:
            if asgn.activity_id in self.idx_map:
                i = self.idx_map[asgn.activity_id]
                act_res[i][asgn.resource_id] = act_res[i].get(asgn.resource_id, 0.0) + asgn.units

        if not any(act_res[i] for i in act_res):
            return

        topo = self.topological_sort()
        # cycle detected, skip leveling
        if len(topo) < self.N:
            return

        max_days = int(np.ceil(self.EF.max())) + 500
        limit_factor = options.max_overload_pct / 100.0
        res_avail = {r.id: np.full(max_days, r.max_units * limit_factor, dtype=float) for r in resources}

        new_es = np.zeros(self.N)
        new_ef = np.zeros(self.N)

        for i in topo:
            # Logical earliest start from already scheduled predecessors
            earliest = 0.0
            for p in range(self.N):
                if not np.isnan(self._fs[p, i]):
                    earliest = max(earliest, new_ef[p] + self._fs[p, i])
                if not np.isnan(self._ss[p, i]):
                    earliest = max(earliest, new_es[p] + self._ss[p, i])
                if not np.isnan(self._ff[p, i]):
                    earliest = max(earliest, new_ef[p] + self._ff[p, i] - self.D[i])
                if not np.isnan(self._sf[p, i]):
                    earliest = max(earliest, new_es[p] + self._sf[p, i] - self.D[i])

            upper = self.LS[i] if options.level_within_float_only else max_days - int(self.D[i])
            upper = min(upper, max_days - int(self.D[i]))

            start = int(np.floor(earliest))
            placed = False
            while start <= upper:
                end = start + self.D[i]
                end_idx = int(np.ceil(end))
                ok = True
                for r_id, units in act_res[i].items():
                    if r_id in res_avail:
                        if start < end_idx and np.any(res_avail[r_id][start:end_idx] < units - 1e-9):
                            ok = False
                            break
                if ok:
                    new_es[i] = start
                    new_ef[i] = end
                    for r_id, units in act_res[i].items():
                        if r_id in res_avail:
                            res_avail[r_id][start:end_idx] -= units
                    placed = True
                    break
                start += 1

            if not placed:
                new_es[i] = earliest
                new_ef[i] = earliest + self.D[i]
                for r_id, units in act_res[i].items():
                    if r_id in res_avail:
                        s = int(np.floor(new_es[i]))
                        e = int(np.ceil(new_ef[i]))
                        res_avail[r_id][s:e] -= units

        self.ES = new_es
        self.EF = new_ef
        for i, a in enumerate(self.activities):
            a.es = float(new_es[i])
            a.ef = float(new_ef[i])

        self.backward_pass()
        self.calculate_floats()
        for i, a in enumerate(self.activities):
            a.ls = float(self.LS[i])
            a.lf = float(self.LF[i])
            a.tf = float(self.TF[i])
            a.ff = float(self.FF[i])
            a.on_critical = abs(a.tf) < 1e-6

def calculate_resource_load(activities: List[Activity], assignments: List[Assignment],
                            resources: List[Resource]) -> Dict[str, List[float]]:
    if not activities:
        return {}
    max_day = int(np.ceil(max(a.ef for a in activities)))
    if max_day <= 0:
        return {r.id: [] for r in resources}

    load = {r.id: np.zeros(max_day, dtype=float) for r in resources}
    idx_map = {a.id: i for i, a in enumerate(activities)}

    for asgn in assignments:
        if asgn.activity_id not in idx_map:
            continue
        a = activities[idx_map[asgn.activity_id]]
        if asgn.resource_id not in load:
            continue
        start = int(np.floor(a.es))
        end = int(np.ceil(a.ef))
        for d in range(start, end):
            if 0 <= d < max_day:
                load[asgn.resource_id][d] += asgn.units

    return {k: v.tolist() for k, v in load.items()}

def format_result(project: Dict[str, Any], activities: List[Activity], resources: List[Resource],
                  resource_load: Dict[str, List[float]], pxp_text: str, warnings: List[str]) -> Dict[str, Any]:
    # Это уже точно прошло
    start_date_str = project.get('start_date', '2024-01-01')
    try:
        start_dt = datetime.strptime(start_date_str, '%Y-%m-%d')
    except ValueError:
        start_dt = datetime(2024, 1, 1)

    def add_days(dt: datetime, days: int) -> datetime:
        return dt + timedelta(days=days)

    def fmt(dt: datetime) -> str:
        return dt.strftime('%Y-%m-%d')

    max_ef = max((a.ef for a in activities), default=0.0)
    finish_day = int(np.ceil(max_ef)) - 1 if max_ef > 0 else 0
    finish_dt = add_days(start_dt, finish_day)

    activities_out = []
    for a in activities:
        es_day = int(np.floor(a.es))
        ls_day = int(np.floor(a.ls))

        if a.duration == 0:
            ef_day = es_day
            lf_day = ls_day
        else:
            ef_day = int(np.ceil(a.ef)) - 1
            lf_day = int(np.ceil(a.lf)) - 1

        activities_out.append({
            'id': a.id,
            'name': a.name,
            'duration': a.duration,
            'es_date': fmt(add_days(start_dt, es_day)),
            'ef_date': fmt(add_days(start_dt, ef_day)),
            'ls_date': fmt(add_days(start_dt, ls_day)),
            'lf_date': fmt(add_days(start_dt, lf_day)),
            'tf': round(a.tf, 1),
            'ff': round(a.ff, 1),
            'on_critical': a.on_critical,
            'parent_id': a.parent_id,})

    resources_out = [{
        'id': r.id,
        'name': r.name,
        'max_units': r.max_units,
        'cost_per_unit': r.cost_per_unit,} for r in resources]

    return {
        'project_id': project.get('project_id', 'PROJ-001'),
        'project_name': project.get('project_name', 'Untitled'),
        'start_date': start_date_str,
        'finish_date': fmt(finish_dt),
        'duration_days': int(np.ceil(max_ef)),
        'activities': activities_out,
        'resources': resources_out,
        'resource_load': resource_load,
        'pxp_text': pxp_text,
        'warnings': warnings,}

def schedule(pxp_text: str, level_within_float_only: bool = True, max_overload_pct: float = 100.0) -> Dict[str, Any]:
    project, activities, relations, resources, assignments, leveling, warnings = PXPParser.parse(pxp_text)

    leveling.level_within_float_only = level_within_float_only
    leveling.max_overload_pct = max_overload_pct

    engine = CPMEngine(activities, relations)
    engine.run()

    resource_load = calculate_resource_load(activities, assignments, resources)
    return format_result(project, activities, resources, resource_load, pxp_text, warnings)

def level(pxp_text: str, level_within_float_only: bool = True, max_overload_pct: float = 100.0) -> Dict[str, Any]:
    project, activities, relations, resources, assignments, leveling, warnings = PXPParser.parse(pxp_text)

    leveling.level_within_float_only = level_within_float_only
    leveling.max_overload_pct = max_overload_pct

    engine = CPMEngine(activities, relations)
    engine.level_resources(resources, assignments, leveling)

    resource_load = calculate_resource_load(activities, assignments, resources)
    return format_result(project, activities, resources, resource_load, pxp_text, warnings)

parse_pxp = PXPParser.parse

def schedule_project(pxp_text: str, level_within_float_only: bool = True, max_overload_pct: float = 100.0):
    return schedule(pxp_text, level_within_float_only, max_overload_pct)

def level_resources(pxp_text: str, level_within_float_only: bool = True, max_overload_pct: float = 100.0):
    return level(pxp_text, level_within_float_only, max_overload_pct)