import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_user
from ..models import Object, User
from ..schemas import ObjectCreate, ObjectRead

router = APIRouter(prefix="/api/v1/objects", tags=["objects"])


@router.post("", response_model=ObjectRead, status_code=status.HTTP_201_CREATED)
def create_object(
    body: ObjectCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Object:
    obj = Object(user_id=user.id, name=body.name)
    db.add(obj)
    db.commit()
    db.refresh(obj)
    return obj


@router.get("", response_model=list[ObjectRead])
def list_objects(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[Object]:
    return (
        db.query(Object)
        .filter(Object.user_id == user.id)
        .order_by(Object.created_at.desc())
        .all()
    )


@router.get("/{object_id}", response_model=ObjectRead)
def get_object(
    object_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Object:
    obj = db.query(Object).filter(Object.id == object_id, Object.user_id == user.id).one_or_none()
    if obj is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Object not found")
    return obj
