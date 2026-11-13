"""Outbound HTTP protection for yt-dlp. No proxies or external downloaders.

The pinned urllib handler validates every redirect and connects directly to a
validated DNS answer, preserving the original hostname for TLS and Host headers.
"""
from __future__ import annotations

import functools
import http.client
import socket
import urllib.request
from urllib.parse import urlsplit

from yt_dlp import YoutubeDL
from yt_dlp.networking._urllib import HTTPHandler, RedirectHandler, UrllibRH
from yt_dlp.utils import determine_protocol

from .sanitizer import is_blocked_ip


def validate_url(url: str) -> None:
    try:
        parsed = urlsplit(url)
        host = parsed.hostname
        port = parsed.port  # force validation of malformed ports
        del port
    except ValueError as exc:
        raise ValueError("Invalid outbound URL") from exc
    if parsed.scheme.lower() not in ("http", "https") or not host or parsed.username is not None or parsed.password is not None or is_blocked_ip(host):
        raise ValueError("Blocked outbound URL")


def public_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
    host, port = address
    if is_blocked_ip(host):
        raise OSError("Blocked outbound host")
    answers = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    if not answers or any(is_blocked_ip(item[4][0]) for item in answers):
        raise OSError("Blocked outbound DNS answer")
    last_error = None
    for family, kind, proto, _, sockaddr in answers:
        if source_address and ((family == socket.AF_INET6) != (":" in source_address[0])):
            continue
        sock = socket.socket(family, kind, proto)
        try:
            if timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            last_error = exc
            sock.close()
    raise last_error or OSError("No suitable public address")


def _make_connection(base, source_address, *args, **kwargs):
    conn = base(*args, **kwargs)
    conn._create_connection = public_connection
    if source_address:
        conn.source_address = (source_address, 0)
    return conn


class GuardedHTTPHandler(HTTPHandler):
    def http_open(self, req):
        validate_url(req.full_url)
        return self.do_open(functools.partial(_make_connection, http.client.HTTPConnection, self._source_address), req)

    def https_open(self, req):
        validate_url(req.full_url)
        return self.do_open(functools.partial(_make_connection, http.client.HTTPSConnection, self._source_address), req, context=self._context)


class GuardedRedirectHandler(RedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        old = urlsplit(req.full_url)
        new = urlsplit(newurl)
        if (old.scheme, old.hostname, old.port) != (new.scheme, new.hostname, new.port):
            redirected.remove_header("Authorization")
        return redirected


class GuardedUrllibRH(UrllibRH):
    _SUPPORTED_URL_SCHEMES = ("http", "https")
    _SUPPORTED_PROXY_SCHEMES = ()

    def _get_proxies(self, request):
        return {}

    def _send(self, request):
        validate_url(request.url)
        if any(key.lower() in ("host", "proxy-authorization") for key in request.headers):
            raise ValueError("Unsafe outbound request headers")
        return super()._send(request)

    def _create_instance(self, proxies, cookiejar, legacy_ssl_support=None):
        opener = urllib.request.OpenerDirector()
        for handler in (
            GuardedHTTPHandler(debuglevel=int(bool(self.verbose)), context=self._make_sslcontext(legacy_ssl_support=legacy_ssl_support), source_address=self.source_address),
            urllib.request.HTTPCookieProcessor(cookiejar),
            urllib.request.HTTPDefaultErrorHandler(),
            urllib.request.HTTPErrorProcessor(),
            GuardedRedirectHandler(),
        ):
            opener.add_handler(handler)
        opener.addheaders = []
        return opener


class GuardedYoutubeDL(YoutubeDL):
    def __init__(self, params=None, *args, **kwargs):
        # Proxies resolve targets elsewhere and cannot provide DNS pinning here.
        super().__init__({**(params or {}), "proxy": ""}, *args, **kwargs)

    def build_request_director(self, handlers, preferences=None):
        return super().build_request_director([GuardedUrllibRH], preferences=None)

    def process_info(self, info_dict):
        if not self.params.get("skip_download"):
            # Other downloaders may invoke FFmpeg or bypass the guarded transport.
            # Restrict downloads to one direct HTTP stream, without FFmpeg merging.
            if info_dict.get("requested_formats") or info_dict.get("section_start") or info_dict.get("section_end"):
                raise ValueError("Only single direct HTTP streams are supported")
            if determine_protocol(info_dict) not in ("http", "https"):
                raise ValueError("Only direct HTTP streams are supported")
            validate_url(info_dict.get("url", ""))
        return super().process_info(info_dict)
