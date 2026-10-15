"""
Router provisioning configuration service.

This service handles the configuration of routers with HotSpot, PPPoE, and WireGuard services,
including interface assignment, IP addressing, network configuration, and service activation.
"""
import logging
from typing import Dict, List, Optional, Any
from datetime import datetime
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.router import Router
from app.core.encryption import get_credential_encryption
from app.core.config import settings

logger = logging.getLogger(__name__)


class RouterProvisioningService:
    """Service for provisioning and configuring MikroTik routers."""
    
    def __init__(self, db: AsyncSession):
        self.db = db
    
    async def create_provisioning_session(
        self,
        router_id: int,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Create a provisioning session and start configuration.
        
        Args:
            router_id: Router ID
            service_type: 'hotspot', 'pppoe_server', or 'both'
            configuration: Initial configuration
            
        Returns:
            Provisioning session information
        """
        router = await self._get_router(router_id)
        
        # Create provisioning session
        session_id = f"prov_{router_id}_{datetime.utcnow().timestamp()}"
        
        # Initialize session state
        session_state = {
            'session_id': session_id,
            'router_id': router_id,
            'service_type': service_type,
            'status': 'starting',
            'current_step': 'initializing',
            'progress': 0,
            'configuration': configuration,
            'started_at': datetime.utcnow().isoformat(),
            'steps': [],
            'errors': [],
            'warnings': []
        }
        
        # Store session state in router config
        await self._store_session_state(router, session_state)
        
        logger.info(f"Created provisioning session {session_id} for router {router_id}")
        
        return {
            'session_id': session_id,
            'status': 'starting',
            'message': 'Provisioning session created successfully',
            'router_id': router_id,
            'service_type': service_type
        }
    
    async def configure_router_services(
        self,
        session_id: str,
        service_type: str,
        configuration: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Configure router services for a provisioning session.
        
        Args:
            session_id: Provisioning session ID
            service_type: 'hotspot', 'pppoe_server', or 'both'
            configuration: Configuration
            
        Returns:
            Configuration result
        """
        # Get session state
        session_state = await self._get_session_state(session_id)
        
        if not session_state:
            raise ValueError(f"Session {session_id} not found")
        
        try:
            # Configure services based on type
            if service_type in ('hotspot', 'both'):
                await self._configure_hotspot_service(session_state, configuration)
            
            if service_type in ('pppoe_server', 'both'):
                await self._configure_pppoe_service(session_state, configuration)
            
            if service_type == 'hotspot' or (service_type == 'both' and configuration.get('enable_wireguard', False)):
                await self._configure_wireguard_service(session_state, configuration)
            
            # Update session state
            session_state['status'] = 'completed'
            session_state['completed_at'] = datetime.utcnow().isoformat()
            session_state['progress'] = 100
            
            # Update router
            router = await self._get_router(session_state['router_id'])
            await self._update_router_configuration(router, session_state)
            
            logger.info(f"Completed configuration for session {session_id}")
            
            return {
                'success': True,
                'session_id': session_id,
                'status': 'completed',
                'message': 'Router configuration completed successfully',
                'completed_at': session_state['completed_at']
            }
            
        except Exception as e:
            session_state['status'] = 'failed'
            session_state['errors'].append(str(e))
            session_state['failed_at'] = datetime.utcnow().isoformat()
            
            logger.error(f"Configuration failed for session {session_id}: {str(e)}")
            
            return {
                'success': False,
                'session_id': session_id,
                'status': 'failed',
                'error': str(e),
                'failed_at': session_state['failed_at']
            }
    
    async def _get_router(self, router_id: int) -> Router:
        """Get router by ID."""
        result = await self.db.execute(select(Router).where(Router.id == router_id))
        router = result.scalar_one_or_none()
        
        if not router:
            raise ValueError(f"Router {router_id} not found")
            
        return router
    
    async def _get_session_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get session state by ID.
        
        Args:
            session_id: Provisioning session ID
            
        Returns:
            Session state or None if not found
        """
        # In a real implementation, this would query the database
        # For this demo, we'll store session state in the router's config field
        result = await self.db.execute(select(Router).where(Router.session_id == session_id))
        router = result.scalar_one_or_none()
        
        if not router or not router.config:
            return None
        
        try:
            import json
            config = json.loads(router.config) if isinstance(router.config, str) else router.config
            return config.get('provisioning_session')
        except (json.JSONDecodeError, TypeError):
            return None
    
    async def _store_session_state(self, router: Router, session_state: Dict[str, Any]) -> None:
        """Store session state in router config.
        
        Args:
            router: Router instance
            session_state: Session state
        """
        import json
        
        # Get existing config
        existing_config = {}
        if router.config:
            try:
                existing_config = json.loads(router.config) if isinstance(router.config, str) else router.config
            except (json.JSONDecodeError, TypeError):
                existing_config = {}
        
        # Store session state
        existing_config['provisioning_session'] = session_state
        
        # Update router
        router.config = json.dumps(existing_config)
        
        await self.db.commit()
        await self.db.refresh(router)
    
    async def _configure_hotspot_service(
        self,
        session_state: Dict[str, Any],
        configuration: Dict[str, Any]
    ) -> None:
        """Configure HotSpot service.
        
        Args:
            session_state: Provisioning session state
            configuration: Configuration
        """
        router_id = session_state['router_id']
        router = await self._get_router(router_id)
        
        # Get HotSpot configuration
        hotspot_config = configuration.get('hotspot_config', {})
        
        # Build HotSpot configuration commands
        commands = self._build_hotspot_commands(router, hotspot_config)
        
        # Apply configuration
        await self._apply_router_commands(router, commands)
        
        # Update session state
        session_state['steps'].append({
            'step': 'hotspot_configuration',
            'status': 'completed',
            'commands': commands,
            'timestamp': datetime.utcnow().isoformat()
        })
        
        # Update router
        if hotspot_config.get('interface'):
            router.hotspot_interface = hotspot_config['interface']
    
    async def _configure_pppoe_service(
        self,
        session_state: Dict[str, Any],
        configuration: Dict[str, Any]
    ) -> None:
        """Configure PPPoE service.
        
        Args:
            session_state: Provisioning session state
            configuration: Configuration
        """
        router_id = session_state['router_id']
        router = await self._get_router(router_id)
        
        # Get PPPoE configuration
        pppoe_config = configuration.get('pppoe_config', {})
        
        # Build PPPoE configuration commands
        commands = self._build_pppoe_commands(router, pppoe_config)
        
        # Apply configuration
        await self._apply_router_commands(router, commands)
        
        # Update session state
        session_state['steps'].append({
            'step': 'pppoe_configuration',
            'status': 'completed',
            'commands': commands,
            'timestamp': datetime.utcnow().isoformat()
        })
        
        # Update router
        if pppoe_config.get('interface'):
            router.pppoe_interface = pppoe_config['interface']
    
    async def _configure_wireguard_service(
        self,
        session_state: Dict[str, Any],
        configuration: Dict[str, Any]
    ) -> None:
        """Configure WireGuard service.
        
        Args:
            session_state: Provisioning session state
            configuration: Configuration
        """
        router_id = session_state['router_id']
        router = await self._get_router(router_id)
        
        # Get WireGuard configuration
        wireguard_config�าด� = configuration.get('wireguard_config', {})
        
        # Build WireGuard configuration commands
        commands = self._build_wireguard_commands(router, wireguard_config)
        
        # Apply configuration
        await self._apply_router_commands(router, commands)
        
        # Update session state
        session_state['steps'].append({
            'step': 'wireguard_configuration',
            'status': 'completed',
            'commands': commands,
            'timestamp': datetime.utcnow().isoformat()
        })
        
        # Update router
        router.wireguard_enabled = True
        router.vpn_address = wireguard_config.get('tunnel_ip')
    
    def _build_hotspot_commands(self, router: Router, config: Dict[str, Any]) -> List[str]:
        """Build HotSpot configuration commands.
        
        Args:
            router: Router instance
            config: HotSpot configuration
            
        Returns:
            List of commands
        """
        commands = [
            f"# HotSpot Setup - {datetime.utcnow().isoformat()}",
            f"/ip hotspot setup",
            f"\tinterface={config.get('interface', 'ether2')}",
            f"\tserver-address={config.get('server_address', '192.168.100.1')}",
            f"\taddress-list={config.get('address_list', 'hotspot-clients')}",
            f"\tradius={config.get('radius_server', '')}",
            f"\tauth-type={config.get('auth_type', 'pap')}",
            f"\trate-limit={config.get('rate_limit', '')}",
            f"\tdns-server={config.get('dns_server', '8.8.8.8')}",
            f"\tnat={config.get('nat', 'yes')}",
        ]
        
        return commands
    
    def _build_pppoe_commands(self, router: Router, config: Dict[str, Any]) -> List[str]:
        """Build PPPoE configuration commands.
        
        Args:
            router: Router instance
            config: PPPoE configuration
            
        Returns:
            Listائج of commands
        """
        commands = [
            f"# PPPoE Server Setup - {datetime.utcnow().isoformat()}",
            f"/interface pppoe-server",
            f"\tadd name=PPPoE-Out interface={config.get('interface', 'ether3')}",
            f"\t\tauthentication={config.get('authentication', 'pap')}",
            f"\t\tradius={config.get('radius_server', '')}",
        ]
        
        return commands
    
    def _build_wireguard_commands(self, router: Router, config: Dict[str, Any]) -> List[str]:
        """Build WireGuard configuration commands.
        
        Args:
            router: Router instance
            config: WireGuard configuration
            
        Returns:
            List of commands
        """
        commands = [
            f"# WireGuard Setup - {datetime.utcnow().isoformat()}",
            f"/interface wireguard",
            f"\tadd name=ISP-Tunnel ip-address={config.get('tunnel_ip', '10.0.0.1/24')}",
            f"\t\tpeer=ISP-Server",
        ]
        
        return commands
    
    async def _apply_router_commands(self, router: Router, commands: List[str]) -> None:
        """Apply commands to router.
        
        Args:
            router: Router instance
            commands: List of commands
        """
        try:
            # Get router credentials
            credentials = await self._get_router_credentials(router)
            
            if not credentials:
                raise Exception("No credentials available for router configuration")
            
            # Apply commands (simplified for demo)
            logger.info(f"Would apply {len(commands)} commands to router {router.id}")
            
        except Exception as e:
            logger.error(f"Failed to apply commands to router {router.id}: {str(e)}")
            raise
    
    async def _get_router_credentials(self, router: Router) -> Optional[Dict[str, str]]:
        """Get router credentials.
        
        Args:
            router: Router instance
            
        Returns:
            Credentials or None
        """
        from app.core.encryption import get_credential_encryption
        
        # Try to get from encrypted storage first
        if router.api_credentials_encrypted:
            encryption = get_credential_encryption()
            try:
                credentials = encryption.decrypt_credentials(router.api_credentials_encrypted)
                return credentials
            except Exception as e:
                logger.error(f"Failed to decrypt credentials for router {router.id}: {e}")
        
        # Fallback to default credentials
        logger.info(f"Using default credentials for router {router.id}")
        return {
            'username': settings.mikrotik_api_username,
            'password': settings.mikrotik_api_password
        }
    
    async def _update_router_configuration(self, router: Router, session_state: Dict[str, Any]) -> None:
        """Update router configuration based on session state.
        
        Args:
            router: Router instance
            session_state: Provisioning session state
        """
        # Update router provisioning status
        router.provisioning_status = 'provisioned'
        router.bootstrap_completed = True
        router.last_provisioned_at = datetime.utcnow()
        
        # Store session state in router config
        import json
        existing_config = {}
        if router.config:
            try:
                existing_config = json.loads(router.config) if isinstance(router.config, str) else router.config
            except (json.JSONDecodeError, TypeError):
                existing_config = {}
        
        existing_config['provisioning_session'] = session_state
        router.config = json.dumps(existing_config)
        
        await self.db.commit()
        await self.db.refresh(router)
        
        logger.info(f"Updated router {router.id} configuration based on provisioning session")


# Global instance for use throughout the application
async def get_router_provisioning_service(db: AsyncSession) -> RouterProvisioningService:
    """Get router provisioning service instance.
    
    Args:
        db: Database session
        
    Returns:
        RouterProvisioningService instance
    """
    return RouterProvisioningService(db)