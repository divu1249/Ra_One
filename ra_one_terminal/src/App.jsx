import React, { useState, useRef, useEffect } from 'react';
import { Terminal, Send, Database, Code, Cpu, Network } from 'lucide-react';
import NeuralMatrix from './NeuralMatrix';

export default function App() {
  const [input, setInput] = useState('');
  const [chatLog, setChatLog] = useState([]);
  const [systemState, setSystemState] = useState('idle');
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatLog]);

  const triggerCognitiveLoop = async () => {
    if (!input.trim()) return;
    
    setChatLog(prev => [...prev, { role: 'user', content: input }]);
    setSystemState('thinking');
    const currentInput = input;
    setInput('');

    try {
      const response = await fetch('http://localhost:8000/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: currentInput }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.replace('data: ', ''));
            
            if (data.content.includes('Retrieving context')) setSystemState('memory');
            else if (data.content.includes('[SANDBOX]')) setSystemState('sandbox');
            else if (data.content.includes('[INTERCEPT] Data Harvester') || data.content.includes('Cloud Extraction')) setSystemState('harvester');
            else if (data.content.includes('[SUCCESS]') || data.content.includes('Querying')) setSystemState('thinking');
            
            setChatLog(prev => [...prev, data]);
          }
        }
      }
      setSystemState('idle');
    } catch (error) {
      setChatLog(prev => [...prev, { type: 'error', content: 'CRITICAL FAILURE: H.A.R.T. LINK SEVERED.' }]);
      setSystemState('idle');
    }
  };

  return (
    <div className="h-screen w-full bg-black font-mono flex flex-col md:flex-row p-2 md:p-4 gap-4 selection:bg-red-900/50">
      
      {/* LEFT: Structural Visualizer */}
      <div className="hidden md:flex flex-col w-1/2 h-full gap-4">
        <div className="h-[75%] w-full">
          <NeuralMatrix systemState={systemState} />
        </div>
        
        {/* Module Status Panel */}
        <div className="h-[25%] bg-[#050505] border border-[#1a1a1a] rounded-sm p-6 flex flex-col justify-center gap-6">
          <h2 className="text-[10px] text-red-900/80 tracking-[0.3em] border-b border-[#1a1a1a] pb-2">SYSTEM SENSORS</h2>
          <div className="grid grid-cols-2 gap-6">
            <div className={`flex items-center gap-3 transition-colors ${systemState !== 'idle' ? 'text-white' : 'text-zinc-600'}`}>
              <Cpu size={16} className={systemState !== 'idle' ? 'text-red-600 animate-pulse' : 'text-zinc-800'} />
              <span className="text-xs tracking-widest uppercase">H.A.R.T. Core</span>
            </div>
            <div className={`flex items-center gap-3 transition-colors ${systemState === 'memory' ? 'text-white' : 'text-zinc-600'}`}>
              <Network size={16} className={systemState === 'memory' ? 'text-red-600 animate-pulse' : 'text-zinc-800'} />
              <span className="text-xs tracking-widest uppercase">Vector Mem</span>
            </div>
            <div className={`flex items-center gap-3 transition-colors ${systemState === 'sandbox' ? 'text-white' : 'text-zinc-600'}`}>
              <Code size={16} className={systemState === 'sandbox' ? 'text-red-600 animate-pulse' : 'text-zinc-800'} />
              <span className="text-xs tracking-widest uppercase">Exec_Env</span>
            </div>
            <div className={`flex items-center gap-3 transition-colors ${systemState === 'harvester' ? 'text-white' : 'text-zinc-600'}`}>
              <Database size={16} className={systemState === 'harvester' ? 'text-red-600 animate-pulse' : 'text-zinc-800'} />
              <span className="text-xs tracking-widest uppercase">Data_Link</span>
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT: Containment Grid IO */}
      <div className="flex flex-col w-full md:w-1/2 h-full bg-[#050505] border border-[#1a1a1a] rounded-sm p-5 relative overflow-hidden">
        
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.5)_50%)] bg-[length:100%_4px] z-10 opacity-30"></div>

        {/* Header */}
        <div className="flex items-center gap-3 border-b border-red-900/30 pb-4 mb-4 z-20">
          <Terminal size={18} className="text-red-600" />
          <h1 className="text-xs tracking-[0.3em] font-bold text-red-600">RA.ONE // TERMINAL</h1>
          <div className="ml-auto flex gap-2">
            <div className={`w-2 h-2 rounded-none ${systemState !== 'idle' ? 'bg-red-600 animate-pulse' : 'bg-zinc-800'}`}></div>
          </div>
        </div>
        
        {/* Terminal Log */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-2 z-20 custom-scrollbar pb-4">
          {chatLog.map((log, index) => (
            <div key={index} className={`rounded-sm text-[13px] leading-relaxed tracking-wide ${
              log.role === 'user' ? 'text-zinc-400 text-right ml-auto w-3/4' : 
              log.type === 'error' ? 'text-red-500 bg-red-950/20 border border-red-900/50 p-3 uppercase tracking-widest text-xs' :
              log.type === 'code' ? 'text-zinc-300 bg-[#0a0a0a] border border-[#222] font-mono whitespace-pre-wrap p-4 text-xs' :
              log.type === 'message' ? 'text-white bg-[#0a0a0a] border-l-2 border-red-600 pl-4 py-3 w-[95%] shadow-[0_0_15px_rgba(220,38,38,0.05)]' : 
              'text-red-700/80 text-[10px] font-mono tracking-[0.1em] uppercase' // Telemetry
            }`}>
              {log.content}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Input Field */}
        <div className="mt-4 flex gap-3 z-20">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && triggerCognitiveLoop()}
            className="flex-1 bg-[#0a0a0a] border border-[#222] text-white rounded-sm p-4 focus:outline-none focus:border-red-600 focus:ring-1 focus:ring-red-600/30 transition-all font-mono text-xs tracking-widest placeholder-zinc-700"
            placeholder="AWAITING DIRECTIVE..."
          />
          <button 
            onClick={triggerCognitiveLoop}
            className="bg-red-950/30 hover:bg-red-900/50 text-red-500 border border-red-900/50 px-8 rounded-sm transition-all flex items-center justify-center group"
          >
            <Send size={18} className="group-hover:scale-110 transition-transform" />
          </button>
        </div>
      </div>
    </div>
  );
}