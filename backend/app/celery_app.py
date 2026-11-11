"""Celery application entrypoint for distributed MediaSphere workers."""
from __future__ import annotations

import os
from celery import Celery  # type: ignore

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "mediasphere",
    broker=REDIS_URL,
    backend=REDIS_URL,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
)


@celery_app.task(name="mediasphere.process_job")
def process_job(job_id: str) -> dict | None:
    from .jobs import run_job
    return run_job(job_id)
