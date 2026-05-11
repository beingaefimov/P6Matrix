""" Бэкенд делает ТОЛЬКО:
1. Парсинг .pxp / .xer - минимальные данные для клиента
2. Получение деталей одной задачи по id (lazy)
3. Сохранение .pxp (Download)
Весь CPM и выравнивание ресурсов - на клиенте (WebGPU) """

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
import p6matrix_parser as parser
import pathlib

SHARED_PXP_PATH = pathlib.Path(__file__).parent / "shared.pxp"

app = FastAPI(
    title="P6Matrix API",
    version="2.0.0",
    docs_url=None,   # Отключает Swagger UI (/docs)
    redoc_url=None   # Отключает ReDoc (/redoc)
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def health():
    return {"status": "ok", "service": "p6matrix-backend", "version": "2.0.0"}

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """ Принимает .pxp или .xer файл.
    Возвращает минимальные данные для расчёта расписания на клиенте:
      - activities: только поля нужные для CPM + отображения
      - relations: все связи (CSR строится на клиенте)
      - resources: id, name, max_units
      - assignments: activity_id, resource_id, units (для выравнивания)
      - pxp_text: исходный текст (для редактирования и скачивания)
      - project: мета
    Прочие поля задач (name, notes, UDF) включены в activities_full
    но не загружаются сразу - только при запросе /activity/{id}/detail """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")

    contents = await file.read()
    try:
        text = contents.decode("utf-8")
    except UnicodeDecodeError:
        text = contents.decode("utf-8", errors="replace")

    warnings: list[str] = []

    if file.filename.lower().endswith(".xer"):
        try:
            from xer_converter import convert_xer_to_pxp
            text, warnings = convert_xer_to_pxp(text)
        except ImportError:
            raise HTTPException(status_code=501, detail="XER converter not available")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"XER conversion failed: {str(e)}")

    try:
        result = parser.parse_minimal(text)
        result["warnings"] = warnings + result.get("warnings", [])
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/activity/{project_id}/{activity_id}/detail")
async def activity_detail(project_id: str, activity_id: str, pxp_text: str = ""):
    """ Ленивая загрузка деталей одной задачи при клике.
    Принимает pxp_text как query param (или через POST ниже) """
    raise HTTPException(status_code=501, detail="Use POST /activity/detail")

class ActivityDetailRequest(BaseModel):
    pxp_text: str
    activity_id: str

@app.post("/activity/detail")
async def activity_detail_post(req: ActivityDetailRequest):
    """ Lazy загрузка деталей задачи: name, notes, UDF, actual_start/finish,
    percent_complete, constraint_type/date и прочие поля формы.
    Вызывается только при клике на задачу в Ганте """
    try:
        detail = parser.parse_activity_detail(req.pxp_text, req.activity_id)
        if detail is None:
            raise HTTPException(status_code=404, detail=f"Activity '{req.activity_id}' not found")
        return detail
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class SaveRequest(BaseModel):
    pxp_text: str

@app.post("/save")
async def save_pxp(req: SaveRequest):
    """ Принимает текущий pxp_text (с изменёнными constraint_es после
    интерактивных перемещений на клиенте) и возвращает его обратно.
    Фактически просто валидирует что текст парсируется.
    Клиент сам скачивает через Blob URL """
    try:
        # Минимальная валидация
        parser.validate_pxp(req.pxp_text)
        return {"ok": True, "pxp_text": req.pxp_text}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

class ShareRequest(BaseModel):
    pxp_text: str

@app.post("/share")
async def share_project(req: ShareRequest):
    """ Сохраняет pxp_text в shared.pxp для MCP сервера """
    try:
        SHARED_PXP_PATH.write_text(req.pxp_text, encoding="utf-8")
        return {"ok": True, "path": str(SHARED_PXP_PATH)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/shared/status")
def shared_status():
    """ Проверяет наличие shared.pxp и его размер """
    if SHARED_PXP_PATH.exists():
        return {"exists": True, "size": SHARED_PXP_PATH.stat().st_size}
    return {"exists": False}
