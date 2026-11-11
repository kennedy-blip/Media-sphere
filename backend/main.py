"""MediaSphere FastAPI Gateway."""
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes import router, ws_router

app = FastAPI(
    title="MediaSphere API",
    description="All-in-one media extraction, processing & AI transcription gateway.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api/v1")
app.include_router(ws_router)


@app.get("/")
def root():
    return {"service": "MediaSphere API", "docs": "/docs", "health": "/api/v1/health"}
