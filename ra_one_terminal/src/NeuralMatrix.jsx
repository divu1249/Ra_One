import React, { useEffect } from 'react';
import ReactFlow, { Background, MarkerType, useNodesState, useEdgesState, Position } from 'reactflow';
import 'reactflow/dist/style.css';

// Aggressive, militaristic typography
const defaultNodeStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: '10px',
  letterSpacing: '0.1em',
  textAlign: 'center',
  padding: '10px',
  color: '#a1a1aa',
  background: '#050505',
  border: '1px solid #27272a',
  borderRadius: '2px',
  textTransform: 'uppercase'
};

const initialNodes = [
  { 
    id: 'io_terminal', 
    sourcePosition: Position.Right, targetPosition: Position.Left,
    position: { x: 50, y: 200 }, 
    data: { label: 'EXTERNAL\nI/O_UPLINK' }, 
    style: { ...defaultNodeStyle, width: 120 } 
  },
  { 
    id: 'hart_core', 
    sourcePosition: Position.Right, targetPosition: Position.Left,
    position: { x: 280, y: 155 }, 
    data: { label: 'H.A.R.T.\n[ NEURAL CORE ]' }, 
    // The H.A.R.T. is a circular, pulsing reactor
    style: { 
      ...defaultNodeStyle, 
      width: 140, 
      height: 140, 
      borderRadius: '50%', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      color: '#ff0000',
      background: 'radial-gradient(circle, rgba(69,10,10,1) 0%, rgba(0,0,0,1) 70%)',
      border: '2px solid #7f1d1d',
      fontWeight: 'bold',
      boxShadow: '0 0 20px rgba(220, 38, 38, 0.2)'
    } 
  },
  { 
    id: 'mem_supabase', 
    sourcePosition: Position.Right, targetPosition: Position.Left,
    position: { x: 550, y: 50 }, 
    data: { label: 'VECTOR_DB\n[ MEMORY ]' }, 
    style: { ...defaultNodeStyle, width: 140 } 
  },
  { 
    id: 'tool_sandbox', 
    sourcePosition: Position.Right, targetPosition: Position.Left,
    position: { x: 550, y: 200 }, 
    data: { label: 'PYTHON_EXEC\n[ SANDBOX ]' }, 
    style: { ...defaultNodeStyle, width: 140 } 
  },
  { 
    id: 'tool_harvester', 
    sourcePosition: Position.Right, targetPosition: Position.Left,
    position: { x: 550, y: 350 }, 
    data: { label: 'CLOUD_LINK\n[ 5TB_DRIVE ]' }, 
    style: { ...defaultNodeStyle, width: 140 } 
  },
];

const initialEdges = [
  { id: 'e-io-hart', source: 'io_terminal', target: 'hart_core', type: 'straight', animated: false, style: { stroke: '#27272a', strokeWidth: 1 } },
  { id: 'e-hart-mem', source: 'hart_core', target: 'mem_supabase', type: 'straight', animated: false, style: { stroke: '#27272a', strokeWidth: 1 } },
  { id: 'e-hart-sandbox', source: 'hart_core', target: 'tool_sandbox', type: 'straight', animated: false, style: { stroke: '#27272a', strokeWidth: 1 } },
  { id: 'e-hart-harvester', source: 'hart_core', target: 'tool_harvester', type: 'straight', animated: false, style: { stroke: '#27272a', strokeWidth: 1 } },
];

export default function NeuralMatrix({ systemState }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  useEffect(() => {
    setEdges((eds) =>
      eds.map((edge) => {
        let isActive = false;
        
        // Route energy through specific circuits
        if (systemState === 'thinking' && edge.id === 'e-io-hart') isActive = true;
        if (systemState === 'memory' && edge.id === 'e-hart-mem') isActive = true;
        if (systemState === 'sandbox' && edge.id === 'e-hart-sandbox') isActive = true;
        if (systemState === 'harvester' && edge.id === 'e-hart-harvester') isActive = true;

        const color = isActive ? '#dc2626' : '#27272a'; // Blood Red vs Dead Wire

        return {
          ...edge,
          animated: isActive,
          style: { stroke: color, strokeWidth: isActive ? 2 : 1, transition: 'stroke 0.3s ease' },
          markerEnd: { type: MarkerType.ArrowClosed, color: color },
        };
      })
    );

    setNodes((nds) => 
      nds.map((node) => {
        if (node.id === 'hart_core') {
          const isCoreActive = systemState !== 'idle';
          return {
            ...node,
            style: {
              ...node.style,
              boxShadow: isCoreActive ? '0 0 50px rgba(220, 38, 38, 0.8)' : '0 0 10px rgba(220, 38, 38, 0.1)',
              border: isCoreActive ? '2px solid #ff0000' : '2px solid #7f1d1d',
              background: isCoreActive ? 'radial-gradient(circle, rgba(153,27,27,1) 0%, rgba(0,0,0,1) 80%)' : 'radial-gradient(circle, rgba(69,10,10,1) 0%, rgba(0,0,0,1) 70%)',
            }
          };
        }
        // Highlight utility nodes when targeted
        const isTargeted = 
          (node.id === 'mem_supabase' && systemState === 'memory') ||
          (node.id === 'tool_sandbox' && systemState === 'sandbox') ||
          (node.id === 'tool_harvester' && systemState === 'harvester');

        if (node.id !== 'hart_core' && node.id !== 'io_terminal') {
           return {
             ...node,
             style: {
               ...node.style,
               border: isTargeted ? '1px solid #dc2626' : '1px solid #27272a',
               color: isTargeted ? '#ff0000' : '#a1a1aa'
             }
           }
        }
        return node;
      })
    );
  }, [systemState, setEdges, setNodes]);

  return (
    <div className="w-full h-full bg-black rounded-sm overflow-hidden border border-[#1a1a1a] relative">
      <div className="absolute top-4 left-4 z-10 text-[10px] text-red-900/80 tracking-[0.3em] font-mono">
        CONTAINMENT_GRID // TOPOLOGY
      </div>
      <ReactFlow 
        nodes={nodes} 
        edges={edges} 
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView 
        attributionPosition="bottom-left"
        theme="dark"
      >
        <Background color="#111" gap={30} size={2} />
      </ReactFlow>
    </div>
  );
}