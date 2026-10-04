"""Config and options flow for Kestrel."""

from __future__ import annotations

import hashlib
from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlowWithReload,
)
from homeassistant.core import callback
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import KestrelApiError, KestrelClient
from .const import (
    AUDIO_KEY_HEADER,
    CONF_API_KEY,
    CONF_AUDIO_BACKFILL_DAYS,
    CONF_AUDIO_KEY,
    CONF_AUDIO_URL,
    CONF_POLL_TIMEOUT,
    CONF_URL,
    CONF_XENO_CANTO_KEY,
    DEFAULT_AUDIO_BACKFILL_DAYS,
    DEFAULT_POLL_TIMEOUT,
    DEFAULT_URL,
    DOMAIN,
    MAX_AUDIO_BACKFILL_DAYS,
    MAX_POLL_TIMEOUT,
    MIN_POLL_TIMEOUT,
)
from .reference_sounds import check_xeno_canto_key


class KestrelConfigFlow(ConfigFlow, domain=DOMAIN):
    """Connect Home Assistant to one Kestrel plugin instance."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = str(user_input[CONF_URL]).strip().rstrip("/")
            api_key = str(user_input[CONF_API_KEY]).strip()
            if url.startswith(("http://", "https://")) and api_key:
                await self.async_set_unique_id(hashlib.sha256(api_key.encode("utf-8")).hexdigest())
                self._abort_if_unique_id_configured()
                client = KestrelClient(async_get_clientsession(self.hass), url, api_key)
                try:
                    await client.async_get_cameras()
                except KestrelApiError as err:
                    errors["base"] = "invalid_auth" if err.status == 401 else "cannot_connect"
                else:
                    return self.async_create_entry(
                        title="Kestrel",
                        data={CONF_URL: url, CONF_API_KEY: api_key},
                    )
            else:
                errors["base"] = "cannot_connect"

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_URL, default=DEFAULT_URL): selector.TextSelector(
                        selector.TextSelectorConfig(type=selector.TextSelectorType.URL)
                    ),
                    vol.Required(CONF_API_KEY): selector.TextSelector(
                        selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                    ),
                }
            ),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> KestrelOptionsFlow:
        """Return the reload-aware options flow."""
        return KestrelOptionsFlow(config_entry)


class KestrelOptionsFlow(OptionsFlowWithReload):
    """Configure the plugin's event wait, the optional bird-call preview service and the optional Xeno-canto key."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            audio_url = str(user_input.get(CONF_AUDIO_URL) or "").strip().rstrip("/")
            audio_key = str(user_input.get(CONF_AUDIO_KEY) or "").strip()
            xeno_canto_key = str(user_input.get(CONF_XENO_CANTO_KEY) or "").strip()
            if audio_url or audio_key:
                errors = await self._async_check_audio(audio_url, audio_key)
            if xeno_canto_key and (problem := await check_xeno_canto_key(self.hass, xeno_canto_key)):
                errors[CONF_XENO_CANTO_KEY] = f"xeno_canto_{problem}"
            if not errors:
                return self.async_create_entry(
                    title="",
                    data={
                        CONF_POLL_TIMEOUT: user_input[CONF_POLL_TIMEOUT],
                        CONF_AUDIO_URL: audio_url,
                        CONF_AUDIO_KEY: audio_key,
                        CONF_AUDIO_BACKFILL_DAYS: user_input.get(
                            CONF_AUDIO_BACKFILL_DAYS, DEFAULT_AUDIO_BACKFILL_DAYS
                        ),
                        CONF_XENO_CANTO_KEY: xeno_canto_key,
                    },
                )

        current = user_input or self._config_entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_POLL_TIMEOUT,
                        default=current.get(CONF_POLL_TIMEOUT, DEFAULT_POLL_TIMEOUT),
                    ): vol.All(
                        vol.Coerce(int),
                        vol.Range(min=MIN_POLL_TIMEOUT, max=MAX_POLL_TIMEOUT),
                    ),
                    vol.Optional(
                        CONF_AUDIO_URL,
                        description={"suggested_value": current.get(CONF_AUDIO_URL, "")},
                    ): selector.TextSelector(
                        selector.TextSelectorConfig(type=selector.TextSelectorType.URL)
                    ),
                    vol.Optional(
                        CONF_AUDIO_KEY,
                        description={"suggested_value": current.get(CONF_AUDIO_KEY, "")},
                    ): selector.TextSelector(
                        selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                    ),
                    vol.Optional(
                        CONF_AUDIO_BACKFILL_DAYS,
                        default=current.get(CONF_AUDIO_BACKFILL_DAYS, DEFAULT_AUDIO_BACKFILL_DAYS),
                    ): vol.All(
                        vol.Coerce(int),
                        vol.Range(min=0, max=MAX_AUDIO_BACKFILL_DAYS),
                    ),
                    vol.Optional(
                        CONF_XENO_CANTO_KEY,
                        description={"suggested_value": current.get(CONF_XENO_CANTO_KEY, "")},
                    ): selector.TextSelector(
                        selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                    ),
                }
            ),
            errors=errors,
        )

    async def _async_check_audio(self, url: str, key: str) -> dict[str, str]:
        """Check the audio service address and key; an empty dict means both are good."""
        if not url.startswith(("http://", "https://")) or not key:
            return {"base": "audio_incomplete"}
        session = async_get_clientsession(self.hass)
        timeout = aiohttp.ClientTimeout(total=8)
        try:
            async with session.get(f"{url}/healthz", timeout=timeout, allow_redirects=False) as health:
                if health.status != 200:
                    return {"base": "audio_cannot_connect"}
            async with session.get(
                f"{url}/v1/stats",
                headers={AUDIO_KEY_HEADER: key},
                timeout=timeout,
                allow_redirects=False,
            ) as stats:
                if stats.status in (401, 403):
                    return {"base": "audio_invalid_auth"}
                if stats.status != 200:
                    return {"base": "audio_cannot_connect"}
        except (aiohttp.ClientError, TimeoutError, OSError):
            return {"base": "audio_cannot_connect"}
        return {}
