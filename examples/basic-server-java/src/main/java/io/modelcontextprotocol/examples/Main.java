package io.modelcontextprotocol.examples;

import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.jackson2.JacksonMcpJsonMapperSupplier;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.spec.McpServerTransportProvider;
import io.modelcontextprotocol.server.transport.HttpServletSseServerTransportProvider;
import io.modelcontextprotocol.server.transport.StdioServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import org.eclipse.jetty.server.Server;

import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Minimal MCP App server in Java.
 *
 * Registers a "get-time" tool backed by an inline HTML UI (loaded from CDN).
 *
 * Run with HTTP transport (default, port 3001):
 *   java -jar basic-server-java.jar
 *
 * Run with stdio transport:
 *   java -jar basic-server-java.jar --stdio
 */
public class Main {

    static final String RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
    static final String RESOURCE_URI = "ui://get-time/index.html";

    // Inline HTML: loads @modelcontextprotocol/ext-apps from CDN, displays server time.
    static final String UI_HTML = """
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="color-scheme" content="light dark">
              <title>Get Time</title>
            </head>
            <body>
              <p><strong>Server time:</strong> <code id="time">—</code></p>
              <script type="module">
                import { App } from 'https://unpkg.com/@modelcontextprotocol/ext-apps@latest/dist/index.js';
                const app = new App({ name: 'get-time-app', version: '1.0.0' });
                app.ontoolinput = ({ toolInput }) => {
                  document.getElementById('time').textContent =
                    toolInput.structuredContent?.time ?? toolInput.content?.[0]?.text ?? '?';
                };
                app.connect();
              </script>
            </body>
            </html>
            """;

    public static void main(String[] args) throws Exception {
        McpJsonMapper jsonMapper = new JacksonMcpJsonMapperSupplier().get();
        if (Arrays.asList(args).contains("--stdio")) {
            runStdio(jsonMapper);
        } else {
            runHttp(jsonMapper);
        }
    }

    static void runStdio(McpJsonMapper jsonMapper) {
        buildServer(new StdioServerTransportProvider(jsonMapper));
        // Block until stdin closes (transport drives the lifecycle)
    }

    static void runHttp(McpJsonMapper jsonMapper) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "3001"));
        var transport = HttpServletSseServerTransportProvider.builder()
                .jsonMapper(jsonMapper)
                .messageEndpoint("/mcp/message")
                .build();

        buildServer(transport);

        var context = new ServletContextHandler();
        context.addServlet(new ServletHolder(transport), "/*");

        var server = new Server(port);
        server.setHandler(context);
        server.start();
        System.out.println("MCP server listening on http://localhost:" + port + "/sse");
        server.join();
    }

    static void buildServer(McpServerTransportProvider transport) {
        var tool = new McpServerFeatures.SyncToolSpecification(
                McpSchema.Tool.builder()
                        .name("get-time")
                        .description("Returns the current server time as an ISO 8601 string")
                        .inputSchema(new McpSchema.JsonSchema("object", null, null, null, null, null))
                        .meta(Map.of(
                                // New key (ui.resourceUri) + legacy flat key (ui/resourceUri) for compat
                                "ui", Map.of("resourceUri", RESOURCE_URI),
                                "ui/resourceUri", RESOURCE_URI
                        ))
                        .build(),
                (exchange, arguments) -> McpSchema.CallToolResult.builder()
                        .content(List.of(new McpSchema.TextContent(Instant.now().toString())))
                        .isError(false)
                        .build()
        );

        var resource = new McpServerFeatures.SyncResourceSpecification(
                McpSchema.Resource.builder()
                        .uri(RESOURCE_URI)
                        .name("Get Time UI")
                        .mimeType(RESOURCE_MIME_TYPE)
                        .build(),
                (exchange, request) -> new McpSchema.ReadResourceResult(List.of(
                        new McpSchema.TextResourceContents(RESOURCE_URI, RESOURCE_MIME_TYPE, UI_HTML)
                ))
        );

        McpServer.sync(transport)
                .serverInfo("basic-server-java", "1.0.0")
                .capabilities(McpSchema.ServerCapabilities.builder()
                        .tools(true)
                        .resources(false, false)
                        .build())
                .tools(tool)
                .resources(resource)
                .build();
    }
}
