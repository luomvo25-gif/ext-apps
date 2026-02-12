package io.modelcontextprotocol.examples;

import io.modelcontextprotocol.json.McpJsonMapper;
import io.modelcontextprotocol.json.jackson.JacksonMcpJsonMapperSupplier;
import io.modelcontextprotocol.server.transport.HttpServletSseServerTransportProvider;
import io.modelcontextprotocol.server.transport.StdioServerTransportProvider;
import org.eclipse.jetty.ee10.servlet.ServletContextHandler;
import org.eclipse.jetty.ee10.servlet.ServletHolder;
import java.util.Arrays;

/**
 * Entry point for the basic-server-java MCP App example.
 *
 * Run with HTTP transport (default, port 3001):
 *   java -jar basic-server-java.jar
 *
 * Run with stdio transport:
 *   java -jar basic-server-java.jar --stdio
 */
public class Main {

    public static void main(String[] args) throws Exception {
        McpJsonMapper jsonMapper = new JacksonMcpJsonMapperSupplier().get();
        if (Arrays.asList(args).contains("--stdio")) {
            runStdio(jsonMapper);
        } else {
            runHttp(jsonMapper);
        }
    }

    static void runStdio(McpJsonMapper jsonMapper) {
        Server.createServer(new StdioServerTransportProvider(jsonMapper));
        // Block until stdin closes (transport drives the lifecycle)
    }

    static void runHttp(McpJsonMapper jsonMapper) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "3001"));
        var transport = HttpServletSseServerTransportProvider.builder()
                .jsonMapper(jsonMapper)
                .messageEndpoint("/mcp/message")
                .build();

        Server.createServer(transport);

        var context = new ServletContextHandler();
        context.addServlet(new ServletHolder(transport), "/*");

        var server = new org.eclipse.jetty.server.Server(port);
        server.setHandler(context);
        server.start();
        System.out.println("MCP server listening on http://localhost:" + port + "/sse");
        server.join();
    }
}
