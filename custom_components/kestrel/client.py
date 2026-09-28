"""Async HTTP client for the Kestrel Scrypted plugin."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

import aiohttp
from homeassistant.exceptions import HomeAssistantError


class KestrelApiError(HomeAssistantError):
    """A safe, user-facing Kestrel API failure."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = (
            "invalid_auth" if status == 401 else "not_found" if status == 404 else "api_error"
        )


class KestrelClient:
    """Talk to the authenticated plugin HTTP API."""

    def __init__(self, session: aiohttp.ClientSession, base_url: str, api_key: str) -> None:
        self.session = session
        self.base_url = base_url.rstrip("/")
        self._headers = {"X-Kestrel-Key": api_key}

    @property
    def headers(self) -> dict[str, str]:
        """Return the plugin authorization header for media streaming."""
        return self._headers

    def media_url(self, kind: str, media_id: str) -> str:
        """Return the plugin URL for one allow-listed media resource."""
        if kind not in {"snap", "crop", "clip", "audio", "species", "camera"}:
            raise KestrelApiError("Unsupported media type")
        return f"{self.base_url}/media/{kind}/{quote(str(media_id), safe='')}"

    async def async_request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any | None = None,
        timeout: float = 15,
    ) -> Any:
        """Make a JSON request without exposing the plugin key in errors."""
        url = f"{self.base_url}/{path.lstrip('/')}"
        request_timeout = aiohttp.ClientTimeout(total=timeout)
        try:
            async with self.session.request(
                method,
                url,
                params=params,
                json=json,
                headers=self._headers,
                timeout=request_timeout,
                allow_redirects=False,
            ) as response:
                if response.status >= 400:
                    raise KestrelApiError(
                        f"Kestrel returned HTTP {response.status}", status=response.status
                    )
                if response.status == 204:
                    return None
                if "json" not in response.headers.get("Content-Type", "").lower():
                    return await response.read()
                return await response.json(content_type=None)
        except KestrelApiError:
            raise
        except (aiohttp.ClientError, TimeoutError) as err:
            raise KestrelApiError("Could not reach the Kestrel plugin") from err

    async def async_get_cameras(self) -> list[dict[str, Any]]:
        """Return the plugin's current camera list."""
        result = await self.async_request("GET", "cameras")
        if isinstance(result, list):
            return [item for item in result if isinstance(item, dict)]
        if isinstance(result, dict):
            items = result.get("items", result.get("cameras", []))
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
        raise KestrelApiError("Kestrel returned an invalid camera list")

    async def async_get_media_bytes(self, kind: str, media_id: str) -> bytes | None:
        """Fetch a still image for an HA image entity."""
        try:
            async with self.session.get(
                self.media_url(kind, media_id),
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=20),
                allow_redirects=False,
            ) as response:
                if response.status == 404:
                    return None
                if response.status not in (200, 206):
                    raise KestrelApiError(
                        f"Kestrel media request returned HTTP {response.status}",
                        status=response.status,
                    )
                return await response.read()
        except KestrelApiError:
            raise
        except (aiohttp.ClientError, TimeoutError) as err:
            raise KestrelApiError("Could not load the latest Kestrel image") from err
