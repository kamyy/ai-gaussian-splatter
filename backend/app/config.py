from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="")

    database_url: str

    clerk_jwks_url: str
    clerk_issuer: str

    uploads_bucket: str
    splats_bucket: str
    aws_region: str = "us-west-2"

    worker_ami_id: str
    worker_instance_type: str = "g5.xlarge"
    worker_subnet_id: str
    worker_security_group_id: str
    worker_instance_profile_arn: str

    # Rate limiting (plan §5) — deliberately simple config knobs, not
    # architecture; tune based on real usage once deployed.
    rate_limit_ip_per_hour: int = 5
    rate_limit_user_per_day: int = 3
    global_max_jobs_per_day: int = 20
    min_photos_per_object: int = 20

    backend_public_url: str


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()  # type: ignore[call-arg]
    return _settings
