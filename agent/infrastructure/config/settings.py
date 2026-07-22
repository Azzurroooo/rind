"""配置模块"""

from .settings_loader import (
    AppSettings,
    ensure_user_settings_template,
    load_settings,
    save_settings_patch,
    validate_settings,
)


_SETTINGS = load_settings()


class Config:
    SETTINGS: AppSettings = _SETTINGS
    SETTINGS_PATH = str(_SETTINGS.settings_path)
    SETTINGS_EXISTS = _SETTINGS.settings_exists
    OPENAI_API_KEY = _SETTINGS.api_key
    OPENAI_API_BASE = _SETTINGS.base_url
    OPENAI_USER_AGENT = _SETTINGS.user_agent
    DEFAULT_MODEL = _SETTINGS.model
    MODEL_REASONING_EFFORT = _SETTINGS.reasoning_effort
    TEMPERATURE = 0.7
    MAX_TOKENS = 2000

    @classmethod
    def validate(cls):
        validate_settings(cls.SETTINGS)
        return True

    @classmethod
    def ensure_user_settings_template(cls):
        return ensure_user_settings_template()

    @classmethod
    def reload(cls) -> AppSettings:
        settings = load_settings()
        cls.SETTINGS = settings
        cls.SETTINGS_PATH = str(settings.settings_path)
        cls.SETTINGS_EXISTS = settings.settings_exists
        cls.OPENAI_API_KEY = settings.api_key
        cls.OPENAI_API_BASE = settings.base_url
        cls.OPENAI_USER_AGENT = settings.user_agent
        cls.DEFAULT_MODEL = settings.model
        cls.MODEL_REASONING_EFFORT = settings.reasoning_effort
        return settings

    @classmethod
    def set_model(cls, model: str) -> AppSettings:
        clean = str(model or "").strip()
        if not clean:
            raise ValueError("Model name is required.")
        save_settings_patch({"model": clean})
        return cls.reload()
