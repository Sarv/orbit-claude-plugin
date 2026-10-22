// stdout carries the MCP protocol, so every log line goes to stderr. Never console.log.
export function log(level, message, fields) {
  const extra = fields ? ` ${JSON.stringify(fields)}` : '';
  process.stderr.write(`[orbit-mcp] ${level}: ${message}${extra}\n`);
}
