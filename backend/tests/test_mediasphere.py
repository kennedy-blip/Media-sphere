"""End-to-end & unit test suite for MediaSphere backend."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest

os.environ["MEDIASPHERE_TEST_MOCK"] = "true"
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from fastapi.testclient import TestClient  # type: ignore
from main import app  # type: ignore
from app.processor import convert_media, get_ffmpeg_bin, has_ffmpeg, trim_media  # type: ignore
from app.sanitizer import (  # type: ignore
    extract_youtube_video_id,
    parse_batch_input,
    strip_tracking_params,
    validate_url,
)


class SanitizerTests(unittest.TestCase):
    def test_strips_tracking_and_youtube_mix_parameters(self):
        cleaned = strip_tracking_params(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=shared&utm_source=x&si=abc123"
        )
        self.assertEqual(cleaned, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")

        # User's exact YouTube Radio/Mix URL
        mix_cleaned = strip_tracking_params("https://youtu.be/c8zq4kAn_O0?list=RDc8zq4kAn_O0")
        self.assertEqual(mix_cleaned, "https://youtu.be/c8zq4kAn_O0")
        self.assertEqual(extract_youtube_video_id(mix_cleaned), "c8zq4kAn_O0")

    def test_platforms_and_mobile_subdomains(self):
        cases = [
            ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"),
            ("https://youtu.be/c8zq4kAn_O0?list=RDc8zq4kAn_O0", "youtube"),
            ("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube"),
            ("https://youtu.be/dQw4w9WgXcQ?si=track", "youtube"),
            ("https://www.tiktok.com/@techbrand/video/734567?is_from_webapp=1", "tiktok"),
            ("https://vm.tiktok.com/ZM6abc/", "tiktok"),
            ("https://www.instagram.com/reel/C3xY9/?igsh=MZRl", "instagram"),
            ("https://mobile.x.com/user/status/123?s=20&t=xyz", "x"),
            ("https://old.reddit.com/r/python/comments/abc/test/", "reddit"),
            ("https://clips.twitch.tv/ExampleClip", "twitch"),
            ("https://vimeo.com/12345678", "vimeo"),
        ]
        for raw, expected in cases:
            res = validate_url(raw)
            self.assertTrue(res["valid"], f"Expected valid for {raw}: {res}")
            self.assertEqual(res["platform"], expected)

    def test_ssrf_and_protocol_blocks(self):
        blocked = [
            "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://127.0.0.1/admin",
            "https://10.0.0.5/secret",
            "https://172.16.5.4/internal",
            "https://192.168.1.1/router",
            "https://169.254.169.254/latest/meta-data/",
            "https://[::1]/loopback",
            "https://localhost/api",
            "https://evil.example.com/watch?v=1",
        ]
        for raw in blocked:
            res = validate_url(raw)
            self.assertFalse(res["valid"], f"Expected blocked for {raw}")

    def test_batch_parser(self):
        urls = parse_batch_input("https://youtu.be/1,\nhttps://youtu.be/2\n\nhttps://youtu.be/3")
        self.assertEqual(len(urls), 3)


class FfmpegProcessorTests(unittest.TestCase):
    def test_real_ffmpeg_trim_and_mp3_conversion(self):
        self.assertTrue(has_ffmpeg(), "Bundled imageio-ffmpeg binary must be available")
        ffmpeg = get_ffmpeg_bin()
        assert ffmpeg is not None
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "src.mp4")
            trimmed = os.path.join(tmp, "trimmed.mp4")
            mp3_out = os.path.join(tmp, "out.mp3")
            subprocess.run(
                [
                    ffmpeg, "-y",
                    "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=4",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
                    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac",
                    src,
                ],
                check=True,
                capture_output=True,
            )
            self.assertTrue(trim_media(src, trimmed, "00:01", "00:03", use_stream_copy=False))
            self.assertTrue(convert_media(trimmed, mp3_out, "mp3"))
            self.assertGreater(os.path.getsize(mp3_out), 1000)


class ApiGatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_health(self):
        r = self.client.get("/api/v1/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "ok")

    def test_extract_mixed_urls(self):
        r = self.client.post(
            "/api/v1/extract",
            json={
                "urls": [
                    "https://youtu.be/c8zq4kAn_O0?list=RDc8zq4kAn_O0",
                    "https://www.instagram.com/reel/C3xY9z0A1bC/?igsh=MZRlODBiNWFlZA==",
                    "https://evil.com/malware",
                ]
            },
        )
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["count"], 3)
        self.assertEqual(body["valid_count"], 2)
        self.assertEqual(body["previews"][0]["sanitized_url"], "https://youtu.be/c8zq4kAn_O0")
        self.assertFalse(body["previews"][2]["valid"])

    def test_trim_and_resolution_validation(self):
        bad_trim = self.client.post(
            "/api/v1/jobs",
            json={
                "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                "resolution": "1080p",
                "format": "mp4",
                "trim_start": "02:30",
                "trim_end": "01:15",
            },
        )
        self.assertEqual(bad_trim.status_code, 422)

        bad_res = self.client.post(
            "/api/v1/batch",
            json={
                "urls": ["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
                "resolution": "9999p",
            },
        )
        self.assertEqual(bad_res.status_code, 422)

    def test_full_job_lifecycle_and_audio_download(self):
        r = self.client.post(
            "/api/v1/jobs",
            json={
                "url": "https://youtu.be/c8zq4kAn_O0?list=RDc8zq4kAn_O0",
                "resolution": "audio",
                "format": "wav",
                "trim_start": "00:10",
                "trim_end": "00:40",
                "generate_subtitles": True,
                "generate_summary": False,
            },
        )
        self.assertEqual(r.status_code, 201)
        job_id = r.json()["id"]

        deadline = time.time() + 8.0
        final = None
        while time.time() < deadline:
            poll = self.client.get(f"/api/v1/jobs/{job_id}").json()
            if poll["status"] == "ready":
                final = poll
                break
            time.sleep(0.25)

        self.assertIsNotNone(final, "Job did not reach ready state in time")
        assert final is not None
        self.assertIsNotNone(final["transcript"])
        self.assertIsNotNone(final["srt"])
        self.assertIsNone(final["summary"])

        dl = self.client.get(f"/api/v1/jobs/{job_id}/download?download=true")
        self.assertEqual(dl.status_code, 200)
        self.assertEqual(dl.headers["content-type"], "audio/wav")
        self.assertIn("attachment;", dl.headers["content-disposition"])
        self.assertTrue(dl.content.startswith(b"RIFF"))


if __name__ == "__main__":
    unittest.main()
