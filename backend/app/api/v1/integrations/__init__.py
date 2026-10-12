"""External Integrations API routes."""

from fastapi import APIRouter
from .urls import router as urls_router

router = APIRouter()
router.include_router(urls_router)
