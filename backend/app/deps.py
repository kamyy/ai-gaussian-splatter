from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from .auth.clerk import ClerkUser, get_current_clerk_user
from .db import get_db
from .models import Job, User


def get_current_user(
    clerk_user: ClerkUser = Depends(get_current_clerk_user),
    db: Session = Depends(get_db),
) -> User:
    """Local shadow row per plan §2 — created lazily on first request."""
    user = db.query(User).filter(User.clerk_user_id == clerk_user.clerk_user_id).one_or_none()
    if user is None:
        user = User(clerk_user_id=clerk_user.clerk_user_id)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def get_client_ip(request: Request) -> str:
    """Falls back to X-Forwarded-For (first hop) since the app sits behind
    an ALB/CloudFront (plan §5).
    """
    forwarded_for = request.headers.get("X-Forwarded-For")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client is None:
        return "unknown"
    return request.client.host


def get_job_for_callback_token(job_id: str, request: Request, db: Session = Depends(get_db)) -> Job:
    """Auth for the worker->backend status callback (plan §3): a per-job
    signed token, not a Clerk JWT, scoped so a compromised instance can only
    mutate the one job it was launched for.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    token = auth_header.removeprefix("Bearer ").strip()

    job = db.query(Job).filter(Job.id == job_id).one_or_none()
    if job is None or job.callback_token != token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid job token")
    return job
