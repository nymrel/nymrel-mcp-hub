"""
Python type definitions for Model Context Protocol
"""

from typing import Dict, Any, List, Optional, Union
from dataclasses import dataclass

@dataclass
class ToolDefinition:
    name: str
    description: str
    input_schema: Dict[str, Any]

@dataclass
class ResourceDefinition:
    uri: str
    name: str
    mime_type: str
    description: str

@dataclass
class PromptDefinition:
    name: str
    description: str
    arguments: Optional[List[Dict[str, Any]]] = None
