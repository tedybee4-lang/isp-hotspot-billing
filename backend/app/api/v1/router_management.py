"""
Router management API for MikroTik router administration.

This module provides API endpoints for managing routers, monitoring their status,
and performing administrative actions.
"""
import logging
from typing import Dict, List, Optional, Any
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from app.api.deps import (
    authorize_provisioning_router,
    authorize_provisioning_session,
    get_db,
)
from app.models.router import Router
from app.models.provisioning import ProvisioningSession, ProvisioningStatus
from app.core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


class RouterStatusResponse(BaseModel):
    """Response model for router status."""
    id: int
    name: str
    ip_address: str
    port: Optional[int]
    hostname: Optional[str]
    provisioning_status: str
    bootstrap_completed: bool
    hotspot_interface: Optional[str]
    pppoe_interface: Optional[str]
    wireguard_enabled: bool
    wireguard_tunnel_ip: Optional[str]
    routeros_version: Optional[str]
    system_info: Optional[Dict[str, Any]]
    last_seen: Optional[datetime]
    connectivity_status: Dict[str, Any]
    configured_services: List[str]
    active_sessions: List[Dict[str, Any]]


class RouterConfigurationResponse(BaseModel):
    """Response model for router configuration."""
    router_id: int
    configuration: Dict[str, Any]
    services: Dict[str, Any]
    network_config: Dict[str, Any]
    system_info: Dict[str, Any]


class RouterActionResponse(BaseModel):
    """Response model for router action results."""
    success: bool
    message: str
    action: str
    timestamp: datetime
    session_id: Optional[str] = None
    result_data: Optional[Dict[str, Any]] = None


