# PXP - eXchange Plan (псевдо-формат)

## Структура файла .pxp

Файл - plain-text, секции отделяются маркерами `@SECTION`.
Комментарии: строки, начинающиеся с `#`.

### Мультипроектность

Если файл содержит несколько проектов, они разделяются маркерами:
```
@PROJECT_END
@PROJECT_BEGIN
project_id = PROJ-002
...
```

---

### @META
Метаданные проекта (маппинг: XER в PROJECT).

```
@META
project_id           = PROJ-001
project_name         = Строительство объекта А
start_date           = 2024-01-01
data_date            = 2024-01-01
must_finish          = NULL          # или дата - тогда обратный проход от неё
calendar             = 5d8h          # 5 дней в неделю, 8 часов в день
duration_unit        = days
hours_per_day        = 8             # для конвертации XER (часы в дни)
auto_compute         = true          # автостатусы из связей
critical_path_method = forward_backward
risk_level           = Medium        # XER: PROJECT.risk_level
status_code          = Active        # XER: PROJECT.status_code
location_name        = Москва        # XER: LOCA (по ссылке)
plan_name            = Plan v1.0     # XER: BASETYPE
```

---

### @WBS
Иерархическая структура работ (маппинг: XER в PROJWBS).

```
@WBS
# wbs_id | name                  | code        | parent_id | seq_num
  W1     | Строительство         | 1.0         | NULL      | 1
  W2     | Проектирование        | 1.1         | W1        | 1
  W3     | Строительство         | 1.2         | W1        | 2
  W4     | Инженерные сети       | 1.2.1       | W3        | 1
```

---

### @ACTIVITIES
Работы (маппинг: XER в TASK). Основные поля.

```
@ACTIVITIES
# id | name                        | duration | type             | cal_id | wbs_id | constraint_type | constraint_date | actual_start | actual_finish | pct_complete | priority | notes
  A  | Проектирование               |    10    | task_dependent   | CAL1   | W2     |                 |                 |              |               | 0            | 0        |
  B  | Закупка материалов           |     5    | task_dependent   | CAL1   | W3     |                 |                 |              |               | 0            | 0        |
  C  | Земляные работы              |     8    | task_dependent   | CAL1   | W4     |                 |                 | 2024-01-15   |               | 50           | 0        | Требуется permit
  D  | Фундамент                    |    12    | fixed_duration   | CAL1   | W4     | FS              | 2024-02-10      |              |               | 0            | 0        |
  H  | Сдача объекта                |     0    | milestone        | CAL1   | W1     |                 |                 |              |               | 0            | 0        |
```

type: task_dependent | resource_dependent | fixed_duration | fixed_units_and_duration | milestone

constraint_type: FS | SS | FF | SF | MSO | MFO | SSO | FFO (XER-коды ограничений)

---

### @RELATIONS
Связи предшествования (маппинг: XER в TASKPRED).

```
@RELATIONS
# pred | succ | type | lag | pct_complete_type | pct_value
  A    |  B   |  FS  |  0  |                   |
  A    |  C   |  FS  |  0  |                   |
  B    |  D   |  FS  |  2  |                   |
  C    |  D   |  FS  |  0  |                   |
  D    |  E   |  FS  |  0  |                   |
  E    |  G   |  SS  |  3  |                   |
```

---

### @RESOURCES
Ресурсы (маппинг: XER в RSRC).

```
@RESOURCES
# res_id | name          | type   | max_units | cost_per_unit | role_id | curve_name | overtime_rate
  R1     | Инженер       | Labor  |     2     |   100         | ROLE1   | Linear     |
  R2     | Рабочий       | Labor  |    10     |    50         | ROLE2   | Linear     | 75
  R3     | Кран          | NonLab |     1     |   300         |         | Flat       |
```

---

### @ROLES
Ресурсные роли (маппинг: XER в ROLE).

```
@ROLES
# role_id | name
  ROLE1   | Инженер-проектировщик
  ROLE2   | Разнорабочий
```

---

### @ASSIGNMENTS
Назначения ресурсов и ролей (маппинг: XER в TASKRSRC + TASKROLE).

