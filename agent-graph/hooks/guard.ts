// Which agent types each running Local node may start with the Agent tool.
export type Guard = ReturnType<typeof createGuard>

export function createGuard() {
  const allowed = new Map<string, Set<string>>()
  const stopped = new Set<string>()

  return {
    allow(agentId: string, types: string[]) {
      allowed.set(agentId, new Set(types))
    },
    forget(agentId: string) {
      allowed.delete(agentId)
      stopped.delete(agentId)
    },
    // A stopped agent may not start anything more, until it ends and is forgotten.
    stop(agentId: string) {
      stopped.add(agentId)
    },
    // Undefined when the call may go ahead; otherwise why it may not.
    check(callerId: string | undefined, subagentType: string | undefined): string | undefined {
      if (callerId === undefined) return undefined
      if (stopped.has(callerId)) return 'This agent was stopped, so it cannot start other agents.'
      const types = allowed.get(callerId)
      if (types === undefined) return undefined
      if (subagentType !== undefined && types.has(subagentType)) return undefined
      return types.size > 0
        ? `This agent may only delegate to: ${[...types].join(', ')}.`
        : 'This agent has no delegates in its graph, so it cannot start other agents.'
    },
  }
}
