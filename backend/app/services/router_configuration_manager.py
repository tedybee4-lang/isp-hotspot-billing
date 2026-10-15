"""
Router configuration management service for provisioning workflows.

This service provides comprehensive router configuration management including
provisioning steps, configuration validation, and workflow coordination.
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


class RouterConfigurationManager:
    """Service for managing router configuration during provisioning workflows."""
    
    def __init__(self, db: AsyncSession):
        self.db = db
    
    async def create_provisioning_workflow(
        self,
        router_id: int,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> ProvisioningSession:
        """Create and start a provisioning workflow for a router.
        
        Args:
            router_id: Router ID
            service_type: 'hotspot', 'pppoe_server', or 'both'
            configuration: Initial configuration
            
        Returns:
            Created provisioning session
        """
        router = await self._get_router(router_id)
        
        # Create provisioning session
        session = await self._create_provisioning_session(router_id, service_type, configuration)
        
        # Start the provisioning workflow
        await self._start_provisioning_workflow(session, service_type, configuration)
        
        return session
    
    async def _get_router(self, router_id: int) -> Router:
        """Get router by ID."""
        result = await self.db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            raise ValueError(f"Router {router_id} not found")
            
        return router
    
    async def _create_provisioning_session(
        self,
        router_id: int,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> ProvisioningSession:
        """Create a provisioning session.
        
        Args:
            router_id: Router ID
            service_type: Service type
            configuration: Configuration
            
        Returns:
            Created provisioning session
        """
        from app.modules.provisioning import ProvisioningService
        from app.models.provisioning import ServiceType
        
        provisioning_service = ProvisioningService(self.db)
        
        session = await provisioning_service.create_provisioning_session(
            router_id=router_id,
            user_id=1,  # Default user for public provisioning
            service_type=ServiceType(service_type),
            configuration=configuration
        )
        
        return session
    
    async def _start_provisioning_workflow(
        self,
        session: ProvisioningSession,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> None:
        """Start the provisioning workflow.
        
        Args:
            session: Provisioning session
            service_type: Service type
            configuration: Configuration
        """
        # Create background tasks for provisioning steps
        from fastapi import BackgroundTasks
        
        background_tasks = BackgroundTasks()
        
        # Add provisioning tasks
        background_tasks.add_task(
            self._execute_provisioning_steps,
            session.session_id,
            service_type,
            configuration
        )
        
        # Note: In a real implementation, you would use FastAPI's background tasks
        # This is a simplified version for demonstration
        
        logger.info(f"Started provisioning workflow for session {session.session_id}")
    
    async def _execute_provisioning_steps(
        self,
        session_id: str,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> None:
        """Execute provisioning steps for a session.
        
        Args:
            session_id: Provisioning session ID
            service_type: Service type
            configuration: Configuration
        """
        try:
            # Get session
            result = await self.db.execute(
                select(ProvisioningSession).where(ProvisioningSession.session_id == session_id)
            )
            session = result.scalar_one_or_none()
            
            if not session:
                logger.error(f"Session {session_id} not found")
                return
            
            # Get router
            router = await self._get_router(session.router_id)
            
            # Execute provisioning based on service type
            if service_type in ('hotspot', 'both'):
                await self._execute_hotspot_provisioning(session, router, configuration)
            
            if service_type in ('pppoe_server', 'both'):
                await self._execute_pppoe_provisioning(session, router, configuration)
            
            # Mark session as completed
            session.status = ProvisioningStatus.COMPLETED
            session.progress_percentage = 100
            session.completed_at = datetime.utcnow()
            
            await self.db.commit()
            
            logger.info(f"Completed provisioning workflow for session {session_id}")
            
        except Exception as e:
            logger.error(f"Provisioning workflow failed for session {session_id}: {str(e)}")
            
            # Mark session as failed
            try:
                result = await self.db.execute(
                    select(ProvisioningSession).where(ProvisioningSession.session_id == session_id)
                )
                failed_session = result.scalar_one_or_none()
                
                if failed_session:
                    failed_session.status = ProvisioningStatus.FAILED
                    failed_session.error_message = str(e)
                    await self.db.commit()
            except Exception as rollback_error:
                logger.error(f"Failed to rollback session {session_id}: {str(rollback_error)}")
    
    async def _execute_hotspot_provisioning(
        self,
        session: ProvisioningSession,
        router: Router,
        configuration: Dict[str, Any]
    ) -> None:
        """Execute HotSpot provisioning steps.
        
        Args:
            session: Provisioning session
            router: Router instance
            configuration: Configuration
        """
        # Get HotSpot configuration
        hotspot_config = configuration.get('hotspot_config', {})
        
        # Configure HotSpot using router configuration service
        from app.services.router_configuration import RouterConfigurationService
        config_service = RouterConfigurationService(self.db)
        
        await config_service._configure_hotspot(router, hotspot_config)
        
        # Update session
        session.current_step = 'hotspot'
        session.progress_percentage = 50
        
        await self.db.commit()
        
        logger.info(f"HotSpot provisioning completed for session {session.session_id}")
    
    async def _execute_pppoe_provisioning(
        self,
        session: ProvisioningSession,
        router: Router,
        configuration: Dict[str, Any]
    ) -> None:
        """Execute PPPoE provisioning steps.
        
        Args:
            session: Provisioning session
            router: Router instance
            configuration: Configuration
        """
        # Get PPPoE configuration
        pppoe_config = configuration.get('pppoe_config', {})
        
        # Configure PPPoE using router configuration service
        from app.services.router_configuration import RouterConfigurationService
        config_service = RouterConfigurationService(self.db)
        
        await config_service._configure_pppoe(router, pppoe_config)
        
        # Update session
        session.current_step = 'pppoe'
        session.progress_percentage = 75
        
        await self.db.commit()
        
        logger.info(f"PPPoE provisioning completed for session {session.session_id}")
    
    async def get_provisioning_steps(
        self,
        session_id: str
    ) -> List[Dict[str, Any]]:
        """Get provisioning steps for a session.
        
        Args:
            session_id: Provisioning session ID
            
        Returns:
            List of provisioning steps
        """
        result = await self.db.execute(
            select(ProvisioningSession).where(ProvisioningSession.session_id == session_id)
        )
        session = result.scalar_one_or_none()
        
        if not session:
            raise ValueError(f"Session {session_id} not found")
        
        steps = []
        
        # Add step for session creation
        steps.append({
            'step': 'session_creation',
            'name': 'Session Creation',
            'status': 'completed',
            'started_at': session.created_at.isoformat(),
            'completed_at': session.created_at.isoformat(),
            'details': f'Provisioning session {session_id} created'
        })
        
        # Add step for HotSpot provisioning (if applicable)
        if session.service_type in ('hotspot', 'both'):
            steps.append({
                'step': 'hotspot_provisioning',
                'name': 'HotSpot Configuration',
                'status': 'completed',
                'started_at': session.created_at.isoformat(),
                'completed_at': None,
                'details': 'HotSpot service configuration'
            })
        
        # Add step for PPPoE provisioning (if applicable)
        if session.service_type in ('pppoe_server', 'both'):
            steps.append({
                'step': 'pppoe_provisioning',
                'name': 'PPPoE Configuration',
                'status': 'completed',
                'started_at': session.created_at.isoformat(),
                'completed_at': None,
                'details': 'PPPoE server configuration'
            })
        
        return steps


# Global instance for use throughout the application
async def get_router_configuration_manager(db: AsyncSession) -> RouterConfigurationManager:
    """Get router configuration manager instance.
    
    Args:
        db: Database session
        
    Returns:
        RouterConfigurationManager instance
    """
    return RouterConfigurationManager(db)