"""
AI Transcription Subsystem:
1. Real platform timed captions via yt-dlp (fastest & exact when creator/auto captions exist).
2. Faster-Whisper STT on downloaded audio when captions are absent.
3. Grounded extractive summarizer over real transcript/metadata (test mock only when MEDIASPHERE_TEST_MOCK=true).
"""
from __future__ import annotations

import os
from typing import Any

from .extractor import extract_platform_subtitles, is_test_mock_enabled
from .processor import parse_timestamp

try:
    from faster_whisper import WhisperModel  # type: ignore
    HAS_WHISPER = True
except ImportError:
    HAS_WHISPER = False

_model: Any = None


def _get_model():
    global _model
    if _model is None and HAS_WHISPER and not is_test_mock_enabled():
        try:
            model_size = os.environ.get("WHISPER_MODEL_SIZE", "base")
            _model = WhisperModel(model_size, device="cpu", compute_type="int8")
        except Exception:
            _model = False
    return _model if _model else None


def _fmt_srt(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{min(999, ms):03d}"


def _cues_to_srt(cues: list[dict[str, Any]]) -> str:
    lines = []
    for idx, c in enumerate(cues, 1):
        lines.append(f"{idx}\n{_fmt_srt(c['start'])} --> {_fmt_srt(c['end'])}\n{c['text'].strip()}\n")
    return "\n".join(lines)


def transcribe_audio(
    audio_path: str,
    job_id: str = "",
    source_url: str = "",
    meta: dict[str, Any] | None = None,
    trim_start: str | None = None,
    trim_end: str | None = None,
) -> dict[str, Any]:
    """Produce real transcript, .SRT, and summary from captions or Faster-Whisper STT."""
    if is_test_mock_enabled():
        txt = f"Test transcript fixture for job {job_id}."
        srt = f"1\n00:00:00,000 --> 00:00:05,000\n{txt}\n"
        return {"transcript": txt, "srt": srt, "summary": f"Summary: {txt}", "segments": []}

    cues: list[dict[str, Any]] = []
    if source_url:
        cues = extract_platform_subtitles(source_url)
        if cues and (trim_start or trim_end):
            lo = parse_timestamp(trim_start) if trim_start else 0.0
            hi = parse_timestamp(trim_end) if trim_end else float("inf")
            sliced = [
                {
                    "start": max(0.0, c["start"] - lo),
                    "end": max(0.2, min(hi, c["end"]) - lo),
                    "text": c["text"],
                }
                for c in cues
                if c["end"] >= lo and c["start"] <= hi
            ]
            if sliced:
                cues = sliced

    if not cues:
        model = _get_model()
        if model is not None and os.path.exists(audio_path):
            try:
                segments, _ = model.transcribe(audio_path, beam_size=5)
                for s in segments:
                    if s.text and s.text.strip():
                        cues.append({"start": float(s.start), "end": float(s.end), "text": s.text.strip()})
            except Exception:
                pass

    title = (meta or {}).get("title") or "Media"
    creator = (meta or {}).get("creator") or "Creator"
    desc = (meta or {}).get("description") or ""

    if cues:
        transcript = " ".join(c["text"] for c in cues)
        srt = _cues_to_srt(cues)
        summary = _summarize(transcript, title, creator)
        return {"transcript": transcript, "srt": srt, "summary": summary, "segments": cues}

    fallback_text = desc[:1500].strip() if desc else None
    summary = (
        f'"{title}" by {creator}. '
        + (fallback_text[:300] if fallback_text else "No spoken caption track detected on source media.")
    )
    srt = (
        _cues_to_srt([{"start": 0.0, "end": 10.0, "text": fallback_text[:200]}])
        if fallback_text
        else None
    )
    return {"transcript": fallback_text, "srt": srt, "summary": summary, "segments": []}


def _summarize(text: str, title: str, creator: str) -> str:
    sentences = [s.strip() for s in text.replace("?", ".").replace("!", ".").split(".") if len(s.strip()) >= 20]
    if not sentences:
        return f'"{title}" ({creator}): {text[:320]}'
    picks = [sentences[0]]
    if len(sentences) > 2:
        picks.append(sentences[len(sentences) // 2])
    if len(sentences) > 1:
        picks.append(sentences[-1])
    return f'{title} ({creator}): {". ".join(picks)}.'