```
@ASSIGNMENTS
# activity | resource | role    | units | budget | actual_qty | rate_type
  C        |   R2     | ROLE2   |   4   | 32     | 16         | Standard
  D        |   R2     |         |   6   | 72     | 0          | Standard
  D        |   R3     |         |   1   | 12     | 0          | Standard
  E        |   R2     | ROLE2   |   8   | 120    | 0          | Standard
  E        |   R3     |         |   1   | 15     | 0          | Standard
```

---

### @CALENDARS
Календари (маппинг: XER в CALENDAR + CALENDARTYPE/CLNDRTYPE).

```
@CALENDARS
# cal_id | name              | type     | default | std_hours
  CAL1   | Стандартный 5/8   | Global   | true    | 8
  CAL2   | 6-дневная неделя  | Project  | false   | 8

# Исключения для CAL1
@CALENDAR_EXCEPTIONS CAL1
# date       | working | hours
 2024-01-07  | false   |
 2024-01-08  | true    | 4

# Стандартная неделя для CAL1
@CALENDAR_WEEK CAL1
# day     | working | hours
 Mon      | true    | 8
 Tue      | true    | 8
 Wed      | true    | 8
 Thu      | true    | 8
 Fri      | true    | 8
 Sat      | false   |
 Sun      | false   |
```

---

### @ACTIVITY_CODES
Коды работ (маппинг: XER в ACTVTYPE + ACTVCODE + TASKACTVCODE).

```
@ACTIVITY_CODES
# Определения
@ACTVTYPE
# code_id | name          | length | value_type
  CT1     | Ответственный | 20     | String
  CT2     | Фаза          | 10     | Code

# Значения
@ACTVCODE CT1
# value
  Иванов
  Петров

@ACTVCODE CT2
# value
  Фундамент
  Отделка

# Привязка к работам
@TASKACTVCODE
# activity | code_id | value
  A        | CT1     | Иванов
  B        | CT1     | Петров
  D        | CT2     | Фундамент
```

---

### @UDF_TYPES
Определения пользовательских полей (маппинг: XER в UDFTYPE).

```
@UDF_TYPES
# udf_id | name          | table     | data_type | length | precompute
  U1     | Бюджет руб    | TASK      | Number    | 15     | false
  U2     | Заказчик      | TASK      | Text      | 100    | false
  U3     | Дата контракта| TASK      | Date      | 10     | false
  U4     | Статус контр. | PROJECT   | Code      | 20     | false
```

---

### @UDF_VALUES
Значения UDF (маппинг: XER в TASKUDF + PROJUDF).

```
@UDF_VALUES
# table   | row_id | udf_id | value
  TASK    | A      | U1     | 500000
  TASK    | A      | U2     | ООО "Вектор"
  TASK    | D      | U1     | 1200000
  TASK    | D      | U3     | 2024-01-20
  PROJECT | PROJ-001 | U4   | В работе
```

---

### @NOTES
Примечания (маппинг: XER в TASKNOTE + PROJNOTE).

```
@NOTES
# table   | row_id | note_type | text
  TASK    | C      | General   | Необходимо согласовать с подрядчиком
  PROJECT | PROJ-001 | General | Проект согласован 01.01.2024
```

---

### @STEPS
Шаги работ (маппинг: XER в TASKSTEP + TASKSTEPDEP).

```
@STEPS
# activity | step_name        | weight | completed
  D        | Армирование       | 40     | true
  D        | Бетонирование     | 40     | false
  D        | Опалубка          | 20     | false
```

---

### @EXPENSES
Статьи расходов (маппинг: XER в COST).

```
@EXPENSES
# exp_id | activity | category | cost    | date       | auto_compute
  E1     | D        | Материалы | 800000  | 2024-02-01 | false
  E2     | E        | Механизм  | 300000  |            | true
```

---

### @BASELINES
Базовые планы (маппинг: XER в BASETYPE + поля bl_* в TASK).

```
@BASELINES
# baseline_id | name       | type
  BL1         | Plan v1.0  | User

@BASELINE_VALUES BL1
# activity | bl_duration | bl_start | bl_finish | bl_cost | bl_units
  A        | 10          | 2024-01-01 | 2024-01-11 | 1000  | 20
  B        | 5           | 2024-01-11 | 2024-01-16 | 500   | 40
```

---

### @LEVELING
Параметры выравнивания (маппинг: внутренние).

```
@LEVELING
level_within_float_only = true
preserve_early_dates    = false
max_overload_pct        = 100
priority_field          = total_float
```