from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import model_validator
from sqlalchemy.engine import URL

PROJECT_ROOT = Path(__file__).resolve().parents[3] if len(Path(__file__).resolve().parents) > 3 else Path("/app")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SAFENET_", extra="ignore")
    database_url: str = "sqlite:///./runtime/safenet.db"
    database_host: str = ""
    database_user: str = "safenet"
    database_password: str = ""
    database_name: str = "safenet"
    database_port: int = 5432
    redis_url: str = "redis://localhost:6379/0"
    queue: str = "local"
    admin_code: str = ""
    local_admin: bool = False
    secure_cookie: bool = False
    allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8100,http://127.0.0.1:8100"
    retention_days: int = 30
    max_tasks: int = 100
    session_hours: int = 8
    scheduler_enabled: bool = True
    media_enabled: bool = True
    media_root: str = "runtime/media"
    whisper_model: str = str(PROJECT_ROOT / "data/models/faster-whisper-small")
    vision_model: str = "qwen3-vl:2b-instruct"
    vision_url: str = "http://127.0.0.1:11434"
    media_timeout_seconds: int = 300

    @model_validator(mode="after")
    def configure_database(self):
        if self.database_host:
            self.database_url = URL.create("postgresql+psycopg", username=self.database_user, password=self.database_password, host=self.database_host, port=self.database_port, database=self.database_name).render_as_string(hide_password=False)
        return self

    @property
    def origins(self):
        return [value.strip().rstrip("/") for value in self.allowed_origins.split(",") if value.strip()]


settings = Settings()
if settings.database_url.startswith("sqlite:///./runtime/"):
    Path("runtime").mkdir(parents=True, exist_ok=True)
