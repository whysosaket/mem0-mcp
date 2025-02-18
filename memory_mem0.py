from typing import Any
import httpx
import os
from mcp.server.fastmcp import FastMCP
from mem0 import MemoryClient


mem0_api_key = os.getenv("MEM0_API_KEY")

# Initialize FastMCP server
mcp = FastMCP("memory_mem0")
memory_client = MemoryClient(api_key=mem0_api_key)

@mcp.tool()
def add_memory(memory: str, user_id: str) -> str:
    """
    Add a memory entry with the provided memory and user id.

    Args:
        memory: Memory to store.
        user_id: User ID associated with the memory.

    Returns:
        A confirmation message.
    """
    memory_client.add(memory, user_id=user_id)
    return f"Memory stored: '{memory}'"


@mcp.tool()
def retrieve_memory(query: str, user_id: str) -> str:
    """
    Retrieve the memory stored for the given query and user.

    Args:
        query: The query to search for.
        user_id: The user ID associated with the memory.

    Returns:
        The stored memory or a message indicating that no memory was found.
    """
    return memory_client.search(query, user_id=user_id)


if __name__ == "__main__":
    # Initialize and run the server
    mcp.run(transport='stdio')