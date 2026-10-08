export interface ServeOptions {
  port?: number
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const { DashboardServer } = await import("@multiclawcli/dashboard/server")
  const port = options.port ?? 3210
  const server = new DashboardServer({ port, acceptClientEvents: true })
  await server.start()
  console.log(`\x1b[36mDashboard running at: http://localhost:${port}\x1b[0m`)
  console.log(`  In another terminal run: multiclaw run "<requirement>" --server-url http://localhost:${port}`)
}
