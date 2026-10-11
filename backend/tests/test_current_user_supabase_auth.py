"""Regression tests: the universal resolver must accept Supabase access tokens.

The Add-a-MikroTik wizard calls ``GET /api/v1/routers/?search=...`` through
``src/lib/provisionApi.ts``, which authenticates with the signed-in Supabase
session token. Before the fix that endpoint authorized via ``get_current_user``,
which only understood local HS256 / central-SSO RS256 tokens, so a correctly
signed-in Supabase user got ``401 AUTH_1003`` ("Not authenticated").
``get_current_user`` now falls through to the Supabase identity bridge; these
tests pin that behavior without weakening the local/SSO paths, the role checks,
or tenant isolation (the mapped local User row's organization_id is preserved).
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import HTTPException, Request

from app.api import deps
from app.core import sso
from app.models.user import UserRole


class FakeSupabaseResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self.body = body

    def json(self):
        return self.body


class FakeSupabaseClient:
    def __init__(self, response):
        self.response = response

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def get(self, url, headers):
        assert url == "https://project.supabase.co/auth/v1/user"
        assert headers["apikey"] == "public-anon-key"
        assert headers["Authorization"] == "Bearer supabase-access-token"
        return self.response


def make_request():
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/v1/routers/",
        "headers": [(b"authorization", b"Bearer supabase-access-token")],
        "query_string": b"search=mapito&size=50",
        "server": ("test", 80),
        "client": ("test", 1234),
        "scheme": "https",
    })


@pytest.fixture
def non_local_non_sso(monkeypatch):
    # Not a local HS256 token and not a central-SSO token: force the first two
    # resolver branches to miss so the Supabase fall-through is exercised.
    monkeypatch.setattr(deps, "verify_token", lambda token: None)

    async def no_sso_claims(request):
        return None

    monkeypatch.setattr(sso, "get_optional_sso_claims", no_sso_claims)
    monkeypatch.setattr(deps.settings, "supabase_auth_url", "https://project.supabase.co")
    monkeypatch.setattr(deps.settings, "supabase_anon_key", "public-anon-key")


@pytest.mark.asyncio
async def test_supabase_token_resolves_mapped_technician(monkeypatch, non_local_non_sso):
    user = SimpleNamespace(
        id=7,
        supabase_user_id="auth-uuid",
        is_active=True,
        role=UserRole.ISP_TECHNICIAN,
        organization_id=42,
    )
    result = SimpleNamespace(scalar_one_or_none=lambda: user)
    db = SimpleNamespace(execute=AsyncMock(return_value=result))
    monkeypatch.setattr(
        deps.httpx, "AsyncClient",
        lambda **kwargs: FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "auth-uuid"})),
    )

    resolved = await deps.get_current_user(make_request(), "supabase-access-token", db)

    assert resolved is user
    # Tenant identity must survive the bridge unchanged.
    assert resolved.organization_id == 42


@pytest.mark.asyncio
async def test_unmapped_supabase_subject_is_unauthorized(monkeypatch, non_local_non_sso):
    result = SimpleNamespace(scalar_one_or_none=lambda: None)
    db = SimpleNamespace(execute=AsyncMock(return_value=result))
    monkeypatch.setattr(
        deps.httpx, "AsyncClient",
        lambda **kwargs: FakeSupabaseClient(FakeSupabaseResponse(200, {"id": "unmapped"})),
    )

    with pytest.raises(HTTPException) as exc:
        await deps.get_current_user(make_request(), "supabase-access-token", db)

    assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_invalid_supabase_token_is_unauthorized(monkeypatch, non_local_non_sso):
    db = SimpleNamespace(execute=AsyncMock())
    monkeypatch.setattr(
        deps.httpx, "AsyncClient",
        lambda **kwargs: FakeSupabaseClient(FakeSupabaseResponse(401, {"message": "invalid"})),
    )

    with pytest.raises(HTTPException) as exc:
        await deps.get_current_user(make_request(), "supabase-access-token", db)

    assert exc.value.status_code == 401
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_supabase_unreachable_is_503_not_invalid_credentials(monkeypatch, non_local_non_sso):
    # A Supabase network outage must be reported as a 503 service problem, never
    # silently downgraded to a 401 "invalid credentials" — the user's token may
    # be perfectly valid; we simply could not verify it right now.
    db = SimpleNamespace(execute=AsyncMock())

    class _BoomClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return None

        async def get(self, url, headers):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(deps.httpx, "AsyncClient", lambda **kwargs: _BoomClient())

    with pytest.raises(HTTPException) as exc:
        await deps.get_current_user(make_request(), "supabase-access-token", db)

    assert exc.value.status_code == 503
    db.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_local_token_short_circuits_before_supabase(monkeypatch):
    # A valid local HS256 token must never trigger the Supabase round-trip.
    monkeypatch.setattr(deps, "verify_token", lambda token: SimpleNamespace(user_id=7))
    user = SimpleNamespace(id=7, is_active=True, role=UserRole.ISP_ADMIN, organization_id=1)

    async def boom(**kwargs):
        raise AssertionError("Supabase must not be called for a local token")

    monkeypatch.setattr(deps.httpx, "AsyncClient", boom)

    class _UserService:
        def __init__(self, db):
            pass

        async def get_by_id(self, user_id):
            return user

    monkeypatch.setattr(deps, "UserService", _UserService)

    resolved = await deps.get_current_user(make_request(), "local-token", SimpleNamespace())
    assert resolved is user
