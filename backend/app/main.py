from fastapi import FastAPI

from .routers import gallery, jobs, objects, uploads

app = FastAPI(title="AI Gaussian Splatter API")

app.include_router(objects.router)
app.include_router(uploads.router)
app.include_router(jobs.router)
app.include_router(jobs.internal_router)
app.include_router(gallery.router)


@app.get("/api/v1/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}
