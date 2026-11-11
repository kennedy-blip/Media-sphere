"""Pydantic v2 validation schemas."""
from __future__ import annotations

import re
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator, model_validator

TIMESTAMP_RE = re.compile(r"^(?:\d{1,2}:)?[0-5]?\d:[0-5]\d(?:\.\d{1,3})?$")
ALLOWED_RESOLUTIONS = {"1080p", "720p", "480p", "360p", "2160p", "4k", "best", "audio"}


def _parse_ts(ts: str) -> float:
    parts = ts.strip().split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return float(parts[0])


def _validate_resolution(v: str) -> str:
    low = v.strip().lower()
    if low not in ALLOWED_RESOLUTIONS:
        raise ValueError(f"Resolution must be one of {sorted(ALLOWED_RESOLUTIONS)}")
    return "2160p" if low == "4k" else low


def _validate_timestamp(v: Optional[str]) -> Optional[str]:
    if v is None:
        return None
    s = v.strip()
    if not s:
        return None
    if not TIMESTAMP_RE.match(s):
        raise ValueError("Timestamp must be MM:SS or HH:MM:SS (e.g. 01:15 or 00:02:30)")
    return s


class JobStatus(str, Enum):
    queued = "queued"
    extracting = "extracting"
    trimming = "trimming"
    transcribing = "transcribing"
    ready = "ready"
    failed = "failed"
    cancelled = "cancelled"


class MediaFormat(str, Enum):
    mp4 = "mp4"
    webm = "webm"
    mp3 = "mp3"
    wav = "wav"


class ExtractRequest(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=20, description="URLs to extract (max 20)")

    @field_validator("urls")
    @classmethod
    def urls_not_empty(cls, v: list[str]) -> list[str]:
        cleaned = [u.strip() for u in v if u and u.strip()]
        if not cleaned:
            raise ValueError("At least one non-empty URL is required")
        return cleaned


class JobCreateRequest(BaseModel):
    url: str = Field(..., description="Sanitized source URL")
    resolution: str = Field(default="1080p", description="2160p | 1080p | 720p | 480p | 360p | best | audio")
    format: MediaFormat = Field(default=MediaFormat.mp4)
    trim_start: Optional[str] = Field(default=None, description="MM:SS or HH:MM:SS")
    trim_end: Optional[str] = Field(default=None, description="MM:SS or HH:MM:SS")
    generate_subtitles: bool = False
    generate_summary: bool = False

    @field_validator("resolution")
    @classmethod
    def valid_resolution(cls, v: str) -> str:
        return _validate_resolution(v)

    @field_validator("trim_start", "trim_end")
    @classmethod
    def valid_timestamp(cls, v: Optional[str]) -> Optional[str]:
        return _validate_timestamp(v)

    @model_validator(mode="after")
    def valid_trim_window(self) -> "JobCreateRequest":
        if self.trim_start and self.trim_end:
            if _parse_ts(self.trim_end) <= _parse_ts(self.trim_start):
                raise ValueError("trim_end must be greater than trim_start")
        return self


class BatchJobRequest(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=20)
    resolution: str = "1080p"
    format: MediaFormat = MediaFormat.mp4
    trim_start: Optional[str] = None
    trim_end: Optional[str] = None
    generate_subtitles: bool = False
    generate_summary: bool = False

    @field_validator("urls")
    @classmethod
    def urls_not_empty(cls, v: list[str]) -> list[str]:
        cleaned = [u.strip() for u in v if u and u.strip()]
        if not cleaned:
            raise ValueError("At least one non-empty URL is required")
        return cleaned

    @field_validator("resolution")
    @classmethod
    def valid_resolution(cls, v: str) -> str:
        return _validate_resolution(v)

    @field_validator("trim_start", "trim_end")
    @classmethod
    def valid_timestamp(cls, v: Optional[str]) -> Optional[str]:
        return _validate_timestamp(v)

    @model_validator(mode="after")
    def valid_trim_window(self) -> "BatchJobRequest":
        if self.trim_start and self.trim_end:
            if _parse_ts(self.trim_end) <= _parse_ts(self.trim_start):
                raise ValueError("trim_end must be greater than trim_start")
        return self


class JobResponse(BaseModel):
    id: str
    url: str
    sanitized_url: str
    platform: str
    title: str
    status: JobStatus
    progress: float
    resolution: str
    format: str
    trim_start: Optional[str] = None
    trim_end: Optional[str] = None
    speed_mbps: float = 0.0
    eta_seconds: Optional[int] = None
    error: Optional[str] = None
    created_at: str
    updated_at: str
    thumbnail: Optional[str] = None
    creator: Optional[str] = None
    duration: Optional[int] = None
    file_size: Optional[int] = None
    transcript: Optional[str] = None
    summary: Optional[str] = None
    srt: Optional[str] = None
    download_url: Optional[str] = None


class ExtractPreview(BaseModel):
    url: str
    sanitized_url: str
    platform: str
    valid: bool
    error: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    creator: Optional[str] = None
    avatar: Optional[str] = None
    thumbnail: Optional[str] = None
    views: Optional[int] = None
    likes: Optional[int] = None
    upload_date: Optional[str] = None
    tags: list[str] = []
    duration: Optional[int] = None
    formats: list[dict] = []
