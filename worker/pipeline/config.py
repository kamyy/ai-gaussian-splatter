from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Env vars set in the EC2 launch UserData per plan §4."""

    model_config = SettingsConfigDict(env_prefix="")

    job_id: str
    object_id: str
    callback_token: str
    backend_url: str
    uploads_bucket: str
    splats_bucket: str

    # Reduced default per plan's Context: single-object-against-plain-background
    # scenes converge well below the paper's 30k default.
    training_iterations: int = 10_000

    # "Fast test mode" per plan §8 — tiny photo set, ~50 iterations, for a cheap
    # on-demand smoke test of the plumbing without full-quality training cost.
    fast_test_mode: bool = False

    local_workdir: str = "/tmp/job"


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # populated from env vars