@router.get("/routers/{router_id}/status", response_model=RouterStatusResponse)
async def get_router_status(
    router_id: int,
    db: AsyncSession = Depends(get_db),
) -> RouterStatusResponse:
    """Get detailed status of a router.
    
    Args:
        router_id: Router ID
        
    Returns:
        Router status information including connectivity and services
    """
    try:
        # Get router from database
        result = await db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            raise HTTPException(status_code=404, detail="Router not found")
        
        # Get provisioning sessions for this router
        sessions_result = await db.execute(
            select(ProvisioningSession).where(ProvisioningSession.router_id == router_id)
        )
        sessions = sessions_result.scalars().all()
        
        # Check router connectivity
        from app.services.enhanced_verification import EnhancedVerificationService
        verification_service = EnhancedVerificationService(db)
        connectivity_status = await verification_service._verify_router_connectivity(router)
        
        # Determine configured services
        configured_services = router.get_configured_services()
        
        # Get active provisioning sessions
        active_sessions = []
        for session in sessions:
            if session.status in [ProvisioningStatus.PENDING, ProvisioningStatus.IN_PROGRESS]:
                active_sessions.append({
                    'session_id': session.session_id,
                    'status': session.status,
                    'service_type': session.service_type,
                    'started_at': session.created_at.isoformat(),
                    'current_step': session.current_step,
                    'progress': session.progress_percentage or 0
                })
        
        return RouterStatusResponse(
            id=router.id,
            name=router.name,
            ip_address=router.ip_address,
            port=router.port,
            hostname=router.hostname,
            provisioning_status=router.provisioning_status,
            bootstrap_completed=router.bootstrap_completed,
            hotspot_interface=router.hotspot_interface,
            pppoe_interface=router.pppoe_interface,
            wireguard_enabled=router.wireguard_enabled or False,
            wireguard_tunnel_ip=router.vpn_address,
            routeros_version=router.routeros_version,
            system_info=router.config.get('system_info') if router.config else None,
            last_seen=router.last_seen,
            connectivity_status=connectivity_status,
            configured_services=configured_services,
            active_sessions=active_sessions
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get router status for {router_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get router status: {str(e)}")


@router.get("/routers/{router_id}/configuration", response_model=RouterConfigurationResponse)
async def get_router_configuration(
    router_id: int,
    db: AsyncSession = Depends(get_db),
) -> RouterConfigurationResponse:
    """Get detailed configuration of a router.
    
    Args:
        router_id: Router ID
        
    Returns:
        Router configuration information
    """
    try:
        # Get router from database
        result = await db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            raise HTTPException(status_code=404, detail="Router not found")
        
        # Parse configuration from router config field
        configuration = {}
        services = {}
        network_config = {}
        system_info = {}
        
        if router.config:
            try:
                import json
                config_data = json.loads(router.config) if isinstance(router.config, str) else router.config
                
                configuration = config_data.get('configuration', {})
                services = config_data.get('services', {})
                network_config = config_data.get('network_config', {})
                system_info = config_data.get('system_info', {})
            except (json.JSONDecodeError, TypeError):
                logger.warning(f"Could not parse configuration for router {router_id}")
        
        return RouterConfigurationResponse(
            router_id=router.id,
            configuration=configuration,
            services=services,
            network_config=network_config,
            system_info=system_info
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get router configuration for {router_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get router configuration: {str(e)}")


@router.post("/routers/{router_id}/actions/{action}", response_model=RouterActionResponse)
async def execute_router_action(
    action: str,
    router_id: int,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
) -> RouterActionResponse:
    """Execute an administrative action on a router.
    
    Args:
        action: Action to perform (reboot, reset, scan, etc.)
        router_id: Router ID
        
    Returns:
        Action execution result
    """
    try:
        # Get router from database
        result = await db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            raise HTTPException(status_code=404, detail="Router not found")
        
        # Validate action
        valid_actions = ['reboot', 'reset', 'scan', 'backup', 'upgrade']
        if action not in valid_actions:
            raise HTTPException(status_code=400, detail=f"Invalid action: {action}. Valid actions: {valid_actions}")
        
        # Execute action in background
        background_tasks.add_task(
            _execute_router_action_async,
            router_id,
            action,
            db
        )
        
        return RouterActionResponse(
            success=True,
            message=f"Router action '{action}' initiated successfully",
            action=action,
            timestamp=datetime.utcnow(),
            session_id=None,
            result_data=None
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to execute action {action} on router {router_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to execute action: {str(e)}")


@router.get("/routers/{router_id}/history")
async def get_router_history(
    router_id: int,
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    """Get provisioning history for a router.
    
    Args:
        router_id: Router ID
        limit: Maximum number of history items to return
        
    Returns:
        Provisioning history for the router
    """
    try:
        # Get provisioning sessions for this router
        from sqlalchemy import desc
        from app.models.provisioning import ProvisioningSession
        
        result = await db.execute(
            select(ProvisioningSession)
            .where(ProvisioningSession.router_id == router_id)
            .order_by(desc(ProvisioningSession.created_at))
            .limit(limit)
        )
        sessions = result.scalars().all()
        
        history = []
        for session in sessions:
            history.append({
                'session_id': session.session_id,
                'service_type': session.service_type,
                'status': session.status,
                'started_at': session.created_at.isoformat(),
                'completed_at': session.completed_at.isoformat() if session.completed_at else None,
                'error_message': session.error_message,
                'progress': session.progress_percentage or 0,
                'configuration': session.configuration
            })
        
        return {'history': history, 'total': len(history)}
        
    except Exception as e:
        logger.error(f"Failed to get router history for {router_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get router history: {str(e)}")


async def _execute_router_action_async(
    router_id: int,
    action: str,
    db: AsyncSession
):
    """Execute router action asynchronously.
    
    Args:
        router_id: Router ID
        action: Action to perform
        db: Database session
    """
    try:
        # Get router from database
        result = await db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            logger.error(f"Router {router_id} not found for action {action}")
            return
        
        # Get credentials
        from app.core.encryption import get_credential_encryption
        
        if router.api_credentials_encrypted:
            encryption = get_credential_encryption()
            try:
                credentials = encryption.decrypt_credentials(router.api_credentials_encrypted)
                username = credentials['username']
                password = credentials['password']
                
                # Execute action via MikroTik API
                from app.integrations.mikrotik import MikroTikClient
                client = MikroTikClient()
                
                await client.connect(
                    ip_address=router.ip_address,
                    username=username,
                    password=password,
                    port=router.port or 8728,
                )
                
                # Execute action
                if action == 'reboot':
                    await client.execute_command('/system reboot')
                elif action == 'reset':
                    await client.execute_command('/system reset')
                elif action == 'scan':
                    await client.execute_command('/system routerboard configuration print')
                elif action == 'backup':
                    await client.execute_command('/system backup save name=kilo_backup')
                elif action == 'upgrade':
                    # Handle firmware upgrade if needed
                    pass
                
                await client.disconnect(router.ip_address, router.port or 8728)
                
                logger.info(f"Successfully executed action {action} on router {router_id}")
                
            except Exception as e:
                logger.error(f"Failed to execute action {action} on router {router_id}: {str(e)}")
        else:
            logger.warning(f"No credentials available for router {router_id} - action {action} skipped")
        
    except Exception as e:
        logger.error(f"Error executing action {action} on router {router_id}: {str(e)}")