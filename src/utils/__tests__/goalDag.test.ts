/**
 * Goal DAG engine tests — verifies topological operations, cycle detection,
 * and dynamic mutations for the task graph.
 */

import { describe, expect, test } from 'bun:test'
import { GoalDagEngine } from '../goalDag.js'

// Helper: create a test SubGoal node
function makeNode(id: string, text: string, deps: string[] = [], status: string = 'pending') {
  return {
    id,
    parentId: 'test' as any,
    text,
    status: status as any,
    dependencies: deps,
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ============================================================================
// Basic operations
// ============================================================================

describe('GoalDagEngine', () => {
  test('empty graph has no nodes', () => {
    const dag = new GoalDagEngine()
    expect(dag.getAllNodes()).toEqual([])
    expect(dag.topoSort()).toEqual([])
    expect(dag.hasCycles()).toBe(false)
  })

  test('single node returns itself', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'Task A'))
    expect(dag.getAllNodes()).toHaveLength(1)
    expect(dag.topoSort()).toEqual(['a'])
  })

  test('two-node linear dependency', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'Task A'))
    dag.addNode(makeNode('b', 'Task B', ['a']))
    // b depends on a → a should come first
    expect(dag.topoSort()).toEqual(['a', 'b'])
  })

  test('diamond dependency', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'Root'))
    dag.addNode(makeNode('b', 'Left', ['a']))
    dag.addNode(makeNode('c', 'Right', ['a']))
    dag.addNode(makeNode('d', 'End', ['b', 'c']))
    // d depends on both b and c → any valid order must end with d
    const sorted = dag.topoSort()
    expect(sorted).toHaveLength(4)
    expect(sorted[sorted.length - 1]).toBe('d')
  })
})

// ============================================================================
// Cycle detection
// ============================================================================

describe('Cycle detection', () => {
  test('acyclic graph reports no cycles', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'A'))
    dag.addNode(makeNode('b', 'B', ['a']))
    dag.addNode(makeNode('c', 'C', ['b']))
    expect(dag.hasCycles()).toBe(false)
    expect(dag.detectCycles()).toEqual([])
  })

  test('self-loop detected', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'A', ['a'])) // self-loop
    expect(dag.hasCycles()).toBe(true)
  })

  test('simple cycle a→b→a', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'A', ['b']))
    dag.addNode(makeNode('b', 'B', ['a']))
    expect(dag.hasCycles()).toBe(true)
    const cycles = dag.detectCycles()
    expect(cycles.length).toBeGreaterThan(0)
  })
})

// ============================================================================
// Ready nodes
// ============================================================================

describe('Ready nodes', () => {
  test('completed dependencies unlock pending nodes', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'A', [], 'completed'))
    dag.addNode(makeNode('b', 'B', ['a'], 'pending'))
    dag.addNode(makeNode('c', 'C', ['b'], 'pending'))
    // a is done, b should be ready (no other blockers)
    expect(dag.getReadyNodes()).toEqual(['b'])
  })

  test('blocked nodes are not ready', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'A', [], 'completed'))
    dag.addNode(makeNode('b', 'B', ['a'], 'blocked'))
    expect(dag.getReadyNodes()).toEqual([])
  })
})

// ============================================================================
// Dynamic mutations
// ============================================================================

describe('Dynamic mutations', () => {
  test('add node with after parameter', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'A'))
    dag.addNode(makeNode('b', 'B'), 'after_a') // non-existent dep ignored
    expect(dag.getAllNodes()).toHaveLength(2)
  })

  test('remove node removes edges', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'A'))
    dag.addNode(makeNode('b', 'B', ['a']))
    expect(dag.getLeafNodes()).toHaveLength(1) // b is leaf
    dag.removeNode('b')
    expect(dag.getAllNodes()).toHaveLength(1)
    expect(dag.getLeafNodes()).toHaveLength(1) // a is now leaf
  })

  test('merge nodes combines dependencies', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'Dep1'))
    dag.addNode(makeNode('b', 'Dep2'))
    const merged = dag.mergeNodes(['a', 'b'], 'Combined')
    expect(merged.text).toBe('Combined')
    // Merged should have no dependencies (original deps don't depend on each other)
    expect(merged.dependencies).toEqual([])
    // Original nodes removed
    expect(dag.getAllNodes().find(n => n.id === 'a')).toBeUndefined()
    expect(dag.getAllNodes().find(n => n.id === 'b')).toBeUndefined()
    // Merged node exists
    expect(dag.getAllNodes().find(n => n.id === merged.id)).toBeDefined()
  })

  test('update status changes ready set', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'A', [], 'pending'))
    dag.updateStatus('a', 'completed')
    const node = [...Object.entries(dag.toJSON().nodes)][0][1]
    expect(node.status).toBe('completed')
  })
})

// ============================================================================
// Serialization
// ============================================================================

describe('Serialization', () => {
  test('round-trip preserves state', () => {
    const dag = new GoalDagEngine()
    dag.addNode(makeNode('a', 'Task A'))
    dag.addNode(makeNode('b', 'Task B', ['a']))

    const json = dag.toJSON()
    const restored = GoalDagEngine.fromJSON(json)

    expect(restored.getAllNodes()).toHaveLength(2)
    expect(restored.topoSort()).toEqual(dag.topoSort())
  })
})
