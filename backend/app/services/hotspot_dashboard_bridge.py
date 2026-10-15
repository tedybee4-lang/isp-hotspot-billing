"""
HotSpot dashboard bridge service.

This service provides the backend functionality needed for the HotSpot dashboard,
including session management, service status verification, and dashboard updates.
"""
import logging
from typing import Dict, List, Optional, Any
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.router import Router
from app.models.provisioning import ProvisioningSession, ProvisioningStatus
from app.core.config import settings

logger = logging.getLogger(__name__)


class HotSpotDashboardBridge:
    """Bridge service for HotSpot dashboard functionality."""
    
    def __init__(self, db: AsyncSession):
        self.db = db
    
    async def get_hotspot_dashboard_data(
        self,
        router_id: int,
        session_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Get HotSpot dashboard data for a router.
        
        Args:
            router_id: Router ID
            session_id: Optional provisioning session ID
            
        Returns:
            HotSpot dashboard data
        """
        router = await self._get_router(router_id)
        
        # Get provisioning sessions
        sessions = await self._get_provisioning_sessions(router_id)
        
        # Get session-specific data if session_id provided
        session_data = None
        if session_id:
            session_data = await self._get_session_data(session_id)
        
        # Build dashboard data
        dashboard_data = {
            'router': {
                'id': router.id,
                'name': router.name,
                'ip_address': router.ip_address,
                'hostname': router.hostname,
                'provisioning_status': router.provisioning_status,
                'bootstrap_completed': router.bootstrap_completed,
                'hotspot_interface': router.hotspot_interface,
                'routeros_version': router.routeros_version,
                'last_seen': router.last_seen
            },
            'sessions': sessions,
            'current_session': session_data,
            'services': {
                'hotspot': {
                    'configured': router.hotspot_interface is not None,
                    'interface': router.hotspot_interface,
                    'status': self._get_hotspot_status(router)
                }
            },
            'timestamp': datetime.utcnow().isoformat()
        }
        
        return dashboard_data
    
    async def get_hotspot_service_status(
        self,
        router_id: int
    ) -> Dict[str, Any]:
        """Get HotSpot service status for a router.
        
        Args:
            router_id: Router ID
            
        Returns:
            HotSpot service status
        """
        router = await self._get_router(router_id)
        
        # Verify HotSpot configuration
        verification = await self._verify_hotspot_configuration(router)
        
        status = {
            'service': 'hotspot',
            'configured': verification['success'],
            'interface': router.hotspot_interface,
            'verification': verification,
            'last_check': datetime.utcnow().isoformat()
        }
        
        return status
    
    async def update_hotspot_configuration(
        self,
        router_id: int,
        configuration: Dict[str, Any]
    ) -> Router:
        """Update HotSpot configuration for a router.
        
        Args:
            router_id: Router ID
            configuration: HotSpot configuration
            
        Returns:
            Updated router instance
        """
        router = await self._get_router(router_id)
        
        # Validate configuration
        if not configuration.get('interface'):
            raise ValueError('HotSpot interface is required')
        
        # Update router HotSpot interface
        router.hotspot_interface = configuration['interface']
        
        # Update provisioning status
        router.provisioning_status = 'configuring'
        
        await self.db.commit()
        await self.db.refresh(router)
        
        logger.info(f"Updated HotSpot configuration for router {router_id}")
        
        return router
    
    def _get_router(self, router_id: int) -> Router:
        """Get router by ID."""
        result = await self.db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            raise ValueError(f"Router {router_id} not found")
            
        return router
    
    async def _get_provisioning_sessions(self, router_id: int) -> List[Dict[str, Any]]:
        """Get provisioning sessions for a router.
        
        Args:
            router_id: Router ID
            
        Returns:
            List of provisioning sessions
        """
        result = await self.db.execute(
            select(ProvisioningSession)
            .where(ProvisioningSession.router_id == router_id)
        )
        sessions = result.scalars().all()
        
        return [
            {
                'session_id': session.session_id,
                'service_type': session.service_type,
                'status': session.status,
                'current_step': session.current_step,
                'progress': session.progress_percentage or 0,
                'started_at': session.created_at.isoformat(),
                'completed_at': session.completed_at.isoformat() if session.completed_at else None
            }
            for session in sessions
        ]
    
    async def _get_session_data(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get provisioning session data.
        
        Args:
            session_id: Provisioning session ID
            
        Returns:
            Session data or None if not found
        """
        result = await self.db.execute(
            select(ProvisioningSession)
            .where(ProvisioningSession.session_id == session_id)
        )
        session = result.scalar_one_or_none()
        
        if not session:
            return None
        
        return {
            'session_id': session.session_id,
            'router_id': session.router_id,
            'service_type': session.service_type,
            'status': session.status,
            'current_step': session.current_step,
            'progress': session.progress_percentage or 0,
            'configuration': session.configuration,
            'started_at': session.created_at.isoformat(),
            'completed_at': session.completed_at.isoformat() if session.completed_at else None
        }
    
    def _get_hotspot_status(self, router: Router) -> str:
        """Get HotSpot service status.
        
        Args:
            router: Router instance
            
        Returns:
            HotSpot service status
        """
        if not router.hotspot_interface:
            return 'not_configured'
        
        if router.provisioning_status == 'provisioned':
            return 'configured'
        elif router.provisioning_status == 'provisioning':
            return 'provisioning'
        elif router.provisioning_status == 'failed':
            return 'failed'
        else:
            return 'pending'
    
    async def _verify_hotspot_configuration(self, router: Router) -> Dict[str, Any]:
        """Verify HotSpot configuration.
        
        Args:
            router: Router instance
            
        Returns:
            Verification result
        """
        try:
            # Check if HotSpot interface exists
            interface_exists = router.hotspot_interface is not None
            
            # Check if provisioning is complete
            provisioning_complete = router.provisioning_status == 'provisioned'
            
            # Check if credentials are available
            credentials_available = router.api_credentials_encrypted is not None
            
            return {
                'success': interface_exists and provisioning_complete and credentials_available,
                'interface_exists': interface_exists,
                'provisioning_complete': provisioning_complete,
                'credentials_available': credentials_available,
                'error': None if (interface_exists and provisioning_complete and credentials_available) else 'HotSpot not properly configured'
            }
            
        except Exception as e:
            logger.warning(f"HotSpot configuration verification failed for router {router.id}: {str(e)}")
            return {
                'success': False,
                'interface_exists': False,
                'provisioning_complete': False,
                'credentials_available': False,
                'error': str(e)
            }


# Global instance for use throughout the application
async def get_hotspot_dashboard_bridge(db: AsyncSession) -> HotSpotDashboardBridge:
    """Get HotSpot dashboard bridge instance.
    
    Args:
        db: Database session
        
    Returns:
        HotSpotDashboardBridge instance
    """
    return HotSpotDashboardBridge(db)