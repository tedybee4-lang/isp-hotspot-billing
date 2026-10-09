"""
Workflow endpoints for MikroTik provisioning.
Handles the main provisioning workflow and session management.
"""
import logging
from typing import Dict, Any, List, Optional
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.models.user import User, UserRole
from app.api.deps import (
    authorize_provisioning_router,
    authorize_provisioning_session,
    get_optional_current_user,
    get_db,
)
from app.modules.provisioning import ProvisioningService
from app.models.provisioning import ServiceType, ProvisioningStatus, ProvisioningSession
from app.core.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


class ProvisioningRequest(BaseModel):
    router_id: int
    service_type: str  # 'hotspot', 'pppoe_server', or 'both'
    configuration: Dict[str, Any]


class ProvisioningResponse(BaseModel):
    session_id: str
    status: str
    message: str


class SessionStatusResponse(BaseModel):
    session_id: str
    status: str
    current_step: Optional[str] = None
    progress: Optional[int] = None
    steps: Optional[List[Dict[str, Any]]] = None
    error_message: Optional[str] = None


@router.post("/workflow", response_model=ProvisioningResponse)
async def start_provisioning_workflow(
    request: ProvisioningRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """Start the provisioning workflow for a MikroTik device.

    NOTE: This endpoint both *creates* the provisioning session and starts the
    background workflow. If callers only need to *create* a session without
    starting provisioning (used by the UI to attach session_id to bootstrap
    commands), use `POST /sessions` (create-only) implemented below.
    """
    try:
        await authorize_provisioning_router(db, current_user, request.router_id)
        provisioning_service = ProvisioningService(db)

        # Convert service_type string to enum
        try:
            service_type = ServiceType(request.service_type)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid service_type: {request.service_type}. Must be 'hotspot', 'pppoe_server', or 'both'"
            )

        # Create a new provisioning session
        session = await provisioning_service.create_provisioning_session(
            router_id=request.router_id,
            user_id=current_user.id,
            service_type=service_type,
            configuration=request.configuration
        )

        # Start the provisioning process in the background
        background_tasks.add_task(
            provisioning_service.start_provisioning,
            session.session_id
        )

        return ProvisioningResponse(
            session_id=session.session_id,
            status="started",
            message="Provisioning workflow started successfully"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to start provisioning workflow: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to start provisioning: {str(e)}")


# Create-only session endpoint (UI uses this to obtain a session_id that can
# be embedded into the bootstrap notify URL so router callbacks can be
# correlated immediately).
@router.post("/sessions", status_code=201)
async def create_provisioning_session_only(
    request: ProvisioningRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """Create a provisioning session in PENDING state without starting it.

    The UI should call this before generating the bootstrap command so the
    returned `session_id` can be embedded in the notify URL. Later the UI
    calls the standard `POST /workflow` or `POST /sessions/{session_id}/retry`
    to start the actual provisioning process.
    """
    try:
        await authorize_provisioning_router(db, current_user, request.router_id)
        provisioning_service = ProvisioningService(db)
        service_type = ServiceType(request.service_type)

        session = await provisioning_service.create_provisioning_session(
            router_id=request.router_id,
            user_id=current_user.id,
            service_type=service_type,
            configuration=request.configuration
        )

        return {"session_id": session.session_id, "status": "pending"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create provisioning session: {e}")
        raise HTTPException(status_code=500, detail="Failed to create provisioning session")


@router.get("/sessions/{session_id}/status", response_model=SessionStatusResponse)
async def get_provisioning_status(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """Get the current status of a provisioning session."""
    try:
        await authorize_provisioning_session(db, current_user, session_id)
        provisioning_service = ProvisioningService(db)
        status = await provisioning_service.get_session_status(session_id)

        if not status:
            raise HTTPException(status_code=404, detail="Provisioning session not found")

        return SessionStatusResponse(**status)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get provisioning status: {e}")
        raise HTTPException(status_code=500, detail="Failed to get provisioning status")


@router.post("/sessions/{session_id}/cancel")
async def cancel_provisioning(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """Cancel a running provisioning session."""
    try:
        await authorize_provisioning_session(db, current_user, session_id)
        provisioning_service = ProvisioningService(db)
        success = await provisioning_service.cancel_provisioning(session_id)

        if not success:
            raise HTTPException(status_code=404, detail="Provisioning session not found or cannot be cancelled")

        return {"message": "Provisioning session cancelled successfully", "session_id": session_id}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to cancel provisioning: {e}")
        raise HTTPException(status_code=500, detail="Failed to cancel provisioning")


@router.post("/router/{router_id}/cancel-active")
async def cancel_active_sessions_for_router(
    router_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """Cancel all active/pending provisioning sessions for a router.

    Useful for clearing stale sessions before reprovisioning.
    """
    from sqlalchemy import select
    from app.models.provisioning import ProvisioningSession
    from datetime import datetime

    try:
        await authorize_provisioning_router(db, current_user, router_id)
        # Find all active sessions for this router
        result = await db.execute(
            select(ProvisioningSession).where(
                ProvisioningSession.router_id == router_id,
                ProvisioningSession.status.in_([
                    ProvisioningStatus.PENDING,
                    ProvisioningStatus.IN_PROGRESS
                ])
            )
        )
        active_sessions = result.scalars().all()

        if not active_sessions:
            return {
                "message": "No active sessions found for this router",
                "router_id": router_id,
                "cancelled_count": 0
            }

        # Cancel all active sessions
        cancelled_count = 0
        cancelled_session_ids = []
        for session in active_sessions:
            session.status = ProvisioningStatus.CANCELLED
            session.error_message = "Force cancelled for reprovisioning"
            session.completed_at = datetime.utcnow()
            cancelled_count += 1
            cancelled_session_ids.append(session.session_id)

        await db.commit()

        logger.info(f"Cancelled {cancelled_count} active sessions for router {router_id}: {cancelled_session_ids}")

        return {
            "message": f"Cancelled {cancelled_count} active session(s)",
            "router_id": router_id,
            "cancelled_count": cancelled_count,
            "cancelled_session_ids": cancelled_session_ids
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to cancel active sessions for router {router_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to cancel active sessions: {str(e)}")


@router.get("/sessions/{session_id}/logs")
async def get_provisioning_logs(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """Get the logs for a provisioning session (steps and commands)."""
    try:
        await authorize_provisioning_session(db, current_user, session_id)
        provisioning_service = ProvisioningService(db)

        # Get both step logs and command logs
        steps = await provisioning_service.get_session_steps(session_id)
        commands = await provisioning_service.get_session_commands(session_id)

        if steps is None and commands is None:
            raise HTTPException(status_code=404, detail="Provisioning session not found")

        # Format the logs
        logs = []
        if steps:
            for step in steps:
                logs.append({
                    "type": "step",
                    "step": step.step.value if hasattr(step.step, 'value') else str(step.step),
                    "status": step.status.value if hasattr(step.status, 'value') else str(step.status),
                    "started_at": step.started_at.isoformat() if step.started_at else None,
                    "completed_at": step.completed_at.isoformat() if step.completed_at else None,
                    "error_message": step.error_message,
                })

        if commands:
            for cmd in commands:
                logs.append({
                    "type": "command",
                    "command": cmd.command,
                    "status": cmd.status.value if hasattr(cmd.status, 'value') else str(cmd.status),
                    "executed_at": cmd.executed_at.isoformat() if cmd.executed_at else None,
                    "result": cmd.result,
                    "error_message": cmd.error_message,
                })

        return {"session_id": session_id, "logs": logs}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get provisioning logs: {e}")
        raise HTTPException(status_code=500, detail="Failed to get provisioning logs")


@router.post("/sessions/{session_id}/retry")
async def retry_provisioning(
    session_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """Retry a failed provisioning session."""
    try:
        await authorize_provisioning_session(db, current_user, session_id)
        provisioning_service = ProvisioningService(db)

        # Use the existing retry_provisioning method which handles reset internally
        success = await provisioning_service.retry_provisioning(session_id)

        if not success:
            raise HTTPException(status_code=400, detail="Cannot retry this provisioning session")

        return {
            "message": "Provisioning retry started successfully",
            "session_id": session_id
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to retry provisioning: {e}")
        raise HTTPException(status_code=500, detail="Failed to retry provisioning")


@router.get("/sessions")
async def list_provisioning_sessions(
    skip: int = 0,
    limit: int = 20,
    status: Optional[str] = None,
    router_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """List all provisioning sessions with optional filters.

    Note: older callers pass `skip`/`limit` (offset/limit). The underlying
    service expects a PaginationParams object — convert `skip`/`limit` to
    page/size here for backward compatibility.
    """
    try:
        from sqlalchemy import func
        from app.models.router import Router

        skip = max(0, skip)
        limit = min(max(1, limit), 100)
        query = (
            select(ProvisioningSession)
            .join(Router, Router.id == ProvisioningSession.router_id)
        )
        if current_user.role != UserRole.PLATFORM_OWNER:
            if current_user.organization_id is None:
                return {"sessions": [], "skip": skip, "limit": limit, "total": 0}
            query = query.where(Router.organization_id == current_user.organization_id)
        if router_id is not None:
            await authorize_provisioning_router(db, current_user, router_id)
            query = query.where(ProvisioningSession.router_id == router_id)
        if status:
            try:
                requested_status = ProvisioningStatus[status.upper()]
            except KeyError as exc:
                raise HTTPException(status_code=400, detail="Invalid provisioning status") from exc
            query = query.where(ProvisioningSession.status == requested_status)

        count_result = await db.execute(
            select(func.count()).select_from(query.subquery())
        )
        total = count_result.scalar_one()
        result = await db.execute(
            query.order_by(ProvisioningSession.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        sessions = result.scalars().all()

        return {
            "sessions": [
                {
                    "session_id": s.session_id,
                    "router_id": s.router_id,
                    "status": s.status.value if hasattr(s.status, 'value') else str(s.status),
                    "service_type": s.service_type.value if hasattr(s.service_type, 'value') else str(s.service_type),
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                    "completed_at": s.completed_at.isoformat() if s.completed_at else None,
                }
                for s in sessions
            ],
            "skip": skip,
            "limit": limit,
            "total": total
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to list provisioning sessions: {e}")
        raise HTTPException(status_code=500, detail="Failed to list provisioning sessions")


@router.delete("/sessions/{session_id}")
async def delete_provisioning_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """Delete a provisioning session (only if completed or failed)."""
    try:
        await authorize_provisioning_session(db, current_user, session_id)
        provisioning_service = ProvisioningService(db)
        success = await provisioning_service.delete_session(session_id)

        if not success:
            raise HTTPException(
                status_code=400,
                detail="Session not found or cannot be deleted (still in progress)"
            )

        return {"message": "Provisioning session deleted successfully"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete provisioning session: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete provisioning session")


class DeviceStatusResponse(BaseModel):
    """Response model for device status check."""
    online: bool
    details: Optional[Dict[str, Any]] = None
    error: Optional[str] = None


class ScriptVerificationResponse(BaseModel):
    """Response model for script verification."""
    script_exists: bool
    identity_matches: bool
    identity_in_script: Optional[str] = None
    expected_identity: str
    verified: bool
    error: Optional[str] = None


@router.get("/verify-script/{router_id}", response_model=ScriptVerificationResponse)
async def verify_bootstrap_script(
    router_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """
    Verify that the bootstrap script (codevertex.rsc) exists on the router
    and contains the correct router identity.

    This is used in Step 2 of provisioning to confirm the script was
    successfully executed on the MikroTik device.

    Args:
        router_id: The router ID to verify

    Returns:
        ScriptVerificationResponse with verification results
    """
    from app.models.router import Router
    from app.integrations.mikrotik import MikroTikClient
    from sqlalchemy import select

    try:
        await authorize_provisioning_router(db, current_user, router_id)
        # Fetch the router from database
        result = await db.execute(
            select(Router).where(Router.id == router_id)
        )
        router = result.scalar_one_or_none()

        if not router:
            raise HTTPException(status_code=404, detail="Router not found")

        # Create MikroTik client and verify script
        client = MikroTikClient()
        verification = await client.verify_bootstrap_script(
            router=router,
            expected_identity=router.name
        )

        verified = (
            verification.get("script_exists", False) and
            verification.get("identity_matches", False)
        )

        return ScriptVerificationResponse(
            script_exists=verification.get("script_exists", False),
            identity_matches=verification.get("identity_matches", False),
            identity_in_script=verification.get("identity_in_script"),
            expected_identity=router.name,
            verified=verified,
            error=verification.get("error")
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to verify script for router {router_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to verify script: {str(e)}")


@router.get("/device-status/{router_id}", response_model=DeviceStatusResponse)
async def check_device_status(
    router_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_optional_current_user),
):
    """
    Check if a MikroTik device is online using stored API credentials.
    Used for reprovisioning auto-detection.
    """
    from app.models.router import Router
    from app.core.encryption import get_credential_encryption
    from app.integrations.mikrotik import get_mikrotik_client
    from sqlalchemy import select, update
    from datetime import datetime as dt

    try:
        await authorize_provisioning_router(db, current_user, router_id)
        # Fetch the router from database
        result = await db.execute(
            select(Router).where(Router.id == router_id)
        )
        router = result.scalar_one_or_none()

        if not router:
            raise HTTPException(status_code=404, detail="Router not found")

        # ── Agent-liveness fast path (NAT-safe) ──
        # If the polling agent is installed and has phoned home recently, the
        # device is online. The cloud cannot (and need not) open a direct API
        # connection to a NAT'd router, so trust the agent heartbeat instead.
        if getattr(router, "agent_installed", False) and getattr(router, "last_poll_at", None):
            elapsed = (dt.utcnow() - router.last_poll_at).total_seconds()
            threshold = (router.agent_poll_interval or 30) * 3
            if elapsed < threshold:
                return DeviceStatusResponse(
                    online=True,
                    details={
                        "identity": router.name,
                        "version": router.routeros_version or "Unknown",
                        "via": "polling-agent",
                        "last_poll_secs": int(elapsed),
                    },
                )

        # Check if router has stored API credentials
        if not router.api_credentials_encrypted:
            return DeviceStatusResponse(
                online=False,
                error="No stored API credentials found for this router"
            )

        # Decrypt the API credentials using the existing encryption service
        try:
            encryption = get_credential_encryption()
            creds_dict = encryption.decrypt_credentials(router.api_credentials_encrypted)
            username = creds_dict["username"]
            password = creds_dict["password"]
        except Exception as e:
            logger.error(f"Failed to decrypt API credentials: {e}")
            return DeviceStatusResponse(
                online=False,
                error="Failed to decrypt stored credentials"
            )

        # Try to connect to the device via API using the existing MikroTikClient
        try:
            client = get_mikrotik_client()
            connection = await client.connect(
                ip_address=router.ip_address,
                username=username,
                password=password,
                port=router.port,
            )

            # Test connection by getting system identity and resource info
            identity_name = "Unknown"
            uptime = "0s"
            version = "Unknown"

            try:
                identity_result = await client.execute_command(connection, "/system/identity", "get")
                if identity_result and len(identity_result) > 0:
                    identity_name = identity_result[0].get("name", "Unknown")
            except Exception:
                pass

            try:
                resource_result = await client.execute_command(connection, "/system/resource", "get")
                if resource_result and len(resource_result) > 0:
                    uptime = resource_result[0].get("uptime", "0s")
                    version = resource_result[0].get("version", "Unknown")
            except Exception:
                pass

            # Disconnect cleanly
            await client.disconnect(router.ip_address, router.port)

            # Update router status in database
            await db.execute(
                update(Router)
                .where(Router.id == router_id)
                .values(status="online", last_seen=dt.utcnow())
            )
            await db.commit()

            return DeviceStatusResponse(
                online=True,
                details={
                    "identity": identity_name,
                    "uptime": uptime,
                    "version": version,
                }
            )

        except Exception as e:
            error_str = str(e).lower()
            if "authentication" in error_str or "login" in error_str or "invalid" in error_str:
                logger.warning(f"Device {router_id} authentication failed: {e}")
                return DeviceStatusResponse(
                    online=False,
                    error="Authentication failed - invalid credentials"
                )
            elif "connection" in error_str or "timeout" in error_str or "refused" in error_str:
                logger.warning(f"Device {router_id} connection failed: {e}")
                return DeviceStatusResponse(
                    online=False,
                    error="Device not responding - connection failed"
                )
            else:
                logger.warning(f"Device {router_id} connection failed: {e}")
                return DeviceStatusResponse(
                    online=False,
                    error=f"Connection failed: {str(e)}"
                )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to check device status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to check device status: {str(e)}")


# ============================================================================
# SCRIPT-BASED PROVISIONING (for routers unreachable from cloud backend)
# ============================================================================
# When the backend cannot directly connect to the router (e.g., cloud backend
# + router on private LAN), provisioning is done via a RouterOS script that
# the user pastes on the router. The script executes all commands locally and
# POSTs a completion callback to the backend.
# ============================================================================


@router.get("/provision-script/{session_id}", response_class=PlainTextResponse)
async def get_provisioning_script(
    session_id: str,
    response: Response,
    token: str = Query(..., description="Provisioning token"),
    db: AsyncSession = Depends(get_db),
):
    """Generate a RouterOS RSC script containing all provisioning commands.

    This endpoint is used when the cloud backend cannot directly reach the router.
    Instead of the backend executing commands via the RouterOS API, the user pastes
    a command on the router that fetches and executes this script.

    Flow:
    1. Frontend calls POST /workflow to create a session
    2. Backend detects it can't reach the router, returns script_url
    3. User pastes the /tool/fetch command on the router
    4. Router fetches this script and executes it
    5. Script POSTs completion to /provision-script/{session_id}/complete
    """
    from app.api.v1.provisioning.bootstrap import (
        _issue_bootstrap_credential,
        _verify_bootstrap_session,
    )
    from app.modules.provisioning.commands import (
        generate_configuration_commands,
        generate_hotspot_commands,
        generate_pppoe_commands,
    )

    _, session, router = await _verify_bootstrap_session(
        db, token, "provisioning.script", session_id
    )
    response.headers["Cache-Control"] = "no-store, private"
    response.headers["Pragma"] = "no-cache"
    completion_token = _issue_bootstrap_credential(
        session.user_id,
        session.session_id,
        router.id,
        "provisioning.complete",
    )

    # Get the session configuration
    config = session.configuration or {}
    service_type = session.service_type
    routeros_version = config.get('routeros_version')

    # Inject the tenant's timezone + captive-portal template URLs so the provision
    # script can (a) set the router clock to the org's local time and (b) install
    # the redirecting hotspot login page pointing at THIS org's buy portal. The
    # router fetches these template URLs from the backend over its WAN.
    # Resolve the org from the session, falling back to the ROUTER's org (the
    # provisioning session does not always carry organization_id).
    from app.models.organization import Organization
    from app.core.config import settings as _settings
    _org_id = getattr(session, 'organization_id', None)
    if not _org_id and getattr(session, 'router_id', None):
        from app.models.router import Router as _Router
        _r = await db.execute(select(_Router).where(_Router.id == session.router_id))
        _router_row = _r.scalar_one_or_none()
        _org_id = getattr(_router_row, 'organization_id', None) if _router_row else None
    if _org_id:
        org_res = await db.execute(
            select(Organization).where(Organization.id == _org_id)
        )
        _org = org_res.scalar_one_or_none()
        if _org:
            if not config.get('timezone') and _org.timezone:
                config['timezone'] = _org.timezone
            _base = (_settings.backend_url or "").rstrip("/")
            if _base and _org.slug:
                config.setdefault('org_slug', _org.slug)
                config.setdefault(
                    'login_template_url',
                    f"{_base}/api/v1/provisioning/templates/login.html?org_slug={_org.slug}",
                )
                config.setdefault(
                    'alogin_template_url',
                    f"{_base}/api/v1/provisioning/templates/alogin.html?org_slug={_org.slug}",
                )

    # Generate commands
    all_commands = []

    # Basic configuration commands (bridge, IP, DHCP, DNS, NAT)
    config_commands = generate_configuration_commands(config, service_type, routeros_version)
    all_commands.extend(config_commands)

    # Service-specific commands
    if service_type in (ServiceType.HOTSPOT, ServiceType('both')):
        hotspot_commands = generate_hotspot_commands(config, routeros_version)
        all_commands.extend(hotspot_commands)

    if service_type in (ServiceType.PPPOE_SERVER, ServiceType('both')):
        pppoe_commands = generate_pppoe_commands(config, routeros_version)
        all_commands.extend(pppoe_commands)

    # Build the RouterOS script
    lines = [
        "# Codevertex ISP Billing - Provisioning Script",
        "# Generated for session: " + session_id,
        f"# RouterOS version: {routeros_version or 'auto-detect'}",
        "# All operations are logged to /log and displayed in terminal",
        "",
        ":put \"\"",
        ":put \"=========================================\"",
        ":put \"Codevertex Provisioning - Starting\"",
        ":put \"=========================================\"",
        "",
    ]

    # Convert each command dict to a RouterOS script line with error handling
    total = len(all_commands)
    for idx, cmd in enumerate(all_commands, 1):
        command_str = cmd.get("command", "")
        description = cmd.get("description", f"Command {idx}")
        is_critical = cmd.get("critical", False)

        if not command_str:
            continue

        lines.append(f"# [{idx}/{total}] {description}")

        if is_critical:
            # Critical commands: abort on failure
            lines.append(f":do {{ {command_str}; :put \"[OK] {description}\"; :log info \"[PROVISION] {description}\" }} on-error={{ :put \"[FAIL] {description}\"; :log error \"[PROVISION] CRITICAL FAILURE: {description}\"; :error \"Provisioning aborted: {description}\" }}")
        else:
            # Non-critical commands: log warning and continue
            lines.append(f":do {{ {command_str}; :put \"[OK] {description}\"; :log info \"[PROVISION] {description}\" }} on-error={{ :put \"[WARN] {description} (non-critical)\"; :log warning \"[PROVISION] {description} failed (non-critical)\" }}")

        lines.append("")

    # Completion summary
    lines.extend([
        ":put \"\"",
        ":put \"=========================================\"",
        ":put \"Provisioning completed successfully\"",
        ":put \"=========================================\"",
        "",
    ])

    # Completion callback to backend
    try:
        base_url = settings.backend_url or ''
        complete_url = f"{base_url}/api/v1/provisioning/provision-script/{session_id}/complete?token={completion_token}&status=completed"
        complete_mode = "https" if complete_url.startswith("https://") else "http"
        lines.extend([
            "# Notify backend of completion",
            ":do {",
            f"  /tool/fetch mode={complete_mode} url=\"{complete_url}\" http-method=post dst-path=provision-complete.result",
            "  :put \"[OK] Backend notified of provisioning completion\"",
            "  :log info \"[PROVISION] Backend notified of completion\"",
            "} on-error={ :put \"[WARN] Failed to notify backend (non-critical)\"; :log warning \"[PROVISION] Failed to notify backend\" }",
        ])
    except Exception:
        lines.append(":put \"[WARN] Could not build completion callback URL\"")

    return PlainTextResponse(
        "\n".join(lines) + "\n",
        headers={
            "Cache-Control": "no-store, private",
            "Pragma": "no-cache",
        },
    )


@router.post("/provision-script/{session_id}/complete")
async def provisioning_script_complete(
    request: Request,
    session_id: str,
    token: str = Query(..., description="Provisioning token"),
    status: str = Query('completed', description="Provisioning status"),
    db: AsyncSession = Depends(get_db),
):
    """Callback endpoint: router reports that the provisioning script completed.

    Called by the router after executing the provisioning script. Updates the
    session status and broadcasts completion via WebSocket.
    """
    from datetime import datetime

    from app.api.v1.provisioning.bootstrap import _verify_bootstrap_session

    _, session, _ = await _verify_bootstrap_session(
        db, token, "provisioning.complete", session_id
    )

    if status not in {"completed", "failed"}:
        raise HTTPException(
            status_code=422,
            detail="Status must be either 'completed' or 'failed'",
        )

    terminal_status = (
        ProvisioningStatus.COMPLETED
        if status == "completed"
        else ProvisioningStatus.FAILED
    )
    if session.status in {
        ProvisioningStatus.COMPLETED,
        ProvisioningStatus.FAILED,
        ProvisioningStatus.CANCELLED,
        ProvisioningStatus.TIMEOUT,
    }:
        if session.status != terminal_status:
            raise HTTPException(
                status_code=409,
                detail="Provisioning session is already in a different terminal state",
            )

    # Apply the router's result only while the session is active.
    if session.status != terminal_status:
        session.status = terminal_status
    if session.completed_at is None:
        session.completed_at = datetime.utcnow()
    session.success = status == "completed"
    if status == "completed":
        session.progress_percentage = 100
    elif not session.error_message:
        session.error_message = "Script-based provisioning reported failure"

    await db.commit()

    # Mark router as provisioned
    if status == 'completed' and session.router_id:
        try:
            from app.services.router_provisioning import mark_provisioning_complete
            service_type_str = session.service_type.value if hasattr(session.service_type, 'value') else str(session.service_type)
            await mark_provisioning_complete(db, session.router_id, service_type_str)
        except Exception as e:
            logger.warning(f"Failed to mark router {session.router_id} as provisioned: {e}")

    # Broadcast completion via WebSocket
    try:
        from app.api.v1.provisioning.stream import manager
        await manager.send_message(session_id, {
            'type': 'provisioning_complete',
            'session_id': session_id,
            'data': {
                'status': status,
                'message': 'Provisioning completed via script execution',
                'timestamp': datetime.utcnow().isoformat(),
            }
        })
    except Exception:
        logger.exception(
            "Failed to broadcast script provisioning completion for session %s",
            session_id,
        )

    logger.info(f"Script-based provisioning completed for session {session_id} (status={status})")
    return {'success': True, 'session_id': session_id, 'status': status}
