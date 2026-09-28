"""Config and options flow for Kestrel."""

from __future__ import annotations

import hashlib
from typing import Any

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
    CONF_API_KEY,
    CONF_POLL_TIMEOUT,
    CONF_URL,
    DEFAULT_POLL_TIMEOUT,
    DEFAULT_URL,
    DOMAIN,
    MAX_POLL_TIMEOUT,
    MIN_POLL_TIMEOUT,
)


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
    """Configure the plugin's long-poll wait duration."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_POLL_TIMEOUT,
                        default=self._config_entry.options.get(
                            CONF_POLL_TIMEOUT, DEFAULT_POLL_TIMEOUT
                        ),
                    ): vol.All(
                        vol.Coerce(int),
                        vol.Range(min=MIN_POLL_TIMEOUT, max=MAX_POLL_TIMEOUT),
                    )
                }
            ),
        )
