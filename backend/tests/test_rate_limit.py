"""Requires a real Postgres (TEST_DATABASE_URL) — rate_limit.py uses
sqlalchemy.dialects.postgresql's ON CONFLICT upsert, which SQLite can't
faithfully substitute for. Not run in the sandbox this was written in (no
Postgres available); wire TEST_DATABASE_URL to CI's Postgres service
container per plan §8 to actually execute this file.
"""

import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from tests.conftest import requires_postgres

pytestmark = requires_postgres()


@pytest.fixture
def db_session():
    from app.models import Base

    engine = create_engine(os.environ["TEST_DATABASE_URL"])
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    yield session
    session.rollback()
    Base.metadata.drop_all(engine)
    session.close()


def test_check_and_increment_ip_allows_up_to_limit(db_session):
    from app.services.rate_limit import check_and_increment_ip

    for _ in range(3):
        check_and_increment_ip(db_session, "203.0.113.5", limit_per_hour=3)  # should not raise


def test_check_and_increment_ip_raises_429_over_limit(db_session):
    from fastapi import HTTPException

    from app.services.rate_limit import check_and_increment_ip

    for _ in range(3):
        check_and_increment_ip(db_session, "203.0.113.5", limit_per_hour=3)

    with pytest.raises(HTTPException) as exc_info:
        check_and_increment_ip(db_session, "203.0.113.5", limit_per_hour=3)
    assert exc_info.value.status_code == 429


def test_check_and_increment_ip_is_scoped_per_ip(db_session):
    from app.services.rate_limit import check_and_increment_ip

    for _ in range(3):
        check_and_increment_ip(db_session, "203.0.113.5", limit_per_hour=3)

    # A different IP has its own independent counter.
    check_and_increment_ip(db_session, "203.0.113.9", limit_per_hour=3)  # should not raise


def test_check_and_increment_global_daily_raises_503_over_cap(db_session):
    from fastapi import HTTPException

    from app.services.rate_limit import check_and_increment_global_daily

    for _ in range(2):
        check_and_increment_global_daily(db_session, max_jobs_per_day=2)

    with pytest.raises(HTTPException) as exc_info:
        check_and_increment_global_daily(db_session, max_jobs_per_day=2)
    assert exc_info.value.status_code == 503


def test_check_and_increment_global_daily_is_independent_of_caller(db_session):
    """The whole point of the global cap (plan §5): it's not keyed by
    user/IP, so no amount of multi-accounting raises the effective ceiling.
    """
    from fastapi import HTTPException

    from app.services.rate_limit import check_and_increment_global_daily, check_and_increment_ip

    check_and_increment_ip(db_session, "1.1.1.1", limit_per_hour=100)
    check_and_increment_global_daily(db_session, max_jobs_per_day=1)

    # A different caller entirely still hits the same global counter, which
    # is already at its cap of 1 — this is the check that matters here.
    check_and_increment_ip(db_session, "2.2.2.2", limit_per_hour=100)
    with pytest.raises(HTTPException) as exc_info:
        check_and_increment_global_daily(db_session, max_jobs_per_day=1)
    assert exc_info.value.status_code == 503
