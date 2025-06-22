#!/usr/bin/env node

import express from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  Tool,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryClient } from 'mem0ai';
import dotenv from 'dotenv';

dotenv.config();

const MEM0_API_KEY = process?.env?.MEM0_API_KEY || '';

// Initialize mem0ai client
const memoryClient = new MemoryClient({ apiKey: MEM0_API_KEY });

// Tool definitions
const ADD_MEMORY_TOOL: Tool = {
  name: 'add-memory',
  description:
    'Add a new memory. This method is called everytime the user informs anything about themselves, their preferences, or anything that has any relevent information whcih can be useful in the future conversation. This can also be called when the user asks you to remember something.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The content to store in memory',
      },
      userId: {
        type: 'string',
        description: "User ID for memory storage. If not provided explicitly, use a generic user ID like, 'mem0-mcp-user'",
      },
    },
    required: ['content', 'userId'],
  },
};

const SEARCH_MEMORIES_TOOL: Tool = {
  name: 'search-memories',
  description: 'Search through stored memories. This method is called ANYTIME the user asks anything.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: "The search query. This is the query that the user has asked for. Example: 'What did I tell you about the weather last week?' or 'What did I tell you about my friend John?'",
      },
      userId: {
        type: 'string',
        description: "User ID for memory storage. If not provided explicitly, use a generic user ID like, 'mem0-mcp-user'",
      },
    },
    required: ['query', 'userId'],
  },
};

// Create server instance factory
const createServer = () => {
  const server = new Server(
    {
      name: 'mem0-mcp',
      version: '0.0.1',
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    }
  );

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [ADD_MEMORY_TOOL, SEARCH_MEMORIES_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      
      if (!args) {
        throw new Error('No arguments provided');
      }
      
      switch (name) {
        case 'add-memory': {
          const { content, userId } = args as { content: string, userId: string };
          await addMemory(content, userId);
          return {
            content: [
              {
                type: 'text',
                text: 'Memory added successfully',
              },
            ],
            isError: false,
          };
        }
        
        case 'search-memories': {
          const { query, userId } = args as { query: string, userId: string };
          const results = await searchMemories(query, userId);
          const formattedResults = results.map((result: any) => 
            `Memory: ${result.memory}\nRelevance: ${result.score}\n---`
          ).join('\n');
          
          return {
            content: [
              {
                type: 'text',
                text: formattedResults || 'No memories found',
              },
            ],
            isError: false,
          };
        }
        
        default:
          return {
            content: [
              { type: 'text', text: `Unknown tool: ${name}` },
            ],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
};

// Helper function to add memories
async function addMemory(content: string, userId: string) {
  try {
    const messages = [
      { role: 'system', content: 'Memory storage system' },
      { role: 'user', content }
    ] as any[];
    await memoryClient.add(messages, { user_id: userId });
    return true;
  } catch (error) {
    console.error('Error adding memory:', error);
    return false;
  }
}

// Helper function to search memories
async function searchMemories(query: string, userId: string) {
  try {
    const results = await memoryClient.search(query, { user_id: userId });
    return results;
  } catch (error) {
    console.error('Error searching memories:', error);
    return [];
  }
}



// Function to log safely
function safeLog(
  level: 'error' | 'debug' | 'info' | 'notice' | 'warning' | 'critical' | 'alert' | 'emergency',
  data: any
): void {
  // For stdio transport, log to stderr to avoid protocol interference
  console.error(`[${level}] ${typeof data === 'object' ? JSON.stringify(data) : data}`);
}

// Server startup
async function main() {
  try {
    const args = process.argv.slice(2);
    let host = '0.0.0.0';
    let port = 3000;

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--host' && i + 1 < args.length) {
        host = args[i + 1];
        i++;
      } else if (args[i] === '--port' && i + 1 < args.length) {
        port = parseInt(args[i + 1], 10);
        i++;
      }
    }

    console.error(`Initializing Mem0 Memory MCP Server on ${host}:${port}...`);
    
    const app = express();
    app.use(express.json());

    const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

    const mcpPostHandler = async (req: express.Request, res: express.Response) => {
      console.log('Received MCP request:', req.body);
      
      try {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
          transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sessionId: string) => {
              console.log(`Session initialized with ID: ${sessionId}`);
              transports[sessionId] = transport;
            }
          });

          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              console.log(`Transport closed for session ${sid}, removing from transports map`);
              delete transports[sid];
            }
          };

          const server = createServer();
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        } else {
          res.status(400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Bad Request: No valid session ID provided',
            },
            id: null,
          });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          });
        }
      }
    };

    const mcpGetHandler = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      const lastEventId = req.headers['last-event-id'] as string | undefined;
      if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
      } else {
        console.log(`Establishing new SSE stream for session ${sessionId}`);
      }

      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    };

    const mcpDeleteHandler = async (req: express.Request, res: express.Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      
      if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
      }

      console.log(`Received session termination request for session ${sessionId}`);
      
      try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error('Error handling session termination:', error);
        if (!res.headersSent) {
          res.status(500).send('Error processing session termination');
        }
      }
    };

    app.post('/mcp', mcpPostHandler);
    app.get('/mcp', mcpGetHandler);
    app.delete('/mcp', mcpDeleteHandler);

    app.listen(port, host, () => {
      console.log(`Mem0 Memory MCP Server listening on http://${host}:${port}/mcp`);
      safeLog('info', 'Mem0 Memory MCP Server initialized successfully');
    });

    process.on('SIGINT', async () => {
      console.log('Shutting down server...');
      for (const sessionId in transports) {
        try {
          console.log(`Closing transport for session ${sessionId}`);
          await transports[sessionId].close();
          delete transports[sessionId];
        } catch (error) {
          console.error(`Error closing transport for session ${sessionId}:`, error);
        }
      }
      console.log('Server shutdown complete');
      process.exit(0);
    });

  } catch (error) {
    console.error('Fatal error running server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
