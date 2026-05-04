from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import p6matrix

app = FastAPI(title="P6Matrix API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ScheduleRequest(BaseModel):
    pxp_text: str
    level_within_float_only: bool = True
    max_overload_pct: float = 100.0

class LevelRequest(BaseModel):
    pxp_text: str
    level_within_float_only: bool = True
    max_overload_pct: float = 100.0

@app.get("/")
def health():
    return {"status": "ok", "service": "p6matrix-backend"}

@app.post("/upload")
async def upload(file: UploadFile = File(...), level: bool = False):
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    contents = await file.read()
    try:
        text = contents.decode("utf-8")
    except UnicodeDecodeError:
        text = contents.decode("utf-8", errors="replace")
    
    xer_warnings: list[str] = []
    
    if file.filename.lower().endswith(".xer"):
        try:
            from xer_converter import convert_xer_to_pxp
            pxp_text, xer_warnings = convert_xer_to_pxp(text)
            text = pxp_text
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="XER converter not available. Please upload .pxp file.")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"XER conversion failed: {str(e)}")
    
    try:
        if level:
            result = p6matrix.level(text, level_within_float_only=True, max_overload_pct=100.0)
        else:
            result = p6matrix.schedule(text, level_within_float_only=True, max_overload_pct=100.0)
        
        if xer_warnings:
            result["warnings"] = xer_warnings + result.get("warnings", [])
        
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/schedule")
async def schedule_endpoint(req: ScheduleRequest):
    try:
        result = p6matrix.schedule(req.pxp_text, req.level_within_float_only, req.max_overload_pct)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/level")
async def level_endpoint(req: LevelRequest):
    try:
        result = p6matrix.level(req.pxp_text, req.level_within_float_only, req.max_overload_pct)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
