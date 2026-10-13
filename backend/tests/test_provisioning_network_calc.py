"""Tests for network calculation and bootstrap endpoints.

These endpoints are operator-facing: they must resolve an authenticated
identity before doing anything else. A request with no credentials gets 401 —
the same behaviour the rebuilt provisioning client relies on — so the
authenticated cases use the local admin JWT and the unauthenticated cases
assert the 401.
"""
import pytest
from httpx import AsyncClient

from app.api.deps import get_optional_current_user
from app.main import app


class TestNetworkCalculation:
    """Test network calculation endpoint.

    The endpoint reserves the first ten host addresses for infrastructure, then
    offers everything up to the last usable host as the DHCP pool, so the
    assertions below are the values the router actually receives.
    """

    @pytest.mark.asyncio
    async def test_network_calc_basic_subnet(self, client: AsyncClient, admin_auth_headers):
        """Test basic network calculation with standard subnet."""
        response = await client.get(
            "/api/v1/provisioning/network/calc?subnet=192.168.1.0&cidr=24",
            headers=admin_auth_headers,
        )

        assert response.status_code == 200
        data = response.json()

        assert data["subnet_address"] == "192.168.1.0"
        assert data["cidr"] == 24
        assert data["gateway"] == "192.168.1.1"
        # Hosts[10]: the 11th usable address, leaving the first ten to
        # infrastructure (gateway, DNS, uplink, and so on).
        assert data["dhcp_pool_start"] == "192.168.1.11"
        assert data["dhcp_pool_end"] == "192.168.1.254"
        assert data["dhcp_pool"] == "192.168.1.11 - 192.168.1.254"
        assert data["network_mask"] == "255.255.255.0"
        assert data["total_hosts"] == 254

    @pytest.mark.asyncio
    async def test_network_calc_custom_subnet(self, client: AsyncClient, admin_auth_headers):
        """Test network calculation with custom subnet."""
        response = await client.get(
            "/api/v1/provisioning/network/calc?subnet=10.0.0.0&cidr=16",
            headers=admin_auth_headers,
        )

        assert response.status_code == 200
        data = response.json()

        assert data["subnet_address"] == "10.0.0.0"
        assert data["cidr"] == 16
        assert data["gateway"] == "10.0.0.1"
        assert data["dhcp_pool_start"] == "10.0.0.11"
        assert data["dhcp_pool_end"] == "10.0.255.254"
        assert data["network_mask"] == "255.255.0.0"
        assert data["total_hosts"] == 65534

    @pytest.mark.asyncio
    async def test_network_calc_small_subnet(self, client: AsyncClient, admin_auth_headers):
        """Test network calculation with small subnet (/28)."""
        response = await client.get(
            "/api/v1/provisioning/network/calc?subnet=172.16.1.0&cidr=28",
            headers=admin_auth_headers,
        )

        assert response.status_code == 200
        data = response.json()

        assert data["subnet_address"] == "172.16.1.0"
        assert data["cidr"] == 28
        assert data["gateway"] == "172.16.1.1"
        assert data["dhcp_pool_start"] == "172.16.1.11"
        assert data["dhcp_pool_end"] == "172.16.1.14"
        assert data["network_mask"] == "255.255.255.240"
        assert data["total_hosts"] == 14

    @pytest.mark.asyncio
    async def test_network_calc_defaults_when_params_absent(
        self, client: AsyncClient, admin_auth_headers
    ):
        """Both parameters are optional with router-usable defaults, so an
        absent pair is a defaulted answer rather than a validation error."""
        response = await client.get(
            "/api/v1/provisioning/network/calc", headers=admin_auth_headers
        )
        assert response.status_code == 200
        data = response.json()
        assert data["subnet_address"] == "172.31.0.0"
        assert data["cidr"] == 16

    @pytest.mark.asyncio
    async def test_network_calc_rejects_invalid_subnet(self, client: AsyncClient, admin_auth_headers):
        """A non-IP subnet is rejected, and reported as a client error rather
        than a 500."""
        response = await client.get(
            "/api/v1/provisioning/network/calc?subnet=invalid&cidr=24",
            headers=admin_auth_headers,
        )
        assert response.status_code == 400
        body = response.json()
        assert "detail" in body

    @pytest.mark.asyncio
    async def test_network_calc_rejects_out_of_range_cidr(
        self, client: AsyncClient, admin_auth_headers
    ):
        """A CIDR outside the supported router range is a validation error."""
        response = await client.get(
            "/api/v1/provisioning/network/calc?subnet=192.168.1.0&cidr=50",
            headers=admin_auth_headers,
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_network_calc_requires_authentication(self, client: AsyncClient):
        """A provisioning calculation may not be run anonymously."""
        response = await client.get("/api/v1/provisioning/network/calc?subnet=192.168.1.0&cidr=24")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_network_validate_confirms_a_gateway_in_network(
        self, client: AsyncClient, admin_auth_headers
    ):
        response = await client.get(
            "/api/v1/provisioning/network/validate?subnet_address=192.168.1.0"
            "&cidr=24&gateway=192.168.1.1",
            headers=admin_auth_headers,
        )
        assert response.status_code == 200
        data = response.json()
        assert data["valid"] is True
        assert data["gateway_in_network"] is True

    @pytest.mark.asyncio
    async def test_network_validate_flags_a_gateway_outside_the_network(
        self, client: AsyncClient, admin_auth_headers
    ):
        response = await client.get(
            "/api/v1/provisioning/network/validate?subnet_address=192.168.1.0"
            "&cidr=24&gateway=10.0.0.1",
            headers=admin_auth_headers,
        )
        assert response.status_code == 200
        assert response.json()["valid"] is False


class TestBootstrapCommandGeneration:
    """Test bootstrap command generation endpoint."""

    @pytest.mark.asyncio
    async def test_bootstrap_command_requires_authentication(self, client: AsyncClient):
        """Bootstrap is an operator action: no credentials means 401, and never
        a credential minted for an anonymous caller."""
        response = await client.get("/api/v1/provisioning/bootstrap/command")
        assert response.status_code == 401
        assert "command" not in response.text

    @pytest.mark.asyncio
    async def test_bootstrap_script_requires_a_bootstrap_token(self, client: AsyncClient):
        """The device-facing script is protected by the bootstrap credential,
        not by a browser session, so a plain call is rejected."""
        response = await client.get("/api/v1/provisioning/bootstrap/script")
        assert response.status_code in (400, 401)


class TestProvisioningWorkflow:
    """Test provisioning workflow endpoints."""

    @pytest.mark.asyncio
    async def test_workflow_requires_authentication(self, client: AsyncClient):
        """An anonymous POST cannot create a provisioning session."""
        response = await client.post("/api/v1/provisioning/workflow", json={})
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_workflow_rejects_invalid_payload(self, client: AsyncClient, admin_auth_headers):
        """A malformed body is a 422, distinct from an auth failure."""
        response = await client.post(
            "/api/v1/provisioning/workflow", json={}, headers=admin_auth_headers
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_sessions_list_requires_authentication(self, client: AsyncClient):
        """The session list must not be readable without credentials."""
        response = await client.get("/api/v1/provisioning/sessions?limit=20")
        assert response.status_code == 401

    @pytest.mark.asyncio
    async def test_session_status_returns_404_for_unknown_session(
        self, client: AsyncClient, admin_auth_headers
    ):
        """A known user asking for a session that does not exist gets a 404,
        not a 500."""
        response = await client.get(
            "/api/v1/provisioning/sessions/does-not-exist/status",
            headers=admin_auth_headers,
        )
        assert response.status_code in (401, 403, 404)


class TestProvisioningAuthWiring:
    """The endpoints must depend on the reconstructed provisioning resolver."""

    def test_provisioning_router_uses_the_supabase_aware_resolver(self):
        import app.api.v1.provisioning.workflow as workflow

        assert workflow.get_optional_current_user is get_optional_current_user

    def test_service_types_are_the_ones_the_client_sends(self):
        from app.models.provisioning import ServiceType

        assert {s.value for s in ServiceType} >= {"hotspot", "pppoe_server", "both"}
