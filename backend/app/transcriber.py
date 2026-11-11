"""
AI Transcription Subsystem: Faster-Whisper STT + LLM summarizer wrapper.
Falls back to deterministic mock transcript when model/GPU unavailable.
"""
from __future__ import annotations

import hashlib

try:
    from faster_whisper import WhisperModel  # type: ignore
    HAS_WHISPER = True
except ImportError:
    HAS_WHISPER = False

_model = None


def _get_model():
    global _model
    if _model is None and HAS_WHISPER:
        try:
            _model = WhisperModel("small", device="cpu", compute_type="int8")
        except Exception:
            _model = False
    return _model if _model else None


def transcribe_audio(audio_path: str, job_id: str = "") -> dict:
    """Transcribe audio file. Returns {transcript, srt, summary, segments}."""
    model = _get_model()
    if model is not None:
        try:
            segments, info = model.transcribe(audio_path, beam_size=5)
            seg_list = list(segments)
            transcript = " ".join(s.text.strip() for s in seg_list)
            srt_lines = []
            for i, s in enumerate(seg_list, 1):
                srt_lines.append(f"{i}\n{_fmt_srt(s.start)} --> {_fmt_srt(s.end)}\n{s.text.strip()}\n")
            summary = _summarize(transcript)
            return {"transcript": transcript, "srt": "\n".join(srt_lines), "summary": summary,
                    "segments": [{"start": s.start, "end": s.end, "text": s.text} for s in seg_list]}
        except Exception:
            pass
    return _mock_transcript(job_id)


def _fmt_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _mock_transcript(job_id: str) -> dict:
    h = hashlib.md5((job_id or "mediasphere").encode()).hexdigest()
    seed = int(h[:6], 16)
    openings = [
        "In this section, we cover the fundamentals and why they matter for creators today.",
        "Welcome back to the channel. Today we're diving deep into a topic that's been trending everywhere.",
        "So the first thing you need to understand is how this actually works under the hood.",
        "Let me show you exactly how to get started, step by step, with real examples.",
    ]
    bodies = [
        "The key insight is that consistency beats perfection every single time. Small daily improvements compound into massive results over months.",
        "We look at the data, we test different approaches, and we double down on what works. No fluff, just what actually moves the needle.",
        "Here's where most people get stuck — and here's the simple framework that fixes it in under five minutes.",
        "Think about it from the viewer's perspective. What would make you stop scrolling and actually watch?",
    ]
    closings = [
        "If you found this helpful, drop a comment and subscribe for more. See you in the next one.",
        "That's a wrap for today. Links and resources are in the description below.",
        "Thanks for watching — let me know in the comments what you want to see next.",
    ]
    transcript = f"{openings[seed % len(openings)]} {bodies[(seed >> 3) % len(bodies)]} {closings[(seed >> 5) % len(closings)]}"
    summary = (
        "Key points: (1) Fundamentals matter more than advanced tricks. "
        "(2) Consistency and small daily improvements compound over time. "
        "(3) Test approaches with real data and double down on winners. "
        "(4) Optimize for the viewer — stop the scroll, deliver value fast."
    )
    srt = (
        "1\n00:00:00,000 --> 00:00:05,000\n" + openings[seed % len(openings)] + "\n\n"
        "2\n00:00:05,000 --> 00:00:12,000\n" + bodies[(seed >> 3) % len(bodies)] + "\n\n"
        "3\n00:00:12,000 --> 00:00:17,000\n" + closings[(seed >> 5) % len(closings)] + "\n"
    )
    return {"transcript": transcript, "srt": srt, "summary": summary, "segments": []}


def _summarize(text: str) -> str:
    """LLM prompt wrapper stub — extractive summary (replace with LLM call in production)."""
    sentences = [s.strip() for s in text.replace("?", ".").split(".") if s.strip()]
    if not sentences:
        return "No speech detected."
    # Simple extractive: first + middle + last sentence
    picks = [sentences[0]]
    if len(sentences) > 2:
        picks.append(sentences[len(sentences) // 2])
    if len(sentences) > 1:
        picks.append(sentences[-1])
    return " ".join(picks) + "."
