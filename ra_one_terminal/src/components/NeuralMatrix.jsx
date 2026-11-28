import React, { useEffect } from 'react';
import ReactFlow, { Background, MarkerType, Position, useEdgesState, useNodesState } from 'reactflow';
import 'reactflow/dist/style.css';

const NODE_TYPES = {};
const EDGE_TYPES = {};
const FIT_VIEW_OPTIONS = { padding: 0.16 };
const PRO_OPTIONS = { hideAttribution: true };

const baseNodeStyle = {
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  fontSize: '11px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textAlign: 'center',
  padding: '10px 8px',
  color: '#7c8490',
  background: 'rgba(9, 10, 14, 0.88)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  borderRadius: '2px',
  width: 124,
};

const initialNodes = [
  {
    id: 'memory',
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    position: { x: 10, y: 36 },
    data: { label: 'MEMORY\nRecall' },
    style: { ...baseNodeStyle },
  },
  {
    id: 'actor',
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    position: { x: 175, y: 36 },
    data: { label: 'ACTOR\nPlan & Code' },
    style: { ...baseNodeStyle },
  },
  {
    id: 'sandbox',
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    position: { x: 340, y: 36 },
    data: { label: 'SANDBOX\nSubprocess' },
    style: { ...baseNodeStyle },
  },
  {
    id: 'critic',
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    position: { x: 505, y: 36 },
    data: { label: 'CRITIC\nAdversarial' },
    style: { ...baseNodeStyle },
  },
  {
    id: 'mutate',
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    position: { x: 340, y: 128 },
    data: { label: 'MUTATE\nShadow Diff' },
    style: { ...baseNodeStyle },
  },
  {
    id: 'verified',
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    position: { x: 670, y: 36 },
    data: { label: 'VERIFIED\nCommitted' },
    style: { ...baseNodeStyle },
  },
];

const initialEdges = [
  { id: 'e-memory-actor', source: 'memory', target: 'actor', type: 'smoothstep' },
  { id: 'e-actor-sandbox', source: 'actor', target: 'sandbox', type: 'smoothstep' },
  { id: 'e-actor-mutate', source: 'actor', target: 'mutate', type: 'smoothstep' },
  { id: 'e-sandbox-critic', source: 'sandbox', target: 'critic', type: 'smoothstep' },
  { id: 'e-mutate-critic', source: 'mutate', target: 'critic', type: 'smoothstep' },
  { id: 'e-critic-actor', source: 'critic', target: 'actor', type: 'smoothstep', label: 'self-heal retry' },
  { id: 'e-critic-verified', source: 'critic', target: 'verified', type: 'smoothstep' },
];

export default function NeuralMatrix({ stage, iteration, maxIterations, isRunning }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setNodes((nds) =>
      nds.map((node) => {
        const isActive = node.id === stage;
        const isVerified = node.id === 'verified' && stage === 'verified';
        const isError = node.id === 'critic' && stage === 'error';

        let border = '1px solid rgba(255, 255, 255, 0.14)';
        let color = '#7c8490';
        let background = 'rgba(9, 10, 14, 0.88)';
        let boxShadow = 'none';

        if (isVerified) {
          border = '1px solid #ff1e2d';
          color = '#ffffff';
          background = 'rgba(138, 8, 20, 0.42)';
          boxShadow = '0 0 18px rgba(255, 30, 45, 0.45)';
        } else if (isError) {
          border = '1px solid #ff2a38';
          color = '#ffe8ea';
          background = 'rgba(110, 8, 16, 0.65)';
          boxShadow = '0 0 18px rgba(255, 30, 45, 0.55)';
        } else if (isActive) {
          border = '1px solid #ff1e2d';
          color = '#ffffff';
          background = 'rgba(165, 10, 24, 0.36)';
          boxShadow = '0 0 18px rgba(255, 30, 45, 0.4)';
        }

        return {
          ...node,
          style: {
            ...node.style,
            border,
            color,
            background,
            boxShadow,
          },
        };
      })
    );

    setEdges((eds) =>
      eds.map((edge) => {
        let active = false;
        let stroke = 'rgba(255, 255, 255, 0.16)';

        if (stage === 'actor' && (edge.id === 'e-memory-actor' || (iteration > 1 && edge.id === 'e-critic-actor'))) {
          active = true;
          stroke = iteration > 1 && edge.id === 'e-critic-actor' ? '#ff6b35' : '#ff1e2d';
        } else if (stage === 'sandbox' && edge.id === 'e-actor-sandbox') {
          active = true;
          stroke = '#ff1e2d';
        } else if (stage === 'mutate' && (edge.id === 'e-actor-mutate' || edge.id === 'e-mutate-critic')) {
          active = true;
          stroke = '#ff1e2d';
        } else if (stage === 'critic' && (edge.id === 'e-sandbox-critic' || edge.id === 'e-critic-actor')) {
          active = true;
          stroke = '#ff6b35';
        } else if (stage === 'verified' && edge.id === 'e-critic-verified') {
          active = true;
          stroke = '#ff1e2d';
        }

        return {
          ...edge,
          animated: active,
          style: { stroke, strokeWidth: active ? 2 : 1 },
          labelStyle: { fill: '#7c8490', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' },
          labelBgStyle: { fill: '#06070a' },
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
        };
      })
    );
  }, [stage, iteration, setEdges, setNodes]);

  return (
    <section
      aria-label="Neural Matrix Cognition Topology"
      data-testid="neural-matrix"
      data-stage={stage}
      className="hud-chamfer hud-specular-top relative flex flex-col h-[270px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-b border-white/10">
        <h2 className="text-xs font-semibold tracking-[0.22em] uppercase text-[#e6eaf0]">
          LANGGRAPH COGNITION TOPOLOGY
        </h2>
        <div className="flex items-center gap-4 text-xs font-mono tabular-nums text-[#7c8490]">
          <span>
            STAGE: <strong className="text-[#ff2a38] uppercase">{stage}</strong>
          </span>
          <span>
            ITERATION: <strong className="text-[#e6eaf0]">{iteration}/{maxIterations}</strong>
          </span>
          <span>
            LOOP:{' '}
            <strong className={isRunning ? 'text-[#ff1e2d]' : 'text-[#7c8490]'}>
              {isRunning ? 'ACTIVE' : 'IDLE'}
            </strong>
          </span>
        </div>
      </div>

      <div className="flex-1 w-full min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          proOptions={PRO_OPTIONS}
        >
          <Background color="rgba(255, 30, 45, 0.14)" gap={24} size={1} />
        </ReactFlow>
      </div>
    </section>
  );
}
