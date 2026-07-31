"""Rate limiting & the global daily job cap (plan §5) — atomic Postgres
counters via INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING, so the
check-and-increment is race-free without a separate read-then-write step.

Deliberately explicit per-endpoint checks (not blanket middleware) — see
plan §5's rationale: cheap read endpoints shouldn't be throttled, and the
costly endpoints stay easy to audit.
"""

from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ..models import GlobalJobCounter, RateLimitCounter


def check_and_increment_ip(db: Session, ip: str, limit_per_hour: int) -> None:
    window_start = _truncate_to_hour(datetime.now(UTC))
    _check_and_increment(db, scope=f"ip:{ip}", window_start=window_start, limit=limit_per_hour)


def check_and_increment_user(db: Session, user_id: str, limit_per_day: int) -> None:
    window_start = _truncate_to_day(datetime.now(UTC))
    _check_and_increment(db, scope=f"user:{user_id}", window_start=window_start, limit=limit_per_day)


def check_and_increment_global_daily(db: Session, max_jobs_per_day: int) -> None:
    """The central backstop on total GPU spend (plan §5) — independent of
    user/IP identity, checked only when a job is actually about to launch.
    """
    day = _truncate_to_day(datetime.now(UTC))

    stmt = (
        insert(GlobalJobCounter)
        .values(day=day, jobs_started=1)
        .on_conflict_do_update(
            index_elements=[GlobalJobCounter.day],
            set_={"jobs_started": GlobalJobCounter.jobs_started + 1},
        )
        .returning(GlobalJobCounter.jobs_started)
    )
    new_count = db.execute(stmt).scalar_one()
    db.commit()

    if new_count > max_jobs_per_day:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Daily processing limit reached — try again tomorrow.",
        )


def _check_and_increment(db: Session, *, scope: str, window_start: datetime, limit: int) -> None:
    stmt = (
        insert(RateLimitCounter)
        .values(scope=scope, window_start=window_start, count=1)
        .on_conflict_do_update(
            index_elements=[RateLimitCounter.scope, RateLimitCounter.window_start],
            set_={"count": RateLimitCounter.count + 1},
        )
        .returning(RateLimitCounter.count)
    )
    new_count = db.execute(stmt).scalar_one()
    db.commit()

    if new_count > limit:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded — please slow down.",
        )


def _truncate_to_hour(dt: datetime) -> datetime:
    return dt.replace(minute=0, second=0, microsecond=0)


def _truncate_to_day(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)
