"""Offline regression tests for outbound DNS, redirects and yt-dlp egress."""
import os
import socket
import sys
import threading
import tempfile
from pathlib import Path
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from app.outbound_security import GuardedYoutubeDL, public_connection, validate_url
from app.sanitizer import is_blocked_ip
from app.processor import convert_media


class OutboundSecurityTests(unittest.TestCase):
    def test_literals_and_schemes(self):
        for url in ("http://127.0.0.1/", "http://100.64.0.1/", "http://[::ffff:127.0.0.1]/", "http://localhost./", "http://metadata.google.internal/", "file:///etc/passwd", "https://user@youtube.com/"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_url(url)
        for ip in ("224.0.0.1", "198.18.0.1", "192.88.99.1", "2001:db8::1", "::8.8.8.8"):
            self.assertTrue(is_blocked_ip(ip), ip)
        for ip in ("8.8.8.8", "2001:4860:4860::8888"):
            self.assertFalse(is_blocked_ip(ip), ip)

    def test_mixed_dns_answers_are_rejected_before_connect(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80)),
                   (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]
        with patch("socket.getaddrinfo", return_value=answers), patch("socket.socket") as sock:
            with self.assertRaises(OSError):
                public_connection(("public.example", 80))
            sock.assert_not_called()

    def test_dns_connection_uses_validated_sockaddr(self):
        answers = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 80))]
        with patch("socket.getaddrinfo", return_value=answers), patch("socket.socket") as factory:
            public_connection(("public.example", 80), timeout=2)
            factory.return_value.connect.assert_called_once_with(("8.8.8.8", 80))

    def test_redirect_to_private_address_never_reaches_target(self):
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/secret")
                self.end_headers()
            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            # Only the first, public-named hop is mapped to the fixture server.
            def fixture_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
                self.assertEqual(address[0], "public.example")
                return socket.create_connection(("127.0.0.1", server.server_port), timeout)
            with patch("app.outbound_security.public_connection", fixture_connection):
                with GuardedYoutubeDL({"quiet": True}) as ydl:
                    with self.assertRaises(Exception):
                        ydl.urlopen(f"http://public.example:{server.server_port}/start")
            self.assertEqual(hits, ["/start"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_ffmpeg_refuses_local_playlist_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            playlist = Path(directory) / "media.mp4"
            playlist.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:9/secret\n#EXT-X-ENDLIST\n")
            self.assertFalse(convert_media(str(playlist), str(Path(directory) / "output.mp3"), "mp3"))

    def test_external_downloads_and_proxies_are_disabled(self):
        with GuardedYoutubeDL({"quiet": True, "proxy": "http://example.com:80"}) as ydl:
            self.assertNotIn("http", ydl.proxies)
            self.assertNotIn("https", ydl.proxies)
            self.assertEqual(len(ydl._request_director.handlers), 1)
            for info in ({"url": "https://example.com/list.m3u8", "protocol": "m3u8"},
                         {"url": "https://example.com/", "requested_formats": [{"url": "https://example.com/"}]}):
                with self.assertRaises(ValueError):
                    ydl.process_info(info)


if __name__ == "__main__":
    unittest.main()
