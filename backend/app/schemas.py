"""Pydantic v2 validation schemas."""
from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


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
    def urls_not_empty(cls, v):
        cleaned = [u.strip() for u in v if u and u.strip()]
        if not cleaned:
            raise ValueError("At least one non-empty URL is required")
        return cleaned


class JobCreateRequest(BaseModel):
    url: str = Field(..., description="Sanitized source URL")
    resolution: str = Field(default="1080p", description="1080p | 720p | 480p | 360p | best | audio")
    format: MediaFormat = Field(default=MediaFormat.mp4)
    trim_start: Optional[str] = Field(default=None, description="HH:MM:SS")
    trim_end: Optional[str] = Field(default=None, description="HH:MM:SS")
    generate_subtitles: bool = False
    generate_summary: bool = False

    @field_validator("resolution")
    @classmethod
    def valid_resolution(cls, v):
        allowed = {"1080p", "720p", "480p", "360p", "2160p", "4k", "best", "audio"}
        if v.lower() not in allowed:
            raise ValueError(f"Resolution must be one of {allowed}")
        return v.lower()


class BatchJobRequest(BaseModel):
    urls: list[str] = Field(..., min_length=1, max_length=20)
    resolution: str = "1080p"
    format: MediaFormat = MediaFormat.mp4
    trim_start: Optional[str] = None
    trim_end: Optional[str] = None
    generate_subtitles: bool = False
    generate_summary: bool = False


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
